/**
 * Authentication cookies: a Netscape cookie file (curl, browser extensions) or an inline
 * `name=value; name2=value2` string. Ported from ARC-1 (src/adt/cookies.ts).
 */

import { readFileSync } from 'node:fs';

/** Netscape format (7 tab-separated fields) or `name=value` lines; `#` lines are comments. */
export function parseCookieFileContent(content: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length >= 7) {
      cookies[parts[5] as string] = parts[6] as string;
    } else if (line.includes('=')) {
      const eq = line.indexOf('=');
      const key = line.slice(0, eq).trim();
      if (key) cookies[key] = line.slice(eq + 1).trim();
    }
  }
  return cookies;
}

export function parseCookieString(cookieString: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of cookieString.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    cookies[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return cookies;
}

/** The cookies of a file and/or a string; the string wins on a name collision. */
export function resolveCookies(
  cookieFile: string | undefined,
  cookieString: string | undefined,
): Record<string, string> | undefined {
  if (!cookieFile && !cookieString) return undefined;
  return {
    ...(cookieFile ? parseCookieFileContent(readFileSync(cookieFile, 'utf-8')) : {}),
    ...(cookieString ? parseCookieString(cookieString) : {}),
  };
}
