/**
 * The MCP server over Streamable HTTP — how it runs on SAP BTP Cloud Foundry, or on any host. Each
 * request is served by a fresh MCP server bound to the calling user (stateless transport), behind
 * XSUAA OAuth (with dynamic client registration for MCP clients) and/or API keys, both from
 * @arc-mcp/xsuaa-auth. The tools need the `debug` scope.
 *
 * A deployment serves one SAP system at /mcp, or several (SAP_BTP_DESTINATIONS) at
 * /<SID>/<client>/mcp each, with their own OAuth protected-resource metadata (RFC 9728).
 *
 * Interactive sessions live in this process, keyed by user and system: a deployment runs ONE instance.
 */

import type { Server as NodeHttpServer } from 'node:http';
import {
  type AuthInfo,
  createChainedTokenVerifier,
  createXsuaaTokenVerifier,
  loadXsuaaCredentials,
  resolveAppUrl,
  setupHttpAuth,
} from '@arc-mcp/xsuaa-auth';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { BtpConnections, btpLogger, ownerOf, resolveBtpTarget } from './btp/connections.js';
import { BtpSystems, isSystemRoute, routePath } from './btp/systems.js';
import { createConnection, type HttpConfig, loadConfig, loadConnectionSettings } from './config.js';
import { logger } from './logger.js';
import { createMcpServer } from './server.js';
import type { SapConnection } from './tools/connection.js';
import { VERSION } from './version.js';

/** The scope every tool call needs (`$XSAPPNAME.debug` in xs-security.json). */
export const DEBUG_SCOPE = 'debug';

/** How the server reaches SAP for a caller. */
export interface HttpSap {
  /** The calling user's SAP connection; unset when the server is not configured. */
  connect?: (authInfo: AuthInfo | undefined, owner: string) => Promise<SapConnection>;
  /** What is wrong with the configuration, reported by every tool call. */
  problems: string[];
  /** Whether users run code from SAP GUI there; undefined: known only once a destination is resolved. */
  sapGui?: boolean;
  /** Several systems (SAP_BTP_DESTINATIONS), one route each; /mcp then only points to them. */
  systems?: HttpSystems;
}

/** One destination of a deployment that serves several systems. */
export interface SystemOverview {
  destination: string;
  /** `/S4D/100/mcp`, once the destination named its system. */
  route?: string;
  /** Why it serves nobody; unset: it serves. */
  problem?: string;
}

/** The systems a deployment serves, one MCP route each. */
export interface HttpSystems {
  /** What /<sid>/<client>/mcp serves; undefined: no destination names that system and client. */
  route(sid: string, client: string): Promise<HttpSap | undefined>;
  /** Every destination, its route, and why it does not serve. */
  overview(): Promise<SystemOverview[]>;
}

/** Over HTTP, configuration problems are the deployment administrator's to fix. */
const HTTP_FIX =
  "The administrator of this deployment fixes them in its environment (mta.yaml, cf set-env) or its BTP destinations; ask them, or use another of this deployment's routes.";

/** The connector URLs of a deployment that serves several systems, for the model and the person. */
export function describeSystems(systems: SystemOverview[], appUrl: string): string[] {
  return systems.map((system) =>
    system.route
      ? `${appUrl}${system.route} — destination ${system.destination}${system.problem ? `, not serving: ${system.problem}` : ''}`
      : `destination ${system.destination}, no route: ${system.problem ?? 'not looked up yet'}`,
  );
}

/** A connection source that retries a failed setup on the next call (the Destination Service may be down at startup). */
export function lazyConnections(
  open: () => Promise<Pick<BtpConnections, 'connect'>>,
): (authInfo: AuthInfo | undefined, owner: string) => Promise<SapConnection> {
  let opened: Promise<Pick<BtpConnections, 'connect'>> | undefined;
  return async (authInfo, owner) => {
    opened ??= open().catch((err: unknown) => {
      opened = undefined;
      throw err;
    });
    return (await opened).connect(authInfo, owner);
  };
}

