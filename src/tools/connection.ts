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
}

/** One tool call's link back to the client. */
export interface ToolContext {
  /** The client cancelled the call. */
  signal?: AbortSignal;
  /** A progress notification, when the client asked for them (some clients keep a long call alive on them). */
  progress?: (message: string) => void;
}
