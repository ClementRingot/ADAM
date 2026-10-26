/**
 * Where a method's implementation sits in a class source (its METHOD … ENDMETHOD lines), so a
 * `method` breakpoint lands on the method's first statement. abaplint parses the source; a line
 * scan is the fallback for code abaplint cannot structure. Ported from ARC-1
 * (src/context/method-surgery.ts `listMethods` + `extractMethod`), reduced to what a debugger needs.
 */

import { Config, MemoryFile, type Nodes, Registry, Structures, Version } from '@abaplint/core';

export interface MethodImplementation {
  /** As written in the METHOD statement: `get_total`, `zif_order~process`. */
  name: string;
  /** The class whose IMPLEMENTATION holds it (`zcl_order`, `lhc_travel`); '' when unknown. */
  containingClass: string;
  /** 1-based lines of the METHOD and ENDMETHOD statements. */
  startLine: number;
  endLine: number;
}

export type MethodLocation =
  | { found: true; name: string; startLine: number; endLine: number }
  | { found: false; error: string };

/**
 * The abaplint grammar for an SAP_BASIS release (`750`, `7.57`, `816`): additive versions up to
 * 7.58, abaplint's ceiling — 8xx on-premise code is classic ABAP, so it maps to 7.58, not Cloud.
 */
export function abaplintVersionFor(release: string | undefined): Version | undefined {
  const digits = Number.parseInt((release ?? '').replace(/\D/g, ''), 10);
  if (Number.isNaN(digits)) return undefined;
  if (digits >= 758) return Version.v758;
  const versions: Array<[number, Version]> = [
    [757, Version.v757],
    [756, Version.v756],
    [755, Version.v755],
    [754, Version.v754],
    [753, Version.v753],
    [752, Version.v752],
    [751, Version.v751],
    [750, Version.v750],
    [740, Version.v740sp08],
    [702, Version.v702],
  ];
  return versions.find(([from]) => digits >= from)?.[1] ?? Version.v700;
}

const configs = new Map<Version, Config>();

function configFor(version: Version): Config {
  let config = configs.get(version);
  if (!config) {
    config = Config.getDefault(version);
    configs.set(version, config);
  }
  return config;
}

type ParsedFile = { getStructure(): Nodes.StructureNode | undefined };

/** METHOD … ENDMETHOD ranges from abaplint's syntax tree; empty when it cannot structure the source. */
export function implementationsByParser(source: string, className: string, version: Version): MethodImplementation[] {
  const registry = new Registry(configFor(version));
  registry.addFile(new MemoryFile(`${className.toLowerCase().replace(/\//g, '#')}.clas.abap`, source));
  registry.parse();
  const found: MethodImplementation[] = [];
  for (const object of registry.getObjects()) {
    const file = (object as { getMainABAPFile?: () => ParsedFile | undefined }).getMainABAPFile?.();
    const structure = file?.getStructure();
    if (!structure) continue;
    for (const implementation of structure.findAllStructuresRecursive(Structures.ClassImplementation)) {
      const header = implementation.getFirstStatement()?.concatTokens() ?? '';
      const containingClass = /^CLASS\s+(\S+)\s+IMPLEMENTATION/i.exec(header)?.[1] ?? '';
      for (const method of implementation.findAllStructuresRecursive(Structures.Method)) {
        const statement = method.getFirstStatement();
        const name = statement ? /^METHOD\s+([^\s.]+)/i.exec(statement.concatTokens())?.[1] : undefined;
        if (!statement || !name) continue;
        found.push({
          name,
          containingClass,
          startLine: statement.getFirstToken().getRow(),
          endLine: method.getLastToken().getRow(),
        });
      }
    }
  }
  return found;
}

