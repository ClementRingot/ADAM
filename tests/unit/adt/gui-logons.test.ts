/**
 * The user's SAP GUI logons (src/adt/gui-logons.ts): table USR41 through the ADT data preview.
 *
 * LIVE: the answers below were recorded on S/4HANA (SAP_BASIS 816) — user and server names anonymized.
 */
import { describe, expect, it, vi } from 'vitest';
import { AdtApiError } from '../../../src/adt/errors.js';
import { DATA_PREVIEW_FREESTYLE_PATH, parseDataPreview, readGuiLogons } from '../../../src/adt/gui-logons.js';
import type { AdtHttpClient } from '../../../src/adt/http.js';

const metadata = (name: string, type: string) =>
  `<dataPreview:metadata dataPreview:name="${name}" dataPreview:type="${type}" dataPreview:description="${name}" dataPreview:keyAttribute="false" dataPreview:colType="" dataPreview:isKeyFigure="false"/>`;
const head = (rows: number, user: string) =>
  `<?xml version="1.0" encoding="utf-8"?><dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview"><dataPreview:totalRows>${rows}</dataPreview:totalRows><dataPreview:isHanaAnalyticalView>false</dataPreview:isHanaAnalyticalView><dataPreview:executedQueryString>SELECT SERVER, LOGON_DATE, LOGON_TIME FROM USR41 WHERE BNAME = '${user}'   INTO     TABLE @DATA(LT_RESULT)   UP TO 100  ROWS   .</dataPreview:executedQueryString><dataPreview:queryExecutionTime>1.9090000</dataPreview:queryExecutionTime>`;

/** LIVE: one SAP GUI logon. */
const ONE_LOGON = `${head(1, 'DEVELOPER')}<dataPreview:columns>${metadata('SERVER', 'C')}<dataPreview:dataSet><dataPreview:data>vhcala4hci_A4H_01</dataPreview:data></dataPreview:dataSet></dataPreview:columns><dataPreview:columns>${metadata('LOGON_DATE', 'D')}<dataPreview:dataSet><dataPreview:data>20261028</dataPreview:data></dataPreview:dataSet></dataPreview:columns><dataPreview:columns>${metadata('LOGON_TIME', 'T')}<dataPreview:dataSet><dataPreview:data>113108</dataPreview:data></dataPreview:dataSet></dataPreview:columns></dataPreview:tableData>`;

/** LIVE: a user without any SAP GUI logon — every column, an empty data set. */
const NO_LOGON = `${head(0, 'NOBODY')}<dataPreview:columns>${metadata('SERVER', 'C')}<dataPreview:dataSet/></dataPreview:columns><dataPreview:columns>${metadata('LOGON_DATE', 'D')}<dataPreview:dataSet/></dataPreview:columns><dataPreview:columns>${metadata('LOGON_TIME', 'T')}<dataPreview:dataSet/></dataPreview:columns></dataPreview:tableData>`;

/** The same shape with several rows: each column lists its values in row order. */
function logons(rows: Array<[server: string, date: string, time: string]>): string {
  const column = (name: string, type: string, index: number) =>
    `<dataPreview:columns>${metadata(name, type)}<dataPreview:dataSet>${rows
      .map((row) => `<dataPreview:data>${row[index]}</dataPreview:data>`)
      .join('')}</dataPreview:dataSet></dataPreview:columns>`;
  return `${head(rows.length, 'DEVELOPER')}${column('SERVER', 'C', 0)}${column('LOGON_DATE', 'D', 1)}${column('LOGON_TIME', 'T', 2)}</dataPreview:tableData>`;
}

const answering = (body: string) => ({ post: vi.fn().mockResolvedValue({ statusCode: 200, headers: {}, body }) });

describe('parseDataPreview', () => {
  it('turns the column-wise answer into rows keyed by column name, keeping leading zeros', () => {
    expect(parseDataPreview(ONE_LOGON)).toEqual([
      { SERVER: 'vhcala4hci_A4H_01', LOGON_DATE: '20261028', LOGON_TIME: '113108' },
    ]);
    expect(
      parseDataPreview(
        logons([
          ['a', '20261027', '080000'],
          ['b', '20261028', '000501'],
        ]),
      ),
    ).toEqual([
      { SERVER: 'a', LOGON_DATE: '20261027', LOGON_TIME: '080000' },
      { SERVER: 'b', LOGON_DATE: '20261028', LOGON_TIME: '000501' },
    ]);
  });

  it('finds no rows in an empty answer or something else', () => {
    expect(parseDataPreview(NO_LOGON)).toEqual([]);
    expect(parseDataPreview('No authorization for table USR41')).toEqual([]);
  });
});

describe('readGuiLogons', () => {
  it("selects the user's USR41 rows through the freestyle data preview", async () => {
    const http = answering(ONE_LOGON);
    const found = await readGuiLogons(http as unknown as AdtHttpClient, ' developer ', { deadline: 42 });
    expect(found).toEqual([{ server: 'vhcala4hci_A4H_01', logonAt: '20261028113108' }]);
    expect(http.post).toHaveBeenCalledWith(
      `${DATA_PREVIEW_FREESTYLE_PATH}?rowNumber=100`,
      "SELECT server, logon_date, logon_time FROM usr41 WHERE bname = 'DEVELOPER'",
      'text/plain',
      { Accept: 'application/xml, application/vnd.sap.adt.datapreview.table.v1+xml' },
      { suppressNotFoundLog: true, deadline: 42 },
    );
  });

  it('keeps the latest logon per server, the most recent first', async () => {
    const http = answering(
      logons([
        ['vhcala4hci_A4H_00', '20261028', '090000'],
        ['vhcala4hci_A4H_01', '20261028', '080000'],
        ['vhcala4hci_A4H_01', '20261028', '101500'],
        ['vhcala4hci_A4H_02', '20261027', '235959'],
      ]),
    );
    expect(await readGuiLogons(http as unknown as AdtHttpClient, 'DEVELOPER')).toEqual([
      { server: 'vhcala4hci_A4H_01', logonAt: '20261028101500' },
      { server: 'vhcala4hci_A4H_00', logonAt: '20261028090000' },
      { server: 'vhcala4hci_A4H_02', logonAt: '20261027235959' },
    ]);
  });

  it('finds nothing for a user without SAP GUI logon, and asks nothing for a name SAP cannot have', async () => {
    expect(await readGuiLogons(answering(NO_LOGON) as unknown as AdtHttpClient, 'NOBODY')).toEqual([]);
    const http = answering(ONE_LOGON);
    expect(await readGuiLogons(http as unknown as AdtHttpClient, 'me@example.com')).toEqual([]);
    expect(await readGuiLogons(http as unknown as AdtHttpClient, '')).toEqual([]);
    expect(http.post).not.toHaveBeenCalled();
  });

  it('quotes the user name as an ABAP SQL literal', async () => {
    const http = answering(NO_LOGON);
    await readGuiLogons(http as unknown as AdtHttpClient, "o'neil");
    expect(http.post.mock.calls[0]?.[1]).toBe(
      "SELECT server, logon_date, logon_time FROM usr41 WHERE bname = 'O''NEIL'",
    );
  });

  it('lets a refusal through: no authorization for USR41, no data preview', async () => {
    const http = { post: vi.fn().mockRejectedValue(new AdtApiError('No authorization', 403, '/x')) };
    await expect(readGuiLogons(http as unknown as AdtHttpClient, 'DEVELOPER')).rejects.toThrow(AdtApiError);
  });
});
