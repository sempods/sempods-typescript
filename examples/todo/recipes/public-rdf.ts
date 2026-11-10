/**
 * One explicit, credential-free lookup of public RDF at an IRI's own origin.
 * App-local recipe code on public types, without React: copy and adapt it.
 * Its parsers (`n3`, `jsonld`) are the app's dependencies, loaded lazily; the
 * SDK packages have none. Graph focusing and traversal limits stay in the app.
 */
import type { SparqlTerm } from '@sempods/client-sdk';
import type { Options } from 'jsonld';

type RemoteDocument = Awaited<
  ReturnType<NonNullable<Options.ToRdf['documentLoader']>>
>;

/**
 * RDF serializations in preference order. At most 128 bytes keeps `Accept` a
 * CORS-safelisted header, so the browser sends no preflight. TriG is parsed
 * when served but not asked for, to stay within that limit.
 */
export const PUBLIC_RDF_ACCEPT =
  'text/turtle,application/ld+json;q=0.9,application/n-triples;q=0.8,' +
  'application/n-quads;q=0.7,text/html;q=0.5';

/** Default byte cap for the response body (2 MiB). */
export const PUBLIC_RDF_MAX_BYTES = 2 * 1024 * 1024;

/** Default deadline for headers and body together. */
export const PUBLIC_RDF_TIMEOUT_MS = 10_000;

export interface PublicRdfOptions {
  /** Cancels the lookup, for example when the person moves on. */
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  /**
   * JSON-LD contexts the app bundles, by exact URL. Every other remote context
   * fails the lookup with `remote-context`; none is ever fetched.
   */
  readonly contexts?: Readonly<Record<string, unknown>>;
  /** A plain `fetch` for tests. Never pass a Pod transport here. */
  readonly fetch?: typeof globalThis.fetch;
}

/** One triple; IRIs and literals exactly as parsed. */
export interface PublicStatement {
  readonly subject: SparqlTerm;
  readonly predicate: SparqlTerm;
  readonly object: SparqlTerm;
}

export type PublicRdfFailure =
  | 'invalid-iri'
  | 'unsupported-scheme'
  | 'blocked-host'
  | 'redirect-blocked'
  | 'network'
  | 'timeout'
  | 'http-error'
  | 'too-large'
  | 'unsupported-type'
  | 'remote-context'
  | 'parse-failed';

export type PublicRdfResult =
  | {
      readonly kind: 'loaded';
      /** The document the statements came from (the IRI without fragment). */
      readonly source: string;
      readonly contentType: string;
      readonly statements: readonly PublicStatement[];
    }
  | { readonly kind: 'cancelled' }
  | {
      readonly kind: 'failed';
      readonly reason: PublicRdfFailure;
      /** The HTTP status for `http-error`. */
      readonly status?: number;
    };

export type PublicAddress =
  | { readonly kind: 'allowed'; readonly url: URL }
  | {
      readonly kind: 'failed';
      readonly reason: 'invalid-iri' | 'unsupported-scheme' | 'blocked-host';
    };

const RDF_LANG_STRING = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString';
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';

const N3_TYPES = new Set([
  'text/turtle',
  'application/n-triples',
  'application/n-quads',
  'application/trig',
]);
const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml']);

/**
 * Whether an IRI may be looked up: `https:` without user info, on a host that
 * is neither local nor a private, loopback or link-local address literal.
 * Hostnames are not resolved, so a public name that resolves to a private
 * address (DNS rebinding) is not caught. Use it to decide whether to offer the
 * lookup at all.
 */
export function publicAddress(iri: string): PublicAddress {
  let url: URL;
  try {
    url = new URL(iri);
  } catch {
    return { kind: 'failed', reason: 'invalid-iri' };
  }
  if (url.protocol !== 'https:')
    return { kind: 'failed', reason: 'unsupported-scheme' };
  if (url.username || url.password || blockedHost(url.hostname))
    return { kind: 'failed', reason: 'blocked-host' };
  return { kind: 'allowed', url };
}

/**
 * Fetch and parse the public RDF document at `iri`, once. Sends no cookies,
 * `Authorization` or referrer, follows no redirect and never loads a remote
 * JSON-LD context. Statements keep the IRI's exact identity.
 */
