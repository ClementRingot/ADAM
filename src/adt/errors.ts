/**
 * Typed ADT failures: SAP answered with an error status (AdtApiError, carrying SAP's body) or no
 * answer arrived at all (AdtNetworkError: refused, timed out, cancelled).
 */

import { decodeXmlEntities } from './xml.js';

const MAX_MESSAGE = 300;

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, ' ');
}

/** Text of the first `<name …>…</name>` element (any namespace prefix), decoded once. */
function elementText(raw: string, name: string, attribute?: { key: string; value: string }): string | undefined {
  const attributes = attribute ? `[^>]*\\b${attribute.key}="${attribute.value}"[^>]*` : '[^>]*';
  const pattern = new RegExp(`<(?:[\\w.-]+:)?${name}\\b${attributes}>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}\\s*>`, 'i');
  const match = pattern.exec(raw)?.[1];
  const value = match ? collapse(decodeXmlEntities(stripTags(match))) : '';
  return value || undefined;
}

export class AdtApiError extends Error {
  /** SAP's readable sentence, without the status prefix of `message`. */
  readonly sapMessage: string;

  constructor(
    message: string,
    readonly statusCode: number,
    readonly path: string,
    readonly responseBody?: string,
  ) {
    const sapMessage = AdtApiError.cleanMessage(message);
    super(`ADT API error: status ${statusCode} at ${path}: ${sapMessage}`);
    this.name = 'AdtApiError';
    this.sapMessage = sapMessage;
  }

  /** SAP's readable sentence out of an XML exception or an HTML error page; plain text as it is. */
  static cleanMessage(raw: string): string {
    if (!raw) return 'Unknown error';
    const markup = /^\s*</.test(raw) || (/<html[\s>]/i.test(raw) && /<\/html\s*>/i.test(raw));
    if (!markup) return raw.slice(0, MAX_MESSAGE);
    const exception = elementText(raw, 'localizedMessage') ?? elementText(raw, 'message');
    if (exception) return exception;
    // SAP's HTML error pages carry the detail ("Syntax error in program …") in these elements.
    const detail =
      elementText(raw, 'span', { key: 'id', value: 'msgText' }) ??
      elementText(raw, 'p', { key: 'class', value: 'detailText' });
    const title = elementText(raw, 'title') ?? elementText(raw, 'h1');
    if (detail) return title && title !== detail ? `${title}: ${detail}` : detail;
    if (title) return title;
    const stripped = collapse(decodeXmlEntities(stripTags(raw)));
    return stripped ? stripped.slice(0, MAX_MESSAGE) : 'SAP returned an error (no readable message)';
  }
}

export class AdtNetworkError extends Error {
  constructor(message: string, cause?: Error) {
    super(`ADT network error: ${message}`, cause ? { cause } : undefined);
    this.name = 'AdtNetworkError';
  }

  get isTimeout(): boolean {
    return (this.cause as Error | undefined)?.name === 'TimeoutError';
  }
}
