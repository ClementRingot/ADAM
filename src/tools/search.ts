/**
 * abap_search — find objects by name or pattern (the repository quick search), of any type the
 * repository knows, each labelled with what it is. A name without `*` is a prefix, exact names
 * first. The objects SAP generates around a published OData service (Gateway models and service
 * registrations, OAuth scopes, …) are left out unless asked for: on a service's name they would
 * crowd out the binding, the definition and the classes behind them.
 */

import { z } from 'zod';
import { type ObjectReference, searchObjects } from '../adt/repository.js';
import type { SapConnection } from './connection.js';
import { type ToolResult, textResult, toolJson } from './result.js';

/** What an object is, by its ADT type (slash type first, then main type), for the model. */
const KINDS: Record<string, string> = {
  'PROG/I': 'include',
  'FUGR/FF': 'function module',
  'FUGR/I': 'function group include',
  CLAS: 'class',
  INTF: 'interface',
  PROG: 'program',
  FUGR: 'function group',
  DDLS: 'CDS view',
  DCLS: 'CDS access control',
  DDLX: 'CDS metadata extension',
  BDEF: 'behavior definition',
  SRVD: 'service definition',
  SRVB: 'service binding',
  TABL: 'table or structure',
  DTEL: 'data element',
  DOMA: 'domain',
  TTYP: 'table type',
  MSAG: 'message class',
  DEVC: 'package',
  WAPA: 'BSP application (UI5 app)',
  TRAN: 'transaction',
  ENHO: 'enhancement implementation',
  ENHS: 'enhancement spot',
  XSLT: 'transformation',
  IWSV: 'Gateway service (SEGW)',
  IWPR: 'Gateway project (SEGW)',
};

/** Generated around a published OData service; on the service's name they crowd out what matters. */
const TECHNICAL_TYPES = new Set(['IWMO', 'IWOM', 'IWSG', 'IWVB', 'OA2S', 'SCO2', 'SIA6', 'STOB']);

/** SAP cuts its answer at maxResults before anything is left out here, so the search asks for more. */
const MAX_ASKED = 200;

export const SearchInputSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .max(100)
      .describe(
        'Object name or its start (ZUI_TRAVEL also finds ZUI_TRAVEL_O4), or a pattern with * anywhere (*TRAVEL*). Case-insensitive; exact names come first.',
      ),
    types: z
      .array(z.string().min(1).max(10))
      .max(10)
      .optional()
      .describe(
        'Only these types, e.g. ["SRVB", "SRVD"] for the service binding and definition behind a Fiori app, ["CLAS"], ["PROG"], ["DDLS", "BDEF"]. Slash types such as PROG/I (includes) work too. Default: every type.',
      ),
    package: z
      .string()
      .min(1)
      .max(30)
      .optional()
      .describe('Only objects of this package, or of the packages a pattern with * matches (ZTRAVEL*).'),
    includeTechnical: z
      .boolean()
      .optional()
      .describe(
        'Also list the objects SAP generates around an OData service (IWMO, IWSG, OA2S, SIA6, STOB, …), left out by default.',
      ),
    maxResults: z.coerce.number().int().min(1).max(100).optional().describe('At most this many results (default 30).'),
  })
  .strict();

export type SearchInput = z.infer<typeof SearchInputSchema>;

const mainType = (type: string): string => type.split('/', 1)[0] ?? type;

function kindOf(type: string): string | undefined {
  const upper = type.toUpperCase();
  return KINDS[upper] ?? KINDS[mainType(upper)];
}

/** A package name, or a pattern with `*`. */
function packageMatcher(pattern: string): (name: string) => boolean {
  const upper = pattern.trim().toUpperCase();
  if (!upper.includes('*')) return (name) => name.toUpperCase() === upper;
  const escaped = upper.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const regex = new RegExp(`^${escaped}$`);
  return (name) => regex.test(name.toUpperCase());
}

export async function handleSearch(conn: SapConnection, input: SearchInput): Promise<ToolResult> {
  const query = input.query.trim().toUpperCase();
  const pattern = query.includes('*') ? query : `${query}*`;
  const wanted = input.maxResults ?? 30;
  const asked = Math.min(MAX_ASKED, Math.max(wanted * 3, 50));
  const types = [...new Set((input.types ?? []).map((type) => type.trim().toUpperCase()).filter(Boolean))];
  const answers = await Promise.all(
    (types.length > 0 ? types : [undefined]).map((type) => searchObjects(conn.http, pattern, asked, type)),
  );
  // SAP had more than it answered.
  const cut = answers.some((answer) => answer.length >= asked);

  const asksFor = new Set(types.map(mainType));
  const inPackage = input.package ? packageMatcher(input.package) : undefined;
  const seen = new Set<string>();
  const found: ObjectReference[] = [];
  let technical = 0;
  for (const ref of answers.flat()) {
    const key = `${ref.type}:${ref.name}`.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (inPackage && !inPackage(ref.packageName)) continue;
    const main = mainType(ref.type.toUpperCase());
    if (!input.includeTechnical && TECHNICAL_TYPES.has(main) && !asksFor.has(main)) {
      technical += 1;
      continue;
    }
    found.push(ref);
  }
  const ordered = [
    ...found.filter((ref) => ref.name.toUpperCase() === query),
    ...found.filter((ref) => ref.name.toUpperCase() !== query),
  ];
  const shown = ordered.slice(0, wanted);
  const more = cut || ordered.length > shown.length;
  return textResult(
    toolJson({
      results: shown.map((ref) => {
        const kind = kindOf(ref.type);
        return {
          type: ref.type,
          ...(kind ? { kind } : {}),
          name: ref.name,
          ...(ref.packageName ? { package: ref.packageName } : {}),
          ...(ref.description ? { description: ref.description } : {}),
        };
      }),
      ...(more ? { more: 'More objects match: narrow with types or package, or raise maxResults.' } : {}),
      ...(technical > 0
        ? { technicalLeftOut: `${technical} generated service objects (includeTechnical: true lists them)` }
        : {}),
      ...(shown.length === 0
        ? {
            hint: `Nothing matches ${pattern}${types.length > 0 ? ` of type ${types.join(', ')}` : ''}${input.package ? ` in ${input.package.toUpperCase()}` : ''}. Try *${query.replace(/\*/g, '')}* to find the name anywhere, or fewer filters.`,
          }
        : {}),
    }),
  );
}
