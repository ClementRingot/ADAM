/**
 * The one XML boundary: fast-xml-parser with ADT conventions (namespace prefixes stripped, values
 * kept as strings). Every attribute and text value comes back entity-DECODED exactly once
 * (`R&amp;D` → `R&D`): never decode a parsed value again, and `escapeXml` it on the way back.
 */

import { XMLParser } from 'fast-xml-parser';

export type XmlNode = Record<string, unknown>;

/** Decode raw XML text once, in one pass (`&amp;lt;` stays `&lt;`). No DTD expansion. */
export function decodeXmlEntities(text: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/g, (reference, name: string) => {
    if (name[0] !== '#') return named[name] ?? reference;
    const code = name[1] === 'x' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
    // XML 1.0 Char production: a malformed reference in an SAP answer stays literal instead of throwing.
    const valid =
      code === 9 ||
      code === 10 ||
      code === 13 ||
      (code >= 0x20 && code <= 0xd7ff) ||
      (code >= 0xe000 && code <= 0xfffd) ||
      (code >= 0x10000 && code <= 0x10ffff);
    return valid ? String.fromCodePoint(code) : reference;
  });
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

/** Escape text for an XML attribute or element. */
export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

const parserOptions = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseAttributeValue: false,
  parseTagValue: false,
  // The parser's own entity boundary skips literal CDATA; decode only predefined/numeric references.
  entityDecoder: {
    decode: decodeXmlEntities,
    addInputEntities: () => {},
    setExternalEntities: () => {},
    setXmlVersion: () => {},
    reset: () => {},
  },
};
const parser = new XMLParser(parserOptions);
const exactParser = new XMLParser({ ...parserOptions, trimValues: false });

/** Parse an XML document. `exact` keeps the texts' leading and trailing blanks (a variable's value needs them). */
export function parseXml(xml: string, exact = false): XmlNode {
  return (exact ? exactParser : parser).parse(xml) as XmlNode;
}

export function asNode(value: unknown): XmlNode | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as XmlNode) : undefined;
}

/** One element or a repeated one, as a list — the parser leaves a single element unwrapped. */
export function asNodes(value: unknown): XmlNode[] {
  if (Array.isArray(value)) return value.map(asNode).filter((node): node is XmlNode => !!node);
  const node = asNode(value);
  return node ? [node] : [];
}

/** Text of an element or attribute (already decoded by `parseXml`). */
export function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const node = asNode(value);
  return node && node['#text'] !== undefined ? String(node['#text']) : '';
}

export function attr(node: XmlNode, name: string): string {
  return text(node[`@_${name}`]);
}
