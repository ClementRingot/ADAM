/**
 * The HTTP trigger only ever GETs an OData path on the connected system — never an absolute URL, a
 * traversal, or another SAP service.
 */

const BASE = 'https://odata-path.invalid';

function isODataPath(pathname: string): boolean {
  return (
    pathname === '/sap/opu/odata' ||
    pathname.startsWith('/sap/opu/odata/') ||
    pathname === '/sap/opu/odata4' ||
    pathname.startsWith('/sap/opu/odata4/')
  );
}

/** `/sap/opu/odata4/…` or `/sap/opu/odata/sap/<SRV>/…`, with an optional query string. */
export function isHostRelativeODataPath(url: string): boolean {
  const rawPath = url.split(/[?#]/, 1)[0] ?? '';
  let parsed: URL;
  try {
    parsed = new URL(url, BASE);
  } catch {
    return false;
  }
  return !(
    url.length > 4096 ||
    !url.startsWith('/') ||
    url.startsWith('//') ||
    url.includes('://') ||
    url.includes('\\') ||
    url.includes('#') ||
    /(?:^|\/)(?:\.|%2e)(?:\/|$)/i.test(rawPath) ||
    /(?:^|\/)(?:\.|%2e){2}(?:\/|$)/i.test(rawPath) ||
    /%5c/i.test(rawPath) ||
    parsed.origin !== BASE ||
    !isODataPath(parsed.pathname)
  );
}
