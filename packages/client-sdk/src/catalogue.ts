import { SdkError } from './errors.js';
import { ABSOLUTE_IRI } from './iri.js';

/**
 * Minimal canonical registry adapter (SPS-CTX-031–034), not a general JSON-LD
 * parser. Rights are response-relative facts for this caller, never grants for
 * a later request; malformed or inconsistent catalogues are failures, not empty.
 */
export interface CatalogueContext {
  readonly iri: string;
  readonly readable: boolean;
  readonly writable: boolean;
  readonly manageable: boolean;
}

/** An `SdkError` with reason `{ code: 'catalogue' }`, so presentation can describe it. */
export class CatalogueError extends SdkError {
  constructor() {
    super({ code: 'catalogue' }, 'Invalid canonical context catalogue.');
    this.name = 'CatalogueError';
  }
}

export function decodeCatalogue(
  body: unknown,
  podUrl: string,
): readonly CatalogueContext[] {
  const sd = 'http://www.w3.org/ns/sparql-service-description#';
  const sps = 'https://schema.sempods.org/';
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    throw new CatalogueError();
  const data = body as Record<string, unknown>;
  if (
    '@context' in data ||
    data['@id'] !== `${podUrl}/_system/contexts` ||
    !Array.isArray(data['@type']) ||
    !data['@type'].includes(`${sd}GraphCollection`)
  )
    throw new CatalogueError();
  function iris(predicate: string): readonly string[] {
    const values = data[predicate];
    if (values === undefined) return [];
    if (!Array.isArray(values)) throw new CatalogueError();
    return values.map((value: unknown) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new CatalogueError();
      const node = value as Record<string, unknown>;
      const iri = node['@id'];
      if (
        Object.keys(node).length !== 1 ||
        typeof iri !== 'string' ||
        !ABSOLUTE_IRI.test(iri)
      )
        throw new CatalogueError();
      return iri;
    });
  }
  const members = new Set(iris(`${sd}namedGraph`));
  const read = new Set(iris(`${sps}readableContext`));
  const write = new Set(iris(`${sps}writableContext`));
  const manage = new Set(iris(`${sps}manageableContext`));
  // SPS-CTX-033/034: registered contexts of this pod; visibility needs a mode,
  // and modes imply each other (manage ⊆ write ⊆ read), so every member is readable.
  if (
    [...members].some((iri) => !isContextIri(iri, podUrl) || !read.has(iri)) ||
    [...read].some((iri) => !members.has(iri)) ||
    [...write].some((iri) => !read.has(iri)) ||
    [...manage].some((iri) => !write.has(iri))
  )
    throw new CatalogueError();
  return Object.freeze(
    [...members].map((iri) =>
      Object.freeze({
        iri,
        readable: read.has(iri),
        writable: write.has(iri),
        manageable: manage.has(iri),
      }),
    ),
  );
}

/**
 * A context IRI of this pod that can be addressed again (SPS-CTX-004/010/013):
 * under `{pod}/_system/contexts/`, non-empty segments, no `.`/`..`, no percent
 * encoding, query, fragment, backslash, whitespace or control character, no
 * `_system` segment, and parseable. Raw Unicode is allowed (an IRI, not a URI).
 * Non-canonical identities are rejected, never normalized.
 */
export function isContextIri(iri: string, podUrl: string): boolean {
  const prefix = `${podUrl}/_system/contexts/`;
  // The pod base may be percent-encoded; the context path itself may not.
  const path = iri.slice(prefix.length);
  if (
    !iri.startsWith(prefix) ||
    /[%?#\\\s]/.test(path) ||
    [...path].some((c) => c < ' ' || c === '\u007f')
  )
    return false;
  if (!URL.canParse(iri)) return false;
  return iri
    .slice(prefix.length)
    .split('/')
    .every(
      (segment) =>
        segment !== '' &&
        segment !== '.' &&
        segment !== '..' &&
        segment !== '_system',
    );
}

/**
 * A Context's registry description (SPS-CTX-031/032): what the Pod says about
 * it, never what the caller may do. `label` and `description` are present only
 * as exactly one plain string; `created` only as one `xsd:dateTime` literal.
 * Additional descriptive predicates are tolerated and ignored.
 */
export interface ContextDescription {
  readonly iri: string;
  readonly public: boolean;
  readonly label?: string;
  readonly description?: string;
  readonly created?: string;
}

const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const DCTERMS = 'http://purl.org/dc/terms/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

/** Decodes one canonical Context description; a malformed required part is a `CatalogueError`. */
export function decodeContextDescription(
  body: unknown,
  contextIri: string,
  podUrl: string,
): ContextDescription {
  const sd = 'http://www.w3.org/ns/sparql-service-description#';
  if (
    !isContextIri(contextIri, podUrl) ||
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body)
  )
    throw new CatalogueError();
  const data = body as Record<string, unknown>;
  const values = (predicate: string): readonly Record<string, unknown>[] => {
    const value = data[predicate];
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new CatalogueError();
    return value.map((item: unknown) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item))
        throw new CatalogueError();
      return item as Record<string, unknown>;
    });
  };
  const names = values(`${sd}name`);
  const isPublic = values('https://schema.sempods.org/public');
  if (
    '@context' in data ||
    data['@id'] !== contextIri ||
    !Array.isArray(data['@type']) ||
    !data['@type'].includes(`${sd}NamedGraph`) ||
    names.length !== 1 ||
    names[0]!['@id'] !== contextIri ||
    isPublic.length !== 1 ||
    typeof isPublic[0]!['@value'] !== 'boolean'
  )
    throw new CatalogueError();
  // Descriptive text: one plain string, untagged or xsd:string; anything else is left out.
  const text = (predicate: string): string | undefined => {
    const found = values(predicate);
    if (found.length !== 1) return undefined;
    const [value] = found;
    const type = value!['@type'];
    return typeof value!['@value'] === 'string' &&
      value!['@language'] === undefined &&
      (type === undefined || type === `${XSD}string`)
      ? value!['@value']
      : undefined;
  };
  const created = values(`${DCTERMS}created`);
  const label = text(RDFS_LABEL);
  const description = text(`${DCTERMS}description`);
  return Object.freeze({
    iri: contextIri,
    public: isPublic[0]!['@value'] as boolean,
    ...(label === undefined ? {} : { label }),
    ...(description === undefined ? {} : { description }),
    ...(created.length === 1 &&
    typeof created[0]!['@value'] === 'string' &&
    created[0]!['@type'] === `${XSD}dateTime`
      ? { created: created[0]!['@value'] }
      : {}),
  });
}
