/**
 * Object types and their ADT addresses — the few the debugger works with.
 */

/** SAP's slash types as callers may pass them (from a search result, from Eclipse). */
const SLASH_TYPES: Record<string, string> = {
  'CLAS/OC': 'CLAS',
  'PROG/P': 'PROG',
  'FUGR/FF': 'FUNC',
  'FUGR/F': 'FUGR',
  'PROG/I': 'INCL',
  'INTF/OI': 'INTF',
  'DDLS/DF': 'DDLS',
  'DCLS/DL': 'DCLS',
  'DDLX/EX': 'DDLX',
  'BDEF/BDO': 'BDEF',
  'SRVD/SRV': 'SRVD',
  'SRVB/SVB': 'SRVB',
};

/** `clas` → `CLAS`, `CLAS/OC` → `CLAS`, `FUGR/FF` → `FUNC`. */
export function normalizeObjectType(type: string): string {
  const upper = type.trim().toUpperCase();
  return SLASH_TYPES[upper] ?? upper;
}

const OBJECT_PATHS: Record<string, string> = {
  CLAS: '/sap/bc/adt/oo/classes/',
  PROG: '/sap/bc/adt/programs/programs/',
  FUGR: '/sap/bc/adt/functions/groups/',
};

/** The ADT object URL ABAP Unit runs (CLAS, PROG or FUGR). */
export function objectUrl(type: string, name: string): string {
  const base = OBJECT_PATHS[type];
  if (!base) throw new Error(`No ADT object URL for type ${type}.`);
  return `${base}${encodeURIComponent(name)}`;
}

export type ClassInclude = 'implementations' | 'testclasses' | 'definitions';

/**
 * The class include a `<localclass>~<method>` specifier lives in: `lhc_*`/`lcl_*` (RAP handlers,
 * local helpers) → implementations, `ltc_*` (local test classes) → testclasses. Global interface
 * methods (`zif_order~create`) and bare names live in the main source.
 */
export function detectLocalHandlerInclude(method: string): ClassInclude | undefined {
  if (!method.includes('~')) return undefined;
  const owner = method.slice(0, method.indexOf('~')).trim().toLowerCase();
  if (/^(lhc|lcl)_/.test(owner)) return 'implementations';
  if (/^ltc_/.test(owner)) return 'testclasses';
  return undefined;
}

/** Sources the debugger only reads: they lead to the code it stops in (no breakpoints there). */
const READ_ONLY_SOURCE_PATHS: Record<string, string> = {
  INTF: '/sap/bc/adt/oo/interfaces/',
  INCL: '/sap/bc/adt/programs/includes/',
  DDLS: '/sap/bc/adt/ddic/ddl/sources/',
  DCLS: '/sap/bc/adt/acm/dcl/sources/',
  DDLX: '/sap/bc/adt/ddic/ddlx/sources/',
  BDEF: '/sap/bc/adt/bo/behaviordefinitions/',
  SRVD: '/sap/bc/adt/ddic/srvd/sources/',
};

export const READ_ONLY_SOURCE_TYPES = Object.keys(READ_ONLY_SOURCE_PATHS);

/** The source URI of an interface, include, CDS object, behavior or service definition. */
export function readOnlySourceUri(type: string, name: string): string {
  const base = READ_ONLY_SOURCE_PATHS[type];
  if (!base) throw new Error(`No source URI for type ${type}.`);
  return `${base}${encodeURIComponent(name.toLowerCase())}/source/main`;
}

/** Where the source of an object (or one class include) lives — the URI breakpoints are set on. */
export function sourceUri(
  type: 'CLAS' | 'PROG' | 'FUNC',
  name: string,
  include?: string,
  functionGroup?: string,
): string {
  const encoded = encodeURIComponent(name.toLowerCase());
  if (type === 'CLAS') {
    const base = `/sap/bc/adt/oo/classes/${encoded}`;
    return include ? `${base}/includes/${include}` : `${base}/source/main`;
  }
  if (type === 'PROG') return `/sap/bc/adt/programs/programs/${encoded}/source/main`;
  if (!functionGroup) throw new Error(`The function group of ${name} is needed for its source URI.`);
  return `/sap/bc/adt/functions/groups/${encodeURIComponent(functionGroup.toLowerCase())}/fmodules/${encoded}/source/main`;
}
