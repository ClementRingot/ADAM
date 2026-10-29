/**
 * Where the user's SAP GUI runs: the application server of each of the user's SAP GUI logons.
 *
 * SAP records one USR41 row per SAP GUI logon (server, date, time); ADT's own sessions leave none
 * (seen live). The ADT data preview — the freestyle SQL console of Eclipse ADT, `POST
 * /sap/bc/adt/datapreview/freestyle` with an ABAP SQL SELECT as its body — reads it as the session
 * user, so it needs that user's display authorization for the table. With several application
 * servers a SAP GUI run stops reliably only on the server that armed the breakpoints last, so the
 * capture arms the user's SAP GUI server last. See docs/adt-debugger-protocol.md ("SAP GUI runs").
 */

import type { AdtHttpClient, AdtRequestOptions } from './http.js';
import { isPlausibleSapUser } from './session-user.js';
import { asNode, asNodes, attr, parseXml, text } from './xml.js';

export const DATA_PREVIEW_FREESTYLE_PATH = '/sap/bc/adt/datapreview/freestyle';
const DATA_PREVIEW_ACCEPT = 'application/xml, application/vnd.sap.adt.datapreview.table.v1+xml';
/** More rows than one user's logons: the preview cuts the answer there. */
const MAX_ROWS = 100;

/** One of the user's SAP GUI logons. */
export interface GuiLogon {
  /** The application server, as SM51 names it (`host_SID_00`) — the server a `sap-contextid` names. */
  server: string;
  /** When the user logged on there: `YYYYMMDDhhmmss`, server time. */
  logonAt: string;
}

/**
 * The rows of a data preview answer, each keyed by upper-case column name. The answer lists columns,
 * each with its values in row order: `tableData` → `columns` (`metadata` names it) → `dataSet` → `data`.
 */
export function parseDataPreview(body: string): Array<Record<string, string>> {
  const rows: Array<Record<string, string>> = [];
  for (const column of asNodes(asNode(parseXml(body).tableData)?.columns)) {
    const name = attr(asNode(column.metadata) ?? {}, 'name')
      .trim()
      .toUpperCase();
    if (!name) continue;
    const data = asNode(column.dataSet)?.data;
    const values = Array.isArray(data) ? data : data === undefined ? [] : [data];
    values.forEach((value, index) => {
      const row = (rows[index] ??= {});
      row[name] = text(value).trim();
    });
  }
  return rows;
}

/**
 * The SAP GUI logons of `user`, the most recent first, one per application server (its latest).
 * None for an implausible user name. Errors propagate: no display authorization for USR41, a
 * release or a system without the freestyle data preview.
 */
export async function readGuiLogons(
  http: AdtHttpClient,
  user: string,
  options: AdtRequestOptions = {},
): Promise<GuiLogon[]> {
  const name = user.trim().toUpperCase();
  if (!isPlausibleSapUser(name)) return [];
  const sql = `SELECT server, logon_date, logon_time FROM usr41 WHERE bname = '${name.replace(/'/g, "''")}'`;
  const resp = await http.post(
    `${DATA_PREVIEW_FREESTYLE_PATH}?rowNumber=${MAX_ROWS}`,
    sql,
    'text/plain',
    { Accept: DATA_PREVIEW_ACCEPT },
    { suppressNotFoundLog: true, ...options },
  );
  const latest = new Map<string, GuiLogon>();
  for (const row of parseDataPreview(resp.body)) {
    const server = row.SERVER ?? '';
    if (!server) continue;
    const logon = { server, logonAt: `${row.LOGON_DATE ?? ''}${row.LOGON_TIME ?? ''}` };
    const seen = latest.get(server.toUpperCase());
    if (!seen || logon.logonAt > seen.logonAt) latest.set(server.toUpperCase(), logon);
  }
  return [...latest.values()].sort((a, b) => (a.logonAt < b.logonAt ? 1 : a.logonAt > b.logonAt ? -1 : 0));
}
