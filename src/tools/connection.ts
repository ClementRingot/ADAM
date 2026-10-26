/** The SAP connection the tools run on. */

import type { AdtHttpClient } from '../adt/http.js';

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
}
