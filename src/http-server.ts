/**
 * The MCP server over Streamable HTTP — how it runs on SAP BTP Cloud Foundry, or on any host. Each
 * request is served by a fresh MCP server bound to the calling user (stateless transport), behind
 * XSUAA OAuth (with dynamic client registration for MCP clients) and/or API keys, both from
 * @arc-mcp/xsuaa-auth. The tools need the `debug` scope.
 *
 * Interactive sessions live in this process, keyed by user: a deployment runs ONE instance.
 */

import type { Server as NodeHttpServer } from 'node:http';
import { type AuthInfo, loadXsuaaCredentials, resolveAppUrl, setupHttpAuth } from '@arc-mcp/xsuaa-auth';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type Request, type RequestHandler, type Response } from 'express';
import { BtpConnections, btpLogger, ownerOf, resolveBtpTarget } from './btp/connections.js';
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
  // Fails closed: without XSUAA or an API key, setupHttpAuth throws and the server does not start.
  const bearer = setupHttpAuth(
    app,
    {
      ...(config.apiKeys.length > 0
        ? {
            apiKeys: config.apiKeys.map((key, index) => ({
              key,
              scopes: [DEBUG_SCOPE],
              clientId: `api-key-${index + 1}`,
            })),
          }
        : {}),
      ...(xsuaa
        ? {
            xsuaa: {
              credentials: xsuaa,
              appUrl: config.publicUrl ?? resolveAppUrl(env, { port: config.port }),
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

  app.all('/mcp', bearer, async (req: Request, res: Response) => {
    const authInfo = (req as Request & { auth?: AuthInfo }).auth;
    const owner = ownerOf(authInfo);
    const connect = sap.connect;
    const server = createMcpServer({
      ...(connect ? { connect: () => connect(authInfo, owner) } : {}),
      owner,
      problems: sap.problems,
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
  });
  return app;
}

export function listen(app: express.Express, port: number, host: string): Promise<NodeHttpServer> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.once('error', reject);
  });
}

/**
 * How an HTTP server reaches SAP: through SAP_BTP_DESTINATION (each user as themselves, resolved
 * on the first call and again after a failure), or SAP_URL with one identity — which every MCP
 * user would then share, so only when ABAP_DEBUGGER_ALLOW_SHARED_USER says so.
 */
export function httpSap(http: HttpConfig, env: NodeJS.ProcessEnv = process.env): HttpSap {
  const { settings, problems } = loadConnectionSettings(env);
  if (problems.length > 0) return { problems };
  if (http.btpDestination) {
    const name = http.btpDestination;
    return {
      problems: [],
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
  return { problems: [], connect: async () => connection };
}
