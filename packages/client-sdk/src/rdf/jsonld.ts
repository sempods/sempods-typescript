import { ABSOLUTE_IRI, RDF_TYPE } from '../iri.js';
import type { JsonLd } from '../results.js';
import {
  graphOf,
  isNode,
  LANGUAGE_TAG,
  quadKey,
  type Graph,
  type Quad,
  type Subject,
  type Term,
} from './terms.js';

/*
 * Expanded JSON-LD to RDF (internal): JSON-LD 1.1 toRdf for documents
 * without an active context, as Pods answer. The SDK ships no JSON-LD
 * processor (docs/decisions.md), so a local `@context` that could change
 * what a key means rejects the document rather than being misread.
 *
 * Where JSON-LD only drops or warns, this reader rejects: a free-floating
 * value, an ill-formed language tag and an array nested in an array.
 * Absolute IRIs are taken as given. The differences from the W3C toRdf suite are listed
 * in src/rdf/w3c-to-rdf.test.ts.
 */

/** A document this reader does not take; `code` names the JSON-LD error. */
export class JsonLdError extends Error {
  constructor(readonly code: string) {
    super(`Unsupported or invalid JSON-LD: ${code}.`);
    this.name = 'JsonLdError';
  }
}

export interface Dataset {
  /** Each quad once, in document order; lists stay list terms. */
  readonly quads: readonly Quad[];
  /**
   * Every graph name in document order, once, also of a graph without
   * statements: a group without statements still names a graph.
   */
  readonly graphs: readonly string[];
  /**
   * A graph object appears below the top level of the document: inside
   * another graph, as a property value, or under `@reverse` or `@included`.
   */
  readonly nested: boolean;
}

/**
 * The dataset of an expanded JSON-LD document, with `documentUrl` as the
 * base of relative references. Blank-node labels are scoped to the
 * document: `_:x` becomes the blank node `bx`, a node object without `@id`
 * a fresh one.
 */
