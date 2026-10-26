#!/usr/bin/env node
/**
 * abap-debugger-mcp — the stdio entry point an MCP client starts.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createConnection, loadConfig } from './config.js';
import { logger } from './logger.js';
import { createMcpServer } from './server.js';
import { VERSION } from './version.js';

const USAGE = `abap-debugger-mcp ${VERSION} — MCP server (stdio) that captures one run of ABAP code in SAP's debugger.

Usage: abap-debugger-mcp [--env-file <path>]

Configuration (environment variables, e.g. the "env" block of the MCP client's server entry):
  SAP_URL                  SAP system URL, e.g. https://my-sap-host:44300
  SAP_CLIENT               client, e.g. 100 (default: the system's default client)
  SAP_LANGUAGE             logon language (default EN)
  SAP_USER, SAP_PASSWORD   Basic authentication
  SAP_COOKIE_FILE          Netscape cookie file (re-read when SAP rejects the session)
  SAP_COOKIE_STRING        inline cookies: name=value; name2=value2
  SAP_BTP_SERVICE_KEY_FILE BTP ABAP Environment service key (browser login); or SAP_BTP_SERVICE_KEY inline
  SAP_BTP_OAUTH_CALLBACK_PORT  port of the login callback (default: a free port)
  SAP_INSECURE             true = skip TLS certificate checks (test systems only)
  SAP_DISABLE_SAML         true = ask SAP not to redirect to SAML single sign-on
  SAP_ABAP_RELEASE         SAP_BASIS release (e.g. 758) for locating methods in classic code
  ABAP_DEBUGGER_LOG_LEVEL  debug | info | warn | error (stderr; default info)
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

  const { config, problems } = loadConfig(process.env);
  const connection = config ? createConnection(config) : undefined;
  if (config) {
    logger.info('Connecting to SAP', { url: config.url, client: config.client, auth: config.auth });
  } else {
    logger.warn(`Not configured; every tool call will say so:\n- ${problems.join('\n- ')}`);
  }

  const server = createMcpServer({ ...(connection ? { connection } : {}), problems });
  await server.connect(new StdioServerTransport());
  logger.info(`abap-debugger-mcp ${VERSION} ready (stdio)`);
}

main(process.argv.slice(2)).catch((err: unknown) => {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
