/** rearmFrom: the same breakpoints armed again from another application server's session. */
import { describe, expect, it, vi } from 'vitest';
import { createDebugIdentity } from '../../../src/adt/debugger.js';
import type { AdtHttpClient } from '../../../src/adt/http.js';
import { type ArmedBreakpoints, rearmFrom } from '../../../src/tools/debug-arm.js';

const MAIN = '/sap/bc/adt/oo/classes/zcl_order/source/main';

describe('rearmFrom', () => {
  it('sends the armed set again, keeps a renumbered id as an alias, and names what SAP did not keep', async () => {
    const post = vi.fn().mockResolvedValue({
      statusCode: 200,
      headers: {},
      body:
        '<dbg:breakpoints xmlns:dbg="http://www.sap.com/adt/debugger" xmlns:adtcore="http://www.sap.com/adt/core">' +
        `<breakpoint kind="line" clientId="dbg-0-line-9" id="BP-NEW" adtcore:uri="${MAIN}#start=9"/>` +
        '<breakpoint kind="line" clientId="dbg-1-line-20" errorMessage="Cannot create a breakpoint at this position"/>' +
        '</dbg:breakpoints>',
    });
    const session = { post } as unknown as AdtHttpClient;
    const armed: ArmedBreakpoints = {
      ids: ['BP-OLD', 'BP-20'],
      armed: [
        { id: 'BP-OLD', clientId: 'dbg-0-line-9', label: 'line 9', kind: 'line', maxHits: 1, reportIndex: 0 },
        { id: 'BP-20', clientId: 'dbg-1-line-20', label: 'line 20', kind: 'line', maxHits: 1, reportIndex: 1 },
      ],
      report: [],
      inRun: [],
      specs: [
        { kind: 'line', clientId: 'dbg-0-line-9', uri: MAIN, line: 9 },
        { kind: 'line', clientId: 'dbg-1-line-20', uri: MAIN, line: 20, condition: 'lv_pass = 2' },
      ],
    };
    const armedIds = [...armed.ids];

    const lost = await rearmFrom(session, createDebugIdentity('admin'), armed, armedIds);

    // One full sync of the armed set, conditions included, from that session.
    expect(post).toHaveBeenCalledTimes(1);
    const body = String(post.mock.calls[0]?.[1]);
    expect(body).toContain('<syncScope mode="full">');
    expect(body).toContain('clientId="dbg-0-line-9"');
    expect(body).toContain('condition="lv_pass = 2"');
    // SAP renumbered the first: a stop may still name its old id.
    expect(armed.armed[0]).toMatchObject({ id: 'BP-NEW', aliases: ['BP-OLD'] });
    expect(lost).toEqual(['line 20']);
    // The cleanup list holds what is armed now; the removal goes through that session.
    expect(armedIds).toEqual(['BP-NEW']);
    expect(armed.ids).toEqual(['BP-NEW']);
    expect(armed.armedFrom).toBe(session);
  });
});