export function fromJsonLd(body: unknown, documentUrl: string): Dataset {
  const quads: Quad[] = [];
  const graphs: string[] = [];
  let nested = false;
  const seen = new Set<string>();
  const subjects = new WeakMap<JsonLd, Subject>();
  let fresh = 0;
  let lists = 1;

  const emit = (quad: Quad): void => {
    const key = quadKey(quad);
    if (!seen.has(key)) {
      seen.add(key);
      quads.push(quad);
    }
  };
  /** One subject per node object; one without `@id` is a fresh blank node. */
  const subjectOf = (value: JsonLd): Subject => {
    let subject = subjects.get(value);
    if (!subject) {
      const id = value['@id'];
      if (id !== undefined && typeof id !== 'string')
        throw new JsonLdError('invalid @id value');
      subject =
        id === undefined
          ? { kind: 'blank', id: `f${fresh++}` }
          : reference(id, documentUrl);
      subjects.set(value, subject);
    }
    return subject;
  };
  /** A property value as a term, collecting the node objects it embeds. */
  const object = (value: unknown, embedded: JsonLd[]): Term | undefined => {
    if (Array.isArray(value)) throw new JsonLdError('nested array');
    if (!isNode(value))
      return value === null ? undefined : literal({ '@value': value });
    // Value objects and lists follow the same context rule as nodes.
    checkContext(value);
    checkIndex(value);
    if (Object.hasOwn(value, '@value')) return valueObject(value);
    if (Object.hasOwn(value, '@list')) {
      onlyKeys(value, LIST_KEYS, 'invalid set or list object');
      const items: Term[] = [];
      const raw = value['@list'];
      // JSON-LD reads a set in a list as a nested list; so would an array.
      if (
        Array.isArray(raw) &&
        raw.some((item) => isNode(item) && Object.hasOwn(item, '@set'))
      )
        throw new JsonLdError('nested array');
      for (const item of values(raw)) {
        const term = object(item, embedded);
        if (term) items.push(term);
      }
      return { kind: 'list', items, id: items.length > 0 ? lists++ : 0 };
    }
    embedded.push(value);
    return subjectOf(value);
  };
  /** One node object in `graph`; an embedded node follows its statement. */
  const node = (value: unknown, graph: Graph, top: boolean): void => {
    if (!isNodeObject(value)) throw new JsonLdError('free-floating value');
    checkContext(value);
    checkIndex(value);
    const subject = subjectOf(value);
    properties(value, subject, graph);
    if (!Object.hasOwn(value, '@graph')) return;
    // A node with `@graph` names a graph: by its `@id`, or a blank node.
    if (!top) nested = true;
    const name = graphOf(subject);
    if (!graphs.includes(name)) graphs.push(name);
    for (const item of values(value['@graph'])) node(item, name, false);
  };
  /** The statements of a node object or of a `@nest` object inside it. */
  const properties = (value: JsonLd, subject: Subject, graph: Graph) => {
    for (const [key, entry] of Object.entries(value)) {
      if (key === '@type') {
        for (const type of values(entry)) {
          if (typeof type !== 'string')
            throw new JsonLdError('invalid type value');
          emit({
            s: subject,
            p: RDF_TYPE,
            o: reference(type, documentUrl),
            g: graph,
          });
        }
      } else if (key === '@reverse') {
        if (!isNode(entry)) throw new JsonLdError('invalid @reverse value');
        checkContext(entry);
        for (const [predicate, items] of Object.entries(entry)) {
          if (predicate.startsWith('@') && predicate !== '@context')
            throw new JsonLdError('invalid reverse property map');
          // An unmapped reverse property states nothing, nor does its value.
          if (!isPredicate(predicate)) continue;
          for (const item of values(items)) {
            if (!isNodeObject(item))
              throw new JsonLdError('invalid reverse property value');
            emit({ s: subjectOf(item), p: predicate, o: subject, g: graph });
            node(item, graph, false);
          }
        }
      } else if (key === '@included') {
        for (const item of values(entry)) {
          if (!isNodeObject(item))
            throw new JsonLdError('invalid @included value');
          node(item, graph, false);
        }
      } else if (key === '@nest') {
        // Nested properties belong to the containing node.
        for (const inner of values(entry)) {
          // `@id` and `@graph` would describe the containing node itself.
          if (
            !isNodeObject(inner) ||
            Object.hasOwn(inner, '@id') ||
            Object.hasOwn(inner, '@graph')
          )
            throw new JsonLdError('invalid @nest value');
          checkContext(inner);
          properties(inner, subject, graph);
        }
      } else if (!key.startsWith('@') && isPredicate(key)) {
        for (const item of values(entry)) {
          const embedded: JsonLd[] = [];
          const term = object(item, embedded);
          if (term) emit({ s: subject, p: key, o: term, g: graph });
          for (const child of embedded) node(child, graph, false);
        }
      }
    }
  };

  for (const item of topLevel(body)) node(item, undefined, true);
  return { quads, graphs, nested };
}

/**
 * The top-level items of a document. A top-level object with only `@graph`
 * wraps the default graph; the graphs inside it are top-level graphs.
 */
export function topLevel(body: unknown): readonly unknown[] {
  const wrapped =
    isNode(body) &&
    Object.hasOwn(body, '@graph') &&
    Object.keys(body).every((key) => key === '@graph' || key === '@context');
  if (wrapped) checkContext(body);
  return values(wrapped ? body['@graph'] : body);
}

/** The keys of a list object; `@index` is metadata toRdf ignores. */
const LIST_KEYS = new Set(['@list', '@index', '@context']);
const SET_KEYS = new Set(['@set', '@index', '@context']);
const VALUE_KEYS = new Set([
  '@value',
  '@type',
  '@language',
  '@direction',
  '@index',
  '@context',
]);

