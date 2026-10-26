/** MCP tool results, and the text an invalid input gets back. */

import type { z } from 'zod';
import { parseDebuggerException } from '../adt/debugger.js';
import { AdtApiError, AdtNetworkError } from '../adt/errors.js';

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

export function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** Results are compact JSON: the model reads it as well as an indented one, for fewer tokens. */
export function toolJson(value: unknown): string {
  return JSON.stringify(value);
}

/** One line per problem, each with the parameter it concerns. */
export function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'input'}: ${issue.message}`)
    .join('\n');
}

/** An error as the model reads it: SAP's own words, with what to check. */
export function describeError(err: unknown): string {
  if (err instanceof AdtApiError) {
    const exception = parseDebuggerException(err.responseBody);
    const sap = exception?.conflictText ?? exception?.message ?? err.sapMessage;
    const hint =
      err.statusCode === 401
        ? ' Check the credentials: SAP_USER/SAP_PASSWORD, the cookies, or the BTP login.'
        : err.statusCode === 403
          ? ' The SAP user lacks an authorization for this; debugging needs S_DEVELOP with OBJTYPE DEBUG, ACTVT 03.'
          : '';
    return `SAP refused the request (HTTP ${err.statusCode} at ${err.path.split('?', 1)[0]}): ${sap}${hint}`;
  }
  if (err instanceof AdtNetworkError) {
    return `${err.message.replace(/\.?$/, '.')} Check SAP_URL and the network path to the SAP system (SAP_PROXY behind a corporate proxy).`;
  }
  return err instanceof Error ? err.message : String(err);
}