/** The bound XSUAA service, if the app has one; a broken binding is an error, not a fallback. */
function boundXsuaa(env: NodeJS.ProcessEnv) {
  if (!env.VCAP_SERVICES || !/"xsuaa"/.test(env.VCAP_SERVICES)) return undefined;
  return loadXsuaaCredentials(env);
}

export function createHttpApp(
  config: Pick<HttpConfig, 'port' | 'publicUrl' | 'apiKeys' | 'allowedOrigins' | 'dcrSigningSecret'>,
  sap: HttpSap,
  env: NodeJS.ProcessEnv = process.env,
): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', name: 'abap-debugger-mcp', version: VERSION });
  });

  const xsuaa = boundXsuaa(env);
  const appUrl = (config.publicUrl ?? resolveAppUrl(env, { port: config.port })).replace(/\/+$/, '');
  const apiKeys = config.apiKeys.map((key, index) => ({
    key,
    scopes: [DEBUG_SCOPE],
    clientId: `api-key-${index + 1}`,
  }));
  // Fails closed: without XSUAA or an API key, setupHttpAuth throws and the server does not start.
  const bearer = setupHttpAuth(
    app,
    {
      ...(apiKeys.length > 0 ? { apiKeys } : {}),
      ...(xsuaa
        ? {
            xsuaa: {
              credentials: xsuaa,
              appUrl,
              clientIdPrefix: 'abapdbg-',
              dcrKdfLabel: 'abapdbg-dcr/v1',
              stateKdfLabel: 'abapdbg-oauth-state/v1',
              resourceName: 'ABAP Debugger',
              scopesSupported: [DEBUG_SCOPE],
              requiredScopes: [DEBUG_SCOPE],
              // Never expire registrations: some MCP clients do not register again on invalid_client.
              dcrTtlSeconds: 0,
              ...(config.dcrSigningSecret ? { dcrSigningSecret: config.dcrSigningSecret } : {}),
            },
          }
        : {}),
      ...(config.allowedOrigins.length > 0 ? { allowedOrigins: config.allowedOrigins } : {}),
      required: true,
    },
    btpLogger,
  ) as RequestHandler;

  /** One MCP request, served by a fresh server bound to the calling user and to `target`'s system. */
  const serve = async (req: Request, res: Response, target: HttpSap, refusal?: string) => {
    const authInfo = (req as Request & { auth?: AuthInfo }).auth;
    const owner = ownerOf(authInfo);
    const connect = target.connect;
    const server = createMcpServer({
      ...(connect ? { connect: () => connect(authInfo, owner) } : {}),
      owner,
      problems: target.problems,
      fix: HTTP_FIX,
      ...(refusal ? { refusal } : {}),
      ...(target.sapGui !== undefined ? { sapGui: target.sapGui } : {}),
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      // express.json() consumed the stream: hand the parsed body over.
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error('MCP request failed', { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    }
  };

  const systems = sap.systems;
  if (!systems) {
    app.all('/mcp', bearer, (req: Request, res: Response) => serve(req, res, sap));
    return app;
  }

  // Several systems: /mcp names their routes, one connector each.
  app.all('/mcp', bearer, async (req: Request, res: Response) => {
    const lines = describeSystems(await systems.overview(), appUrl);
    const refusal = `This deployment serves several SAP systems, one MCP route each: add the one to debug as its own connector (the tools then reach that system only).\n- ${lines.join('\n- ')}`;
    await serve(req, res, { problems: [] }, refusal);
  });

  // Each route checks the bearer with its own metadata URL: MCP clients expect the resource they
  // connect to (RFC 9728), and /mcp's metadata names /mcp.
  const verifier = {
    verifyAccessToken: createChainedTokenVerifier(
      apiKeys.length > 0 ? { apiKeys } : {},
      xsuaa ? createXsuaaTokenVerifier(xsuaa, { acceptedScopes: [DEBUG_SCOPE], logger: btpLogger }) : undefined,
      undefined,
      { logger: btpLogger },
    ),
  };
  const routeBearers = new Map<string, RequestHandler>();
  const routeBearer = (path: string): RequestHandler => {
    let handler = routeBearers.get(path);
    if (!handler) {
      handler = requireBearerAuth({
        verifier,
        ...(xsuaa
          ? {
              requiredScopes: [DEBUG_SCOPE],
              resourceMetadataUrl: `${appUrl}/.well-known/oauth-protected-resource${path}`,
            }
          : {}),
      });
      routeBearers.set(path, handler);
    }
    return handler;
  };
  /** The route's system, or a pass to the next route: these segments name no system. */
  const systemRoute = (req: Request, _res: Response, next: NextFunction) => {
    const { sid, client } = req.params as { sid: string; client: string };
    if (!isSystemRoute(sid, client)) {
      next('route');
      return;
    }
    next();
  };
  const pathOf = (req: Request): string => {
    const { sid, client } = req.params as { sid: string; client: string };
    return routePath(sid.toUpperCase(), client);
  };

  if (xsuaa) {
    app.get('/.well-known/oauth-protected-resource/:sid/:client/mcp', systemRoute, async (req, res) => {
      const { sid, client } = req.params as { sid: string; client: string };
      if (!(await systems.route(sid, client))) {
        res.status(404).json({ error: `No SAP system ${sid.toUpperCase()} client ${client} on this deployment.` });
        return;
      }
      res.json({
        resource: `${appUrl}${pathOf(req)}`,
        authorization_servers: [new URL(appUrl).href],
        scopes_supported: [DEBUG_SCOPE],
        resource_name: `ABAP Debugger — ${sid.toUpperCase()}/${client}`,
      });
    });
  }

  app.all(
    '/:sid/:client/mcp',
    systemRoute,
    (req: Request, res: Response, next: NextFunction) => routeBearer(pathOf(req))(req, res, next),
    async (req: Request, res: Response) => {
      const { sid, client } = req.params as { sid: string; client: string };
      const target = await systems.route(sid, client);
      if (!target) {
        res.status(404).json({
          error: `No SAP system ${sid.toUpperCase()} client ${client} on this deployment.`,
          systems: describeSystems(await systems.overview(), appUrl),
        });
        return;
      }
      await serve(req, res, target);
    },
  );
  return app;
}

export function listen(app: express.Express, port: number, host: string): Promise<NodeHttpServer> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.once('error', reject);
  });
}

