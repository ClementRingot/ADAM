/**
 * Repository reads the debugger needs: source code (numbered exactly as breakpoints address it),
 * the object quick search, and a function module's group.
 */

import type { AdtHttpClient, AdtRequestOptions } from './http.js';
import { asNode, asNodes, attr, parseXml } from './xml.js';

export type SourceVersion = 'active' | 'inactive';

/** Breakpoints apply to the ACTIVE code, so that is what callers normally read. */
export async function readSource(
  http: AdtHttpClient,
  sourceUri: string,
  version: SourceVersion = 'active',
  options?: AdtRequestOptions,
): Promise<string> {
  const separator = sourceUri.includes('?') ? '&' : '?';
  const resp = await http.get(`${sourceUri}${separator}version=${version}`, { Accept: 'text/plain' }, options);
  return resp.body;
}

export interface ObjectReference {
  /** ADT type, e.g. CLAS/OC, PROG/P, FUGR/FF. */
  type: string;
  name: string;
  packageName: string;
  description: string;
  uri: string;
}

/** Older releases decorate names with a type label ("Z_FM (Function Module)"); keep the bare name when the URI proves it. */
function canonicalName(displayName: string, uri: string): string {
  const name = /^([^\s()]+) \([^()]+\)$/.exec(displayName)?.[1];
  if (!name) return displayName;
  const segment = /^\/sap\/bc\/adt\/(?:[^/?#]+\/)*([^/?#]+)$/i.exec(uri)?.[1];
  try {
    return segment && decodeURIComponent(segment).toUpperCase() === name.toUpperCase() ? name : displayName;
  } catch {
    return displayName;
  }
}

export function parseSearchResults(xml: string): ObjectReference[] {
  if (!xml.trim()) return [];
  const references = asNodes(asNode(parseXml(xml).objectReferences)?.objectReference);
  return references.map((ref) => ({
    type: attr(ref, 'type'),
    name: canonicalName(attr(ref, 'name'), attr(ref, 'uri')),
    packageName: attr(ref, 'packageName'),
    description: attr(ref, 'description'),
    uri: attr(ref, 'uri'),
  }));
}

/** ADT quick search: `query` is a name pattern (`ZCL_ORDER*`); `objectType` narrows it (`CLAS`, `PROG/P`). */
export async function searchObjects(
  http: AdtHttpClient,
  query: string,
  maxResults = 50,
  objectType?: string,
  options?: AdtRequestOptions,
): Promise<ObjectReference[]> {
  const params = new URLSearchParams({
    operation: 'quickSearch',
    query,
    maxResults: String(Math.max(1, Math.min(200, Math.floor(maxResults)))),
  });
  if (objectType) params.set('objectType', objectType);
  const resp = await http.get(
    `/sap/bc/adt/repository/informationsystem/search?${params.toString()}`,
    undefined,
    options,
  );
  return parseSearchResults(resp.body);
}

/** A service binding: what the OData service publishes, and the service definition behind each version. */
export interface ServiceBinding {
  name: string;
  description: string;
  published: boolean;
  /** `ODATA`, with its protocol version (`V2`, `V4`) and category (`UI`, `Web API`). */
  bindingType: string;
  odataVersion: string;
  category: string;
  services: Array<{
    name: string;
    versions: Array<{ version: string; serviceDefinition: string; releaseState: string }>;
  }>;
  packageName: string;
}

export function parseServiceBinding(xml: string): ServiceBinding {
  const node = asNode(parseXml(xml).serviceBinding) ?? {};
  const binding = asNode(node.binding) ?? {};
  const category = attr(binding, 'category');
  return {
    name: attr(node, 'name'),
    description: attr(node, 'description'),
    published: attr(node, 'published') === 'true',
    bindingType: attr(binding, 'type'),
    odataVersion: attr(binding, 'version'),
    category: category === '0' ? 'UI' : category === '1' ? 'Web API' : category,
    services: asNodes(node.services).map((service) => ({
      name: attr(service, 'name'),
      versions: asNodes(service.content).map((content) => ({
        version: attr(content, 'version'),
        serviceDefinition: attr(asNode(content.serviceDefinition) ?? {}, 'name'),
        releaseState: attr(content, 'releaseState'),
      })),
    })),
    packageName: attr(asNode(node.packageRef) ?? {}, 'name'),
  };
}

/** A service binding has no source: its metadata names the service definition behind it. */
export async function readServiceBinding(
  http: AdtHttpClient,
  name: string,
  options?: AdtRequestOptions,
): Promise<ServiceBinding> {
  const resp = await http.get(
    `/sap/bc/adt/businessservices/bindings/${encodeURIComponent(name.toLowerCase())}`,
    { Accept: 'application/vnd.sap.adt.businessservices.servicebinding.v2+xml' },
    options,
  );
  return parseServiceBinding(resp.body);
}

/** The function group of a function module, proven by its ADT URI; undefined when the search finds none. */
export async function resolveFunctionGroup(
  http: AdtHttpClient,
  functionModule: string,
  options?: AdtRequestOptions,
): Promise<string | undefined> {
  for (const ref of await searchObjects(http, functionModule, 10, undefined, options)) {
    const match = /\/functions\/groups\/([^/]+)\/fmodules\/([^/?#]+)(?:[/?#]|$)/i.exec(ref.uri);
    if (match && decodeURIComponent(match[2] as string).toUpperCase() === functionModule.toUpperCase()) {
      return decodeURIComponent(match[1] as string).toUpperCase();
    }
  }
  return undefined;
}
