/** The SAP connection the tools run on, and what a single tool call brings along. */

import type { AdtHttpClient } from '../adt/http.js';
import type { DebugLimits } from './debug-limits.js';

/** What a capture runs on: the SAP connection and what is known of its user and release. */
export interface SapConnection {
  http: AdtHttpClient;
  /**
   * SAP_USER when it IS the logon user (Basic or cookie authentication): the debug user where the
   * release cannot name the session's user itself (SAP_BASIS 7.50 and older).
   */
  logonUser?: string;
  /** SAP_BASIS release (SAP_ABAP_RELEASE): picks the ABAP grammar that locates `method` breakpoints. */
  abapRelease?: string;
  /** The server's ceilings for debugging (time, result size, interactive sessions); defaults apply when unset. */
  limits?: DebugLimits;
  /**
   * false: no SAP GUI on this system (BTP ABAP Environment, S/4HANA Cloud Public Edition), so no
   * SM51 advice for runs the user starts. Unset: on-premise or private cloud, where there is one.
   */
  sapGui?: boolean;
}

/** An answer to a dialog of the client (MCP elicitation). */
export type ConfirmAnswer = 'accept' | 'decline' | 'cancel';

/** One tool call's link back to the client. */
export interface ToolContext {
  /** The client cancelled the call. */
  signal?: AbortSignal;
  /** A progress notification, when the client asked for them (some clients keep a long call alive on them). */
  progress?: (message: string) => void;
  /** What the user must do now for the work to go on, shown by an answer running: true; undefined clears it. */
  hint?: (text: string | undefined) => void;
  /** The user must act before the work can go on: the call waiting for it answers running: true now, once. */
  answerNow?: () => void;
  /**
   * Show the user a message in a dialog of the client (MCP elicitation), with accept and decline;
   * only where the client can. Undefined: the dialog could not be shown, or was closed by `signal`.
   */
  confirm?: (message: string, signal?: AbortSignal) => Promise<ConfirmAnswer | undefined>;
  /**
   * Who calls: the MCP user over HTTP (their sessions are theirs alone); unset over stdio, where
   * the one local user calls.
   */
  owner?: string;
}