export async function lookupPublicRdf(
  iri: string,
  options: PublicRdfOptions = {},
): Promise<PublicRdfResult> {
  const address = publicAddress(iri);
  if (address.kind === 'failed') return address;
  // A fragment is never sent; the document is the IRI without it.
  const document = new URL(address.url);
  document.hash = '';
  const url = document.href;
  const outer = options.signal;
  if (outer?.aborted) return { kind: 'cancelled' };

  // One deadline for headers and body: an origin may answer the headers and
  // then drip the body forever.
  const deadline = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    deadline.abort();
  }, options.timeoutMs ?? PUBLIC_RDF_TIMEOUT_MS);
  const cancel = () => deadline.abort();
  outer?.addEventListener('abort', cancel, { once: true });
  const stopped = (): PublicRdfResult | null =>
    outer?.aborted
      ? { kind: 'cancelled' }
      : timedOut
        ? { kind: 'failed', reason: 'timeout' }
        : null;

  try {
    let response: Response;
    try {
      response = await (options.fetch ?? globalThis.fetch)(url, {
        method: 'GET',
        headers: { accept: PUBLIC_RDF_ACCEPT },
        credentials: 'omit',
        redirect: 'manual',
        referrerPolicy: 'no-referrer',
        mode: 'cors',
        signal: deadline.signal,
      });
    } catch {
      // A browser reports a CORS refusal like an unreachable host.
      return stopped() ?? { kind: 'failed', reason: 'network' };
    }

    // `manual` yields an opaque redirect in browsers and the raw 3xx in Node;
    // either way the target is never requested.
    if (
      response.type === 'opaqueredirect' ||
      response.redirected ||
      (response.status >= 300 && response.status < 400) ||
      (response.url !== '' && response.url !== url)
    ) {
      discard(response);
      return { kind: 'failed', reason: 'redirect-blocked' };
    }
    if (response.status !== 200) {
      discard(response);
      return { kind: 'failed', reason: 'http-error', status: response.status };
    }
    const maxBytes = options.maxBytes ?? PUBLIC_RDF_MAX_BYTES;
    if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
      discard(response);
      return { kind: 'failed', reason: 'too-large' };
    }
    const contentType = mediaType(response.headers.get('content-type'));
    if (
      !N3_TYPES.has(contentType) &&
      !isJsonLd(contentType) &&
      !HTML_TYPES.has(contentType)
    ) {
      discard(response);
      return { kind: 'failed', reason: 'unsupported-type' };
    }

    const body = await readCapped(response, maxBytes);
    if (body.kind === 'too-large')
      return { kind: 'failed', reason: 'too-large' };
    if (body.kind === 'broken')
      return stopped() ?? { kind: 'failed', reason: 'network' };

    const parsed = await parse(
      body.text,
      contentType,
      url,
      options.contexts ?? {},
    );
    // Parsing is bounded by the byte cap, not by the deadline.
    const late = stopped();
    if (late?.kind === 'cancelled') return late;
    if (typeof parsed === 'string') return { kind: 'failed', reason: parsed };
    return { kind: 'loaded', source: url, contentType, statements: parsed };
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', cancel);
  }
}

function mediaType(header: string | null): string {
  return (header ?? '').split(';')[0]!.trim().toLowerCase();
}

function isJsonLd(contentType: string): boolean {
  return contentType === 'application/ld+json';
}

function discard(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

/**
 * UTF-8 text of at most `maxBytes`, whatever `Content-Length` claimed. RDF
 * serializations are UTF-8; a `charset` parameter is ignored.
 */
async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<
  | { readonly kind: 'read'; readonly text: string }
  | { readonly kind: 'too-large' }
  | { readonly kind: 'broken' }
> {
  if (!response.body) return { kind: 'read', text: '' };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => {});
        return { kind: 'too-large' };
      }
      chunks.push(value);
    }
  } catch {
    return { kind: 'broken' };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: 'read', text: new TextDecoder().decode(bytes) };
}

type ParseFailure = 'remote-context' | 'parse-failed' | 'unsupported-type';

