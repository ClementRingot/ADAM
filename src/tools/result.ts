/** MCP tool results, and the text an invalid input gets back. */

import type { z } from 'zod';

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
