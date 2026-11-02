/**
 * The ADT request headers that choose, and report, the application server a request runs on. See
 * docs/adt-debugger-protocol.md §5. A module of their own: the debugger reads them without loading
 * the HTTP transport.
 */

/**
 * The application server SAP runs a request on: the ADT handler of the server that receives it
 * forwards it there over RFC (CL_ADT_WB_RES_APP, `get_debugger_destination`).
 */
export const SERVER_INSTANCE_HEADER = 'X-sap-adt-server-instance';

/**
 * Sent as `fetch`: the ADT handler that runs the request itself answers with its server's name
 * (`cl_icm_api=>get_encoded_instance_name`); a request it forwards to another server comes back
 * without it.
 */
export const SAPLB_HEADER = 'sap-adt-saplb';

/**
 * The server a new session should land on, for the BTP ABAP Environment's load balancer: Eclipse ADT
 * sends it there on the attach of a new stateful session, whose `sap-contextid` then names that server
 * (mcp-abap-adt-clients, from Eclipse's Communication Log; 10 attaches of 10, 5 across servers).
 * On-premise nothing is known to read it: the ADT handler forwards instead.
 */
export const LOAD_BALANCER_HEADER = 'saplb';
