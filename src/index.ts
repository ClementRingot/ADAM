#!/usr/bin/env node
/**
 * abap-debugger-mcp — the entry point: stdio, started by the MCP client, or Streamable HTTP (--http).
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createConnection, loadConfig, loadHttpConfig } from './config.js';
import { createHttpApp, httpSap, listen } from './http-server.js';
import { logger } from './logger.js';
import { createMcpServer } from './server.js';
import { stopAllDebugging } from './tools/debug-registry.js';
import { VERSION } from './version.js';

const USAGE = `abap-debugger-mcp ${VERSION} — MCP server that lets an AI assistant debug ABAP code in SAP's debugger.

Usage: abap-debugger-mcp [--env-file <path>] [--http]

Over stdio (default) the MCP client starts the server; with --http (or ABAP_DEBUGGER_TRANSPORT=http)
it serves Streamable HTTP at /mcp — on SAP BTP Cloud Foundry, or any host.

Configuration (environment variables, e.g. the "env" block of the MCP client's server entry):
  SAP_URL                  SAP system URL, e.g. https://my-sap-host:44300
  SAP_CLIENT               client, e.g. 100 (default: the system's default client)
  SAP_LANGUAGE             logon language (default EN)
  SAP_USER, SAP_PASSWORD   Basic authentication
  SAP_COOKIE_FILE          Netscape cookie file (re-read when SAP rejects the session)
  SAP_COOKIE_STRING        inline cookies: name=value; name2=value2
  SAP_BTP_SERVICE_KEY_FILE BTP ABAP Environment service key (browser login); or SAP_BTP_SERVICE_KEY inline
  SAP_BTP_OAUTH_CALLBACK_PORT  port of the login callback (default: a free port)
  SAP_PROXY                corporate proxy for SAP and the BTP login, e.g. http://proxy.example:8080
  SAP_INSECURE             true = skip TLS certificate checks (test systems only)
  SAP_DISABLE_SAML         true = ask SAP not to redirect to SAML single sign-on
  SAP_ABAP_RELEASE         SAP_BASIS release (e.g. 758) for locating methods in classic code
  ABAP_DEBUGGER_MAX_SECONDS    ceiling of a call's inspection time (default 600)
  ABAP_DEBUGGER_MAX_RESULT_KB  ceiling of a call's result size (default 200)
  ABAP_DEBUGGER_IDLE_SECONDS   interactive session: released after this long without a call (default 120)
  ABAP_DEBUGGER_SESSION_SECONDS  interactive session: released after this long in all (default 900)
  ABAP_DEBUGGER_CALL_SECONDS   a tool call answers within this time; longer work goes on in the background (default 50)
  ABAP_DEBUGGER_MAX_CAPTURES   one-shot captures running at once on this server (default 4)
  ABAP_DEBUGGER_MAX_SESSIONS   interactive sessions open at once on this server (default 4)
  ABAP_DEBUGGER_STATE_DIR  where captures record their armed breakpoints until removed (default: the temp directory)
  ABAP_DEBUGGER_LOG_LEVEL  debug | info | warn | error (stderr; default info)

Over HTTP:
  SAP_BTP_DESTINATION      BTP destination of the SAP system (each user as themselves: principal propagation)
  ABAP_DEBUGGER_API_KEYS   comma-separated API keys (20+ characters each), besides XSUAA OAuth when bound
  ABAP_DEBUGGER_PORT       port (default 8080; PORT on Cloud Foundry), ABAP_DEBUGGER_HOST bind address
  ABAP_DEBUGGER_PUBLIC_URL public URL behind a reverse proxy (default: the Cloud Foundry route)
  ABAP_DEBUGGER_ALLOWED_ORIGINS  CORS origins of browser MCP clients
  ABAP_DEBUGGER_DCR_SIGNING_SECRET  32+ characters: keeps MCP client registrations valid across deployments
  ABAP_DEBUGGER_ALLOW_SHARED_USER   true = every MCP user debugs as the one SAP user (SAP_URL, Basic destination)
`;

async function main(argv: string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }
  if (argv.includes('--version')) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const envFileIndex = argv.indexOf('--env-file');
  if (envFileIndex >= 0) {
    const envFile = argv[envFileIndex + 1];
    if (!envFile) throw new Error('--env-file needs a path.');
    process.loadEnvFile(envFile);
  }

  if (argv.includes('--http') || (process.env.ABAP_DEBUGGER_TRANSPORT ?? '').toLowerCase() === 'http') {
    await serveHttp();
    return;
  }

  const { config, problems } = loadConfig(process.env);
  const connection = config ? createConnection(config) : undefined;
  if (config) {
    logger.info('Connecting to SAP', {
      url: config.url,
      client: config.client,
      auth: config.auth,
      // The proxy's host only: its URL may carry credentials.
      ...(config.proxy ? { proxy: new URL(config.proxy).host } : {}),
    });
  } else {
    logger.warn(`Not configured; every tool call will say so:\n- ${problems.join('\n- ')}`);
  }

  const server = createMcpServer({ ...(connection ? { connection } : {}), problems });
  await server.connect(new StdioServerTransport());
  logger.info(`abap-debugger-mcp ${VERSION} ready (stdio)`);

  // A capture or an interactive session holds a program on SAP: release it before the process goes away.
  let stopping = false;
  const stop = (reason: string) => {
    if (stopping) return;
    stopping = true;
    void stopAllDebugging(reason).finally(() => process.exit(0));
  };
  process.on('SIGINT', () => stop('the server was interrupted'));
  process.on('SIGTERM', () => stop('the server was stopped'));
  process.stdin.on('end', () => stop('the MCP client disconnected'));
  process.stdin.on('close', () => stop('the MCP client disconnected'));
}

/** Streamable HTTP at /mcp: SAP BTP Cloud Foundry (XSUAA, Destination Service) or any host (API keys). */
async function serveHttp(): Promise<void> {
  const { http, problems } = loadHttpConfig(process.env);
  if (!http) throw new Error(`Cannot serve over HTTP:\n- ${problems.join('\n- ')}`);
  const sap = httpSap(http, process.env);
  if (sap.problems.length > 0)
    logger.warn(`Not configured; every tool call will say so:\n- ${sap.problems.join('\n- ')}`);
  const server = await listen(createHttpApp(http, sap), http.port, http.host);
  logger.info(`abap-debugger-mcp ${VERSION} ready (HTTP)`, {
    address: `${http.host}:${http.port}`,
    ...(http.btpDestination ? { destination: http.btpDestination } : {}),
  });
  // Cloud Foundry stops an app with SIGTERM and kills it ten seconds later: release the programs first.
  let stopping = false;
  const stop = (reason: string) => {
    if (stopping) return;
    stopping = true;
    void stopAllDebugging(reason, 8000).finally(() => {
      server.close();
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => stop('the server was stopped'));
  process.on('SIGINT', () => stop('the server was interrupted'));
}

main(process.argv.slice(2)).catch((err: unknown) => {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
