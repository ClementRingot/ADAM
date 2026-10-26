/**
 * Logging goes to stderr only: stdout carries the MCP JSON-RPC stream, and one stray line there
 * breaks the client's connection. Level from ABAP_DEBUGGER_LOG_LEVEL (debug, info, warn, error).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function enabled(level: LogLevel): boolean {
  const configured = (process.env.ABAP_DEBUGGER_LOG_LEVEL ?? 'info').trim().toLowerCase() as LogLevel;
  return ORDER[level] >= (ORDER[configured] ?? ORDER.info);
}

function write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  if (!enabled(level)) return;
  const details = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : '';
  process.stderr.write(`[abap-debugger] ${level.toUpperCase()} ${message}${details}\n`);
}

export const logger = {
  debug: (message: string, fields?: Record<string, unknown>) => write('debug', message, fields),
  info: (message: string, fields?: Record<string, unknown>) => write('info', message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => write('warn', message, fields),
  error: (message: string, fields?: Record<string, unknown>) => write('error', message, fields),
};