/** Statement-per-line scan of `CLASS … IMPLEMENTATION` blocks — the fallback for unparseable code. */
export function implementationsByLineScan(source: string): MethodImplementation[] {
  const found: MethodImplementation[] = [];
  let containingClass: string | undefined;
  let open: { name: string; startLine: number } | undefined;
  source.split('\n').forEach((line, index) => {
    const statement = line.trim();
    const implementation = /^CLASS\s+(\S+)\s+IMPLEMENTATION\s*\.?$/i.exec(statement);
    if (implementation) {
      containingClass = implementation[1] as string;
      return;
    }
    if (containingClass === undefined) return;
    if (/^ENDCLASS\s*\./i.test(statement)) {
      containingClass = undefined;
      open = undefined;
      return;
    }
    const method = /^METHOD\s+([^\s.]+)/i.exec(statement);
    if (method) {
      open = { name: method[1] as string, startLine: index + 1 };
    } else if (open && /^ENDMETHOD\s*\./i.test(statement)) {
      found.push({ ...open, containingClass, endLine: index + 1 });
      open = undefined;
    }
  });
  return found;
}

/**
 * The method `methodName` names in one listing. Lookup order, as ARC-1's `extractMethod`:
 * 1. a bare name several local classes implement is ambiguous — the caller must qualify it;
 * 2. exact match (`get_total`, or a global interface method `zif_order~process`);
 * 3. local-class qualified (`lhc_travel~validate_dates` → method validate_dates of lhc_travel);
 * 4. a bare name matching one interface method (`process` → `zif_order~process`).
 * Undefined = not in this listing.
 */
function pick(methods: MethodImplementation[], methodName: string, className: string): MethodLocation | undefined {
  const wanted = methodName.trim().toUpperCase();
  const tilde = wanted.indexOf('~');
  if (tilde < 0) {
    const owners = [
      ...new Set(methods.filter((m) => m.name.toUpperCase() === wanted).map((m) => m.containingClass)),
    ].filter(Boolean);
    if (owners.length > 1) {
      return {
        found: false,
        error: `Ambiguous method name "${methodName}" in ${className}: ${owners.join(', ')} each implement it. Qualify it, e.g. "${owners[0]}~${methodName}".`,
      };
    }
  }
  let match = methods.find((m) => m.name.toUpperCase() === wanted);
  if (!match && tilde >= 0) {
    const owner = wanted.slice(0, tilde);
    const bare = wanted.slice(tilde + 1);
    match = methods.find((m) => m.containingClass.toUpperCase() === owner && m.name.toUpperCase() === bare);
  }
  if (!match && tilde < 0) {
    const candidates = methods.filter((m) => m.name.toUpperCase().split('~')[1] === wanted);
    if (candidates.length > 1) {
      return {
        found: false,
        error: `Ambiguous method name "${methodName}": ${candidates.map((m) => m.name).join(', ')}. Use the full name, e.g. "${candidates[0]?.name}".`,
      };
    }
    match = candidates[0];
  }
  return match ? { found: true, name: match.name, startLine: match.startLine, endLine: match.endLine } : undefined;
}

function describe(methods: MethodImplementation[]): string {
  const qualify = new Set(methods.map((m) => m.containingClass).filter(Boolean)).size > 1;
  return methods.map((m) => (qualify && m.containingClass ? `${m.containingClass}~${m.name}` : m.name)).join(', ');
}

/**
 * Locate `methodName` in a class source (main source or a local-class include). abaplint parses it
 * with `version` (default: ABAP Cloud) and then 7.58 — classic statements can defeat the Cloud
 * grammar and vice versa — before the line scan has its turn.
 */
export function locateMethod(source: string, className: string, methodName: string, version?: Version): MethodLocation {
  const normalized = source.replace(/\r\n/g, '\n');
  const versions = [...new Set([version ?? Version.Cloud, Version.v758])];
  const listings = [
    ...versions.map((candidate) => () => {
      try {
        return implementationsByParser(normalized, className, candidate);
      } catch {
        return [];
      }
    }),
    () => implementationsByLineScan(normalized),
  ];
  let seen: MethodImplementation[] | undefined;
  for (const listing of listings) {
    const methods = listing();
    if (methods.length === 0) continue;
    seen ??= methods;
    const located = pick(methods, methodName, className);
    if (located) return located;
  }
  return {
    found: false,
    error: `Method "${methodName}" not found in ${className}. Implemented methods: ${describe(seen ?? []) || '(none)'}.`,
  };
}
