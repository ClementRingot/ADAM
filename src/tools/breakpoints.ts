/**
 * abap_breakpoints — what the debugger holds or left behind for the caller's SAP user, and its
 * removal: the caller's capture or session on this server, the external breakpoints a capture could
 * not remove (src/tools/debug-leftovers.ts), and whether a debugger listener is registered for the
 * user on SAP. SAP has no request that lists every breakpoint of a user: Eclipse keeps its own.
 */

import { z } from 'zod';
import { createDebugIdentity, debuggerErrorText, findListenerConflict, stopListener } from '../adt/debugger.js';
import type { SapConnection, ToolContext } from './connection.js';
import { resolveDebugUser, UNKNOWN_USER_MESSAGE } from './debug-capture.js';
import { describeLeftover, leftoversOf, removeLeftovers } from './debug-leftovers.js';
import { entryOf, holderOf, ownerOf } from './debug-registry.js';
import { handleDebugSession } from './debug-session.js';
import { errorResult, type ToolResult, textResult, toolJson } from './result.js';

const NOTE =
  "SAP has no request that lists every breakpoint of a user: Eclipse's or VS Code's own are in their Breakpoints view. This lists what this server armed.";

/** Each answer is short: the requests carry their own bound. */
const REQUEST_BUDGET_MS = 20_000;

export const BreakpointsInputSchema = z
  .object({
    action: z
      .enum(['list', 'delete'])
      .describe(
        'list: your capture or interactive session on this server, the breakpoints a capture could not remove (its server process was killed, or SAP refused), and whether a debugger listens for your SAP user. delete: end your capture or session, and remove those leftovers.',
      ),
    listener: z
      .boolean()
      .optional()
      .describe(
        "delete: also remove the debugger listener registered for your SAP user — SAP removes it by user, so Eclipse's or VS Code's goes too if one debugs as you. A capture that crashed leaves its listener for up to two minutes, and every capture is refused meanwhile.",
      ),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.listener !== undefined && input.action !== 'delete') {
      ctx.addIssue({ code: 'custom', path: ['listener'], message: 'listener applies to action "delete" only.' });
    }
  });

export type BreakpointsInput = z.infer<typeof BreakpointsInputSchema>;

/** Who listens for `user` on SAP: a capture or session of this server, another debugger, or nobody. */
async function listenerOf(conn: SapConnection, user: string, owner: string): Promise<string> {
  const holder = holderOf(user);
  if (holder) {
    return holder.owner === owner
      ? `your ${holder.kind === 'capture' ? 'capture' : 'interactive session'} ${holder.id}, on this server`
      : 'a capture or session of another user of this server, debugging the same SAP user';
  }
  const conflict = await findListenerConflict(conn.http, createDebugIdentity(user), {
    deadline: Date.now() + REQUEST_BUDGET_MS,
  });
  return conflict ? `another debugger: ${conflict}` : 'none';
}

export async function handleBreakpoints(
  conn: SapConnection,
  input: BreakpointsInput,
  context: ToolContext = {},
): Promise<ToolResult> {
  const owner = ownerOf(context);
  const user = await resolveDebugUser(conn);
  if (!user) return errorResult(UNKNOWN_USER_MESSAGE);

  if (input.action === 'list') {
    const own = entryOf(owner);
    const leftovers = leftoversOf(conn.http, user);
    const listener = await listenerOf(conn, user, owner);
    const removable = leftovers.length > 0 || listener.startsWith('another debugger');
    return textResult(
      toolJson({
        user,
        ...(own ? { yours: own.describe() } : {}),
        leftovers: leftovers.map(describeLeftover),
        listener,
        note: NOTE,
        ...(removable
          ? {
              next: 'abap_breakpoints with action "delete" removes the leftovers; listener: true also removes the listener.',
            }
          : {}),
      }),
    );
  }

  const out: Record<string, unknown> = { user };
  const own = entryOf(owner);
  if (own?.active) {
    const ended = await handleDebugSession(conn, { action: 'end' }, context);
    const text = ended.content[0]?.text ?? '';
    try {
      out.ended = JSON.parse(text);
    } catch {
      out.ended = text;
    }
  }
  const { removed, failed } = await removeLeftovers(conn.http, leftoversOf(conn.http, user), {
    deadline: Date.now() + REQUEST_BUDGET_MS,
  });
  out.leftoversRemoved = removed.length;
  if (failed.length > 0)
    out.leftoversFailed = failed.map(({ record, error }) => ({ ...describeLeftover(record), error }));
  if (input.listener) {
    const holder = holderOf(user);
    if (holder) {
      out.listener = `kept: ${holder.owner === owner ? `your ${holder.kind} ${holder.id} still ends` : 'a capture or session of another user of this server debugs the same SAP user'} — removing its listener would break it`;
    } else {
      try {
        const before = await findListenerConflict(conn.http, createDebugIdentity(user), {
          deadline: Date.now() + REQUEST_BUDGET_MS,
        });
        if (before) {
          await stopListener(conn.http, user, { deadline: Date.now() + REQUEST_BUDGET_MS });
          out.listener = `removed (it was: ${before})`;
        } else {
          out.listener = 'none was registered';
        }
      } catch (err) {
        out.listener = `not removed: ${debuggerErrorText(err)}`;
      }
    }
  }
  return textResult(toolJson(out));
}