/** A value object as a literal; a null value states nothing, except as JSON. */
function valueObject(value: JsonLd): Term | undefined {
  onlyKeys(value, VALUE_KEYS, 'invalid value object');
  const native = value['@value'];
  const type = value['@type'];
  const language = value['@language'];
  const direction = value['@direction'];
  if (type !== undefined && (language !== undefined || direction !== undefined))
    throw new JsonLdError('invalid value object');
  if (type === '@json') return literal(withoutMetadata(value));
  // The keywords are checked also for a null value, as JSON-LD expands them.
  if (language !== undefined) {
    if (typeof language !== 'string')
      throw new JsonLdError('invalid language-tagged string');
    if (!LANGUAGE_TAG.test(language))
      throw new JsonLdError('ill-formed language tag');
  }
  if (direction !== undefined && direction !== 'ltr' && direction !== 'rtl')
    throw new JsonLdError('invalid base direction');
  if (type !== undefined) {
    if (Array.isArray(type) && type.every((t) => typeof t === 'string'))
      throw new JsonLdError('invalid typed value');
    if (typeof type !== 'string') throw new JsonLdError('invalid type value');
    if (!ABSOLUTE_IRI.test(type) || type.startsWith('_:'))
      throw new JsonLdError('invalid typed value');
  }
  if (native === null) return undefined;
  if (typeof native === 'object')
    throw new JsonLdError('invalid value object value');
  if (language !== undefined && typeof native !== 'string')
    throw new JsonLdError('invalid language-tagged value');
  return literal(withoutMetadata(value));
}

function withoutMetadata(value: JsonLd): JsonLd {
  const rest = { ...value };
  delete rest['@index'];
  delete rest['@context'];
  return rest;
}

/**
 * A node reference: a blank-node label, an absolute IRI as given (its
 * characters are not checked), or a relative reference resolved against the
 * document URL, as JSON-LD expansion does. One that cannot be resolved
 * rejects the document.
 */
function reference(id: string, documentUrl: string): Subject {
  if (id.startsWith('_:')) return { kind: 'blank', id: `b${id.slice(2)}` };
  if (SCHEME.test(id)) return { kind: 'iri', value: id };
  try {
    return { kind: 'iri', value: new URL(id, documentUrl).href };
  } catch {
    throw new JsonLdError('invalid IRI');
  }
}

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * An absolute IRI key states a property; a relative key, one with
 * whitespace or a blank-node predicate (generalized RDF) states nothing.
 */
function isPredicate(key: string): boolean {
  return ABSOLUTE_IRI.test(key) && !key.startsWith('_:');
}

function literal(value: JsonLd): Term {
  return { kind: 'literal', value: Object.freeze(value) };
}

/** The values of a property, with `@set` wrappers unwrapped. */
function values(value: unknown): readonly unknown[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).flatMap((item: unknown) => {
    if (!isNode(item) || !Object.hasOwn(item, '@set')) return [item];
    checkContext(item);
    checkIndex(item);
    onlyKeys(item, SET_KEYS, 'invalid set or list object');
    return values(item['@set']);
  });
}

/**
 * A node object: neither a value object, a list nor a set. A set that was
 * not unwrapped where JSON-LD allows one rejects rather than reading empty.
 */
function isNodeObject(value: unknown): value is JsonLd {
  return (
    isNode(value) &&
    !('@value' in value) &&
    !('@list' in value) &&
    !('@set' in value)
  );
}

function onlyKeys(value: JsonLd, keys: ReadonlySet<string>, code: string) {
  if (Object.keys(value).some((key) => !keys.has(key)))
    throw new JsonLdError(code);
}

function checkIndex(value: JsonLd): void {
  if (Object.hasOwn(value, '@index') && typeof value['@index'] !== 'string')
    throw new JsonLdError('invalid @index value');
}

/** `null`, `{}` and lists of them change nothing; any other context rejects. */
function checkContext(value: JsonLd): void {
  if (Object.hasOwn(value, '@context') && !inert(value['@context']))
    throw new JsonLdError('active context');
}

function inert(context: unknown): boolean {
  return (
    context === null ||
    (isNode(context) && Object.keys(context).length === 0) ||
    (Array.isArray(context) && context.every(inert))
  );
}