/**
 * How an HTTP server reaches SAP: through SAP_BTP_DESTINATIONS (several systems, one route each),
 * SAP_BTP_DESTINATION (each user as themselves, resolved on the first call and again after a
 * failure), or SAP_URL with one identity — which every MCP
 * user would then share, so only when ABAP_DEBUGGER_ALLOW_SHARED_USER says so.
 */
export function httpSap(http: HttpConfig, env: NodeJS.ProcessEnv = process.env): HttpSap {
  const { settings, problems } = loadConnectionSettings(env);
  if (problems.length > 0) return { problems };
  if (http.btpDestinations.length > 0) {
    return { problems: [], systems: new BtpSystems(http.btpDestinations, settings, env) };
  }
  if (http.btpDestination) {
    const name = http.btpDestination;
    return {
      problems: [],
      ...(settings.sapGui !== undefined ? { sapGui: settings.sapGui } : {}),
      connect: lazyConnections(
        async () =>
          new BtpConnections(await resolveBtpTarget(name, { allowSharedUser: http.allowSharedUser }, env), settings),
      ),
    };
  }
  const loaded = loadConfig(env);
  if (!loaded.config) return { problems: loaded.problems };
  if (loaded.config.auth === 'btp') {
    return {
      problems: [
        'SAP_BTP_SERVICE_KEY logs on through a browser on this machine, which a server has not: use SAP_BTP_DESTINATION (OAuth2UserTokenExchange to the BTP ABAP Environment) instead.',
      ],
    };
  }
  if (!http.allowSharedUser) {
    return {
      problems: [
        `Over HTTP every MCP user would debug as SAP user ${loaded.config.username ?? '(the cookies’ user)'} and could catch each other's runs: use SAP_BTP_DESTINATION with principal propagation, or set ABAP_DEBUGGER_ALLOW_SHARED_USER=true for a deployment a single person uses.`,
      ],
    };
  }
  const connection = createConnection(loaded.config);
  return { problems: [], sapGui: loaded.config.sapGui, connect: async () => connection };
}
