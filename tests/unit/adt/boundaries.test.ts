/** Small boundaries: the OData trigger guard, SAP error text, cookies and XML entities. */
import { describe, expect, it } from 'vitest';
import { parseCookieFileContent, parseCookieString } from '../../../src/adt/cookies.js';
import { AdtApiError } from '../../../src/adt/errors.js';
import { isHostRelativeODataPath } from '../../../src/adt/odata-path.js';
import { decodeXmlEntities, escapeXml, parseXml } from '../../../src/adt/xml.js';

describe('isHostRelativeODataPath', () => {
  it('accepts OData V2 and V4 paths on the connected system', () => {
    expect(isHostRelativeODataPath('/sap/opu/odata4/sap/zui_travel/srvd/sap/ztravel/0001/Travel?$top=1')).toBe(true);
    expect(isHostRelativeODataPath('/sap/opu/odata/sap/ZTRAVEL_SRV/TravelSet')).toBe(true);
  });

  it('rejects absolute URLs, traversal and other SAP services', () => {
    for (const url of [
      'https://evil.example/sap/opu/odata4/x',
      '//evil.example/sap/opu/odata4/x',
      '/sap/opu/odata4/../../bc/adt/x',
      '/sap/opu/odata4/%2e%2e/x',
      '/sap/bc/adt/debugger',
      '/sap/opu/odata4\\x',
      '/sap/opu/odata4/x#frag',
      'sap/opu/odata4/x',
    ]) {
      expect(isHostRelativeODataPath(url), url).toBe(false);
    }
  });
});

describe('AdtApiError.cleanMessage', () => {
  it("finds SAP's sentence in exception XML and HTML error pages", () => {
    expect(
      AdtApiError.cleanMessage(
        '<exc:exception><exc:localizedMessage>A &lt;b&gt;</exc:localizedMessage></exc:exception>',
      ),
    ).toBe('A <b>');
    expect(
      AdtApiError.cleanMessage(
        '<html><head><title>Application Server Error</title></head><body><span id="msgText">Syntax error in ZCL_X</span></body></html>',
      ),
    ).toBe('Application Server Error: Syntax error in ZCL_X');
    expect(AdtApiError.cleanMessage('plain text')).toBe('plain text');
    expect(AdtApiError.cleanMessage('')).toBe('Unknown error');
  });
});

describe('cookies', () => {
  it('reads Netscape files and inline strings', () => {
    expect(
      parseCookieFileContent('# comment\nhost\tFALSE\t/\tTRUE\t0\tMYSAPSSO2\tabc==\nsap-usercontext=sap-client=001\n'),
    ).toEqual({ MYSAPSSO2: 'abc==', 'sap-usercontext': 'sap-client=001' });
    expect(parseCookieString('a=1; b = 2 ;broken; =x')).toEqual({ a: '1', b: '2' });
  });
});

describe('xml', () => {
  it('decodes once and escapes everything that needs it', () => {
    expect(decodeXmlEntities('&amp;lt; &#65;&#x42; &#x110000;')).toBe('&lt; AB &#x110000;');
    expect(escapeXml(`a&b<"c'>`)).toBe('a&amp;b&lt;&quot;c&apos;&gt;');
    expect(parseXml('<a:root xmlns:a="x" n="R&amp;D"><v> x </v></a:root>')).toEqual({ root: { '@_n': 'R&D', v: 'x' } });
    expect(parseXml('<root><v> x </v></root>', true)).toEqual({ root: { v: ' x ' } });
  });
});