async function parse(
  body: string,
  contentType: string,
  base: string,
  contexts: Readonly<Record<string, unknown>>,
): Promise<readonly PublicStatement[] | ParseFailure> {
  if (N3_TYPES.has(contentType)) {
    try {
      const { Parser } = await import('n3');
      return statements(
        new Parser({ format: contentType, baseIRI: base }).parse(body),
      );
    } catch {
      return 'parse-failed';
    }
  }
  if (isJsonLd(contentType)) return jsonLd([body], base, contexts);
  // DOMParser builds an inert document: no script runs, nothing loads.
  if (typeof DOMParser === 'undefined') return 'unsupported-type';
  const page = new DOMParser().parseFromString(body, 'text/html');
  const scripts = Array.from(
    page.querySelectorAll('script[type]'),
    (script) =>
      [
        mediaType(script.getAttribute('type')),
        script.textContent ?? '',
      ] as const,
  )
    .filter(([type]) => isJsonLd(type))
    .map(([, text]) => text);
  return jsonLd(scripts, base, contexts);
}

/**
 * All documents as one: JSON-LD 1.1 merges the scripts of an HTML page into one
 * dataset, and the same blank node label in two scripts names one node. Each
 * script keeps its own `@context`.
 */
async function jsonLd(
  documents: readonly string[],
  base: string,
  contexts: Readonly<Record<string, unknown>>,
): Promise<readonly PublicStatement[] | ParseFailure> {
  const nodes: object[] = [];
  try {
    for (const text of documents) {
      const value: unknown = JSON.parse(text);
      // A top-level string would be loaded as a URL; only data is accepted.
      if (typeof value !== 'object' || value === null) return 'parse-failed';
      if (Array.isArray(value)) nodes.push(...(value as object[]));
      else nodes.push(value);
    }
  } catch {
    return 'parse-failed';
  }
  if (nodes.length === 0) return [];
  const { default: jsonld } = await import('jsonld');
  let remote = false;
  const documentLoader = async (url: string): Promise<RemoteDocument> => {
    if (!Object.hasOwn(contexts, url)) {
      remote = true;
      throw new Error(`Remote JSON-LD context refused: ${url}`);
    }
    return {
      documentUrl: url,
      document: contexts[url] as RemoteDocument['document'],
    };
  };
  try {
    const quads = await jsonld.toRDF(
      nodes as Parameters<typeof jsonld.toRDF>[0],
      {
        base,
        documentLoader,
        // Keeps `@direction` as an i18n datatype instead of dropping it.
        rdfDirection: 'i18n-datatype',
      } as Options.ToRdf,
    );
    return statements(quads as unknown as readonly Quad[]);
  } catch {
    return remote ? 'remote-context' : 'parse-failed';
  }
}

/** The RDF/JS fields both parsers produce. */
interface Quad {
  readonly subject: Term;
  readonly predicate: Term;
  readonly object: Term;
}
interface Term {
  readonly termType: string;
  readonly value: string;
  readonly language?: string;
  readonly direction?: string;
  readonly datatype?: { readonly value: string };
  /** Parts of an RDF 1.2 triple term (`termType: 'Quad'`). */
  readonly subject?: Term;
  readonly predicate?: Term;
  readonly object?: Term;
}

/** Graph names are dropped; a triple in several graphs is kept once. */
function statements(quads: readonly Quad[]): readonly PublicStatement[] {
  const seen = new Set<string>();
  const result: PublicStatement[] = [];
  for (const quad of quads) {
    const statement = {
      subject: term(quad.subject),
      predicate: term(quad.predicate),
      object: term(quad.object),
    };
    const key = JSON.stringify(statement);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(statement);
  }
  return result;
}

const I18N = 'https://www.w3.org/ns/i18n#';

