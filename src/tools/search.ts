/** abap_search — find an object's exact name and type (the repository quick search). */

import { z } from 'zod';
import { searchObjects } from '../adt/repository.js';
import type { SapConnection } from './debug-capture.js';
import { type ToolResult, textResult, toolJson } from './result.js';

export const SearchInputSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .max(100)
      .describe('Object name, or a pattern with * (ZCL_ORDER*, *TRAVEL*). Case-insensitive.'),
    objectType: z
      .string()
      .max(10)
      .optional()
      .describe('Only this ADT type, e.g. CLAS, PROG, FUGR, INTF, DDLS, BDEF (slash types such as PROG/P work too).'),
    maxResults: z.coerce.number().int().min(1).max(100).optional().describe('At most this many results (default 30).'),
  })
  .strict();

export type SearchInput = z.infer<typeof SearchInputSchema>;

export async function handleSearch(conn: SapConnection, input: SearchInput): Promise<ToolResult> {
  const results = await searchObjects(
    conn.http,
    input.query.trim().toUpperCase(),
    input.maxResults ?? 30,
    input.objectType?.trim().toUpperCase() || undefined,
  );
  return textResult(
    toolJson(
      results.map((ref) => ({
        type: ref.type,
        name: ref.name,
        ...(ref.packageName ? { package: ref.packageName } : {}),
        ...(ref.description ? { description: ref.description } : {}),
      })),
    ),
  );
}