/** A literal keeps its lexical form and tags; other terms stay whole. */
function term(value: Term): SparqlTerm {
  if (value.termType === 'NamedNode')
    return { type: 'iri', value: value.value };
  if (value.termType === 'BlankNode')
    return { type: 'blank', value: value.value.replace(/^_:/, '') };
  if (value.termType !== 'Literal' || direction(value))
    // A triple term or a base direction changes the term's identity; keep it
    // whole, in SPARQL 1.2 JSON form, instead of flattening it.
    return { type: 'unsupported', term: sparqlJson(value) };
  if (value.language)
    return { type: 'literal', value: value.value, language: value.language };
  const datatype = value.datatype?.value;
  return datatype && datatype !== XSD_STRING && datatype !== RDF_LANG_STRING
    ? { type: 'literal', value: value.value, datatype }
    : { type: 'literal', value: value.value };
}

/** Turtle's `@en--ltr`, or JSON-LD's `@direction` as an i18n datatype. */
function direction(value: Term): { language: string; dir: string } | undefined {
  if (value.direction)
    return { language: value.language ?? '', dir: value.direction };
  const datatype = value.datatype?.value;
  if (!datatype?.startsWith(I18N)) return undefined;
  const [language = '', dir = ''] = datatype.slice(I18N.length).split('_');
  return { language, dir };
}

function sparqlJson(value: Term): Readonly<Record<string, unknown>> {
  switch (value.termType) {
    case 'NamedNode':
      return { type: 'uri', value: value.value };
    case 'BlankNode':
      return { type: 'bnode', value: value.value.replace(/^_:/, '') };
    case 'Literal': {
      const tags = direction(value);
      if (tags)
        return {
          type: 'literal',
          value: value.value,
          ...(tags.language ? { 'xml:lang': tags.language } : {}),
          'its:dir': tags.dir,
        };
      return {
        type: 'literal',
        value: value.value,
        ...(value.language
          ? { 'xml:lang': value.language }
          : value.datatype && value.datatype.value !== XSD_STRING
            ? { datatype: value.datatype.value }
            : {}),
      };
    }
    case 'Quad':
      return {
        type: 'triple',
        value: {
          subject: sparqlJson(value.subject!),
          predicate: sparqlJson(value.predicate!),
          object: sparqlJson(value.object!),
        },
      };
    default:
      return { type: value.termType, value: value.value };
  }
}

function blockedHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '');
  if (host.includes(':')) return blockedIpv6(host);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return blockedIpv4(host);
  // A single label (`intranet`) or a local suffix never names a public origin.
  return (
    !host.includes('.') ||
    /(^|\.)(localhost|localdomain|local|internal|home\.arpa)$/.test(host)
  );
}

/** `URL` already turned decimal, octal and hex forms into dotted quads. */
function blockedIpv4(host: string): boolean {
  const [a, b, c] = host.split('.').map(Number) as [number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

/** `URL` already compressed the literal, for example `::ffff:7f00:1`. */
function blockedIpv6(host: string): boolean {
  const [head = '', tail] = host.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const fill =
    tail === undefined ? [] : Array(8 - left.length - right.length).fill('0');
  const h = [...left, ...fill, ...right].map((part) => parseInt(part, 16));
  const ipv4 = (high: number, low: number) =>
    blockedIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  const zero = (from: number, to: number) =>
    h.slice(from, to).every((part) => part === 0);
  return (
    // Unique local fc00::/7, link-local fe80::/10, site-local fec0::/10.
    (h[0]! & 0xfe00) === 0xfc00 ||
    (h[0]! >= 0xfe80 && h[0]! <= 0xfeff) ||
    // Multicast ff00::/8.
    h[0]! >> 8 === 0xff ||
    // Local-use NAT64 64:ff9b:1::/48.
    (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 1) ||
    // Unspecified, loopback, IPv4-compatible and IPv4-mapped (::/96, ::ffff:0:0/96).
    (zero(0, 5) && (h[5] === 0 || h[5] === 0xffff) && ipv4(h[6]!, h[7]!)) ||
    // IPv4-translated ::ffff:0:0:0/96.
    (zero(0, 4) && h[4] === 0xffff && h[5] === 0 && ipv4(h[6]!, h[7]!)) ||
    // NAT64 64:ff9b::/96.
    (h[0] === 0x64 && h[1] === 0xff9b && zero(2, 6) && ipv4(h[6]!, h[7]!)) ||
    // 6to4 2002::/16.
    (h[0] === 0x2002 && ipv4(h[1]!, h[2]!))
  );
}
