import { isContextIri } from './catalogue.js';
import { canonical, deepFreeze } from './edit/terms.js';
import { requestFailure } from './errors.js';
import { ABSOLUTE_IRI, RDF_TYPE } from './iri.js';
import type {
  FindDetail,
  FindGraph,
  FindLink,
  FindObservation,
  FlatFindGraph,
  JsonLd,
} from './results.js';

/** `sps:findResult` (SPS-FIND-028): links a hit to one observation. */
export const FIND_RESULT = 'https://schema.sempods.org/findResult';
const SCHEMA_TEXT = 'https://schema.org/text';
const SCHEMA_POSITION = 'https://schema.org/position';
const SPS_ENGINE = 'https://schema.sempods.org/engine';

/*
 * A Find answer is read by the RDF it encodes, not by its JSON shape: the
 * document becomes quads first, so every serialization of one dataset
 * (embedded or separate nodes, `@reverse`, `@set`, `@list`, `@included`,
 * scalar or array values) gives the same result. The decoders then apply
 * the Find rules to the quads, and `nodes` and the observations are built
 * from them.
 */

type Subject =
  | { readonly kind: 'iri'; readonly value: string }
  | { readonly kind: 'blank'; readonly id: string };
type Term =
  | Subject
  | { readonly kind: 'literal'; readonly value: JsonLd }
  /** A non-empty list is its own collection; `id` keeps two apart. */
  | {
      readonly kind: 'list';
      readonly items: readonly Term[];
      readonly id: number;
    };
/** `undefined` is the default graph. */
type Graph = string | undefined;
interface Quad {
  readonly s: Subject;
  readonly p: string;
  readonly o: Term;
  readonly g: Graph;
}

/**
 * Named-graph JSON-LD (SPS-FIND-027): every statement in a named graph that
 * is a Context of this Pod inside the requested downscope (SPS-FIND-010).
 * A statement in the default graph, a graph with a blank name, also a bare
 * observation, rejects the whole answer. Groups that name the same Context
 * merge.
 */
export function decodeGroupedFind(
  body: unknown,
  base: string,
  scope: readonly string[] | undefined,
): readonly FindGraph[] {
  const requested = scope && new Set(scope);
  const { quads, names, blankNamed } = read(body);
  if (
    blankNamed ||
    quads.some((quad) => quad.g === undefined) ||
    names.some(
      (name) =>
        !isContextIri(name, base) || (requested && !requested.has(name)),
    )
  )
    throw invalid();
  return Object.freeze(
    build(quads, names).map(({ graph, nodes, observations }) =>
      Object.freeze({ context: graph!, nodes, observations }),
    ),
  );
}

/**
 * A graph without graph names (SPS-FIND-026). Any named graph rejects the
 * answer, and so does any statement for an explicitly empty downscope.
 */
export function decodeFlatFind(
  body: unknown,
  scope: readonly string[] | undefined,
): FlatFindGraph {
  const { quads, names, blankNamed } = read(body);
  if (blankNamed || names.length > 0) throw invalid();
  if (scope?.length === 0 && quads.length > 0) throw invalid();
  const [{ nodes, observations }] = build(quads, [undefined]) as [Built];
  return Object.freeze({ nodes, observations });
}

/**
 * Expanded JSON-LD to quads (JSON-LD 1.1 toRdf for documents without an
 * active context). Named graphs are read where JSON-LD puts them, at the
 * top of the document; their names are kept in order, also of an empty
 * graph, because a group without statements still names a Context the
 * decoder must check. Blank-node labels are scoped to this answer.
 */
function read(body: unknown): {
  readonly quads: readonly Quad[];
  readonly names: readonly string[];
  readonly blankNamed: boolean;
} {
  const quads: Quad[] = [];
  const names: string[] = [];
  let blankNamed = false;
  const seen = new Set<string>();
  const subjects = new WeakMap<JsonLd, Subject>();
  let fresh = 0;
  let lists = 1;

  const emit = (s: Subject, p: string, o: Term, g: Graph): void => {
    const key = `${termKey(s)} ${p} ${termKey(o)} ${g ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      quads.push({ s, p, o, g });
    }
  };
  /** One subject per node object; one without `@id` is a fresh blank node. */
  const subjectOf = (value: JsonLd): Subject => {
    let subject = subjects.get(value);
    if (!subject) {
      const id = value['@id'];
      if (id !== undefined && typeof id !== 'string') throw invalid();
      subject =
        id === undefined ? { kind: 'blank', id: `f${fresh++}` } : reference(id);
      subjects.set(value, subject);
    }
    return subject;
  };
  /** A property value as a term, collecting the node objects it embeds. */
  const object = (value: unknown, embedded: JsonLd[]): Term | undefined => {
    if (Array.isArray(value)) throw invalid();
    if (!isNode(value))
      return value === null ? undefined : literal({ '@value': value });
    // Value objects and lists follow the same context rule as nodes.
    checkContext(value);
    if (Object.hasOwn(value, '@value')) {
      // A null value states nothing, except as a JSON literal.
      if (value['@value'] === null && value['@type'] !== '@json')
        return undefined;
      const rest = { ...value };
      delete rest['@index'];
      delete rest['@context'];
      return literal(rest);
    }
    if (Object.hasOwn(value, '@list')) {
      const items: Term[] = [];
      for (const item of list(value['@list'])) {
        const term = object(item, embedded);
        if (term) items.push(term);
      }
      return { kind: 'list', items, id: items.length > 0 ? lists++ : 0 };
    }
    embedded.push(value);
    return subjectOf(value);
  };
  /** One node object in `graph`; an embedded node follows its statement. */
  const node = (value: unknown, graph: Graph): void => {
    // A graph nested in a node is no part of a Find answer.
    if (!isNodeObject(value) || Object.hasOwn(value, '@graph')) throw invalid();
    checkContext(value);
    const subject = subjectOf(value);
    for (const [key, entry] of Object.entries(value)) {
      if (key === '@type') {
        for (const type of list(entry)) {
          if (typeof type !== 'string') throw invalid();
          emit(subject, RDF_TYPE, reference(type), graph);
        }
      } else if (key === '@reverse') {
        if (!isNode(entry)) throw invalid();
        for (const [predicate, values] of Object.entries(entry))
          for (const item of list(values)) {
            if (!isNodeObject(item)) throw invalid();
            if (isPredicate(predicate))
              emit(subjectOf(item), predicate, subject, graph);
            node(item, graph);
          }
      } else if (key === '@included') {
        for (const item of list(entry)) node(item, graph);
      } else if (!key.startsWith('@') && isPredicate(key)) {
        for (const item of list(entry)) {
          const embedded: JsonLd[] = [];
          const term = object(item, embedded);
          if (term) emit(subject, key, term, graph);
          for (const child of embedded) node(child, graph);
        }
      }
    }
  };
  /** A top-level item: a node of the default graph or a named graph. */
  const top = (value: unknown): void => {
    if (!isNodeObject(value)) throw invalid();
    if (!Object.hasOwn(value, '@graph')) return node(value, undefined);
    checkContext(value);
    // A named graph's own statements would sit in the default graph.
    if (Object.keys(value).some((key) => !GRAPH_KEYS.has(key))) throw invalid();
    const name = value['@id'];
    if (name !== undefined && typeof name !== 'string') throw invalid();
    if (name === undefined || name.startsWith('_:')) {
      blankNamed = true;
      return;
    }
    if (!names.includes(name)) names.push(name);
    for (const item of list(value['@graph'])) node(item, name);
  };

  if (
    isNode(body) &&
    Object.hasOwn(body, '@graph') &&
    Object.keys(body).every((key) => key === '@graph' || key === '@context')
  ) {
    // The top-level wrapper is the default graph; named graphs inside it
    // stay named.
    checkContext(body);
    list(body['@graph']).forEach(top);
  } else (Array.isArray(body) ? body : [body]).forEach(top);
  return { quads, names, blankNamed };
}

const GRAPH_KEYS = new Set(['@id', '@graph', '@context']);

function reference(id: string): Subject {
  return id.startsWith('_:')
    ? { kind: 'blank', id: `b${id.slice(2)}` }
    : { kind: 'iri', value: id };
}

interface Built {
  readonly graph: Graph;
  readonly nodes: readonly JsonLd[];
  readonly observations: readonly FindObservation[];
}

interface Building {
  readonly id: string;
  readonly links: FindLink[];
  readonly details: Map<Graph, Record<string, unknown>>;
}

/** Counts answers, so blank nodes of two answers never share a label. */
let answers = 0;

/**
 * Splits the quads into pod data and generated observations (SPS-FIND-028).
 * A blank node that an IRI links to with `sps:findResult` is an
 * observation; that link, the observation's own statements and statements
 * naming it as their object are find statements. An IRI value of
 * `sps:findResult` is a stored statement (SPS-FIND-027). Everything else is
 * pod data: one flattened node object per subject and graph, with `@type`
 * an array and every value an array of `{"@id"}`, `{"@value"}` or
 * `{"@list"}` objects. A hit appears as a node in each group that carries
 * its link, so a bare link still names it.
 */
function build(quads: readonly Quad[], graphs: readonly Graph[]): Built[] {
  const answer = answers++;
  const label = (id: string) => `_:a${answer}-${id}`;
  const idOf = (s: Subject) => (s.kind === 'iri' ? s.value : label(s.id));
  const value = (term: Term): JsonLd => {
    switch (term.kind) {
      case 'iri':
      case 'blank':
        return { '@id': idOf(term) };
      case 'literal':
        return term.value;
      case 'list':
        return { '@list': term.items.map(value) };
    }
  };
  const add = (node: Record<string, unknown>, p: string, o: Term): void => {
    if (p === RDF_TYPE && (o.kind === 'iri' || o.kind === 'blank'))
      ((node['@type'] ??= []) as string[]).push(idOf(o));
    else ((node[p] ??= []) as JsonLd[]).push(value(o));
  };

  const observed = new Map<string, Building>();
  for (const { s, p, o } of quads)
    if (
      s.kind === 'iri' &&
      p === FIND_RESULT &&
      o.kind === 'blank' &&
      !observed.has(o.id)
    )
      observed.set(o.id, { id: label(o.id), links: [], details: new Map() });
  const observationOf = (term: Term) =>
    term.kind === 'blank' ? observed.get(term.id) : undefined;
  const detailIn = (entry: Building, graph: Graph) => {
    let node = entry.details.get(graph);
    if (!node) entry.details.set(graph, (node = {}));
    return node;
  };

  const groups = new Map<Graph, Map<string, Record<string, unknown>>>(
    graphs.map((graph) => [graph, new Map()]),
  );
  const nodeIn = (graph: Graph, s: Subject): Record<string, unknown> => {
    const nodes = groups.get(graph)!;
    const key = termKey(s);
    let node = nodes.get(key);
    if (!node) nodes.set(key, (node = { '@id': idOf(s) }));
    return node;
  };

  for (const { s, p, o, g } of quads) {
    const target = observationOf(o);
    const source = observationOf(s);
    if (target && s.kind === 'iri' && p === FIND_RESULT) {
      target.links.push(
        Object.freeze(
          g === undefined ? { hit: s.value } : { hit: s.value, context: g },
        ),
      );
      nodeIn(g, s);
    } else if (source) {
      // Another observation is named by its `id`.
      add(detailIn(source, g), p, o);
    } else if (target) {
      // A statement that names an observation from the other side.
      const detail = detailIn(target, g);
      const reverse = (detail['@reverse'] ??= {}) as Record<string, JsonLd[]>;
      (reverse[p] ??= []).push(value(s));
    } else add(nodeIn(g, s), p, o);
  }

  const placed = new Map<Graph, FindObservation[]>(
    graphs.map((graph) => [graph, []]),
  );
  for (const entry of observed.values()) {
    const observation = freezeObservation(entry);
    const where = new Set<Graph>([
      ...entry.links.map((link) => link.context),
      ...entry.details.keys(),
    ]);
    for (const graph of where) placed.get(graph)!.push(observation);
  }
  return [...groups].map(([graph, nodes]) => ({
    graph,
    nodes: deepFreeze([...nodes.values()]) as readonly JsonLd[],
    observations: Object.freeze(placed.get(graph)!),
  }));
}

function freezeObservation(entry: Building): FindObservation {
  const details: readonly FindDetail[] = deepFreeze(
    [...entry.details].map(([graph, node]) =>
      graph === undefined ? { node } : { context: graph, node },
    ),
  );
  /** The `@value`s of a predicate across the details' canonical arrays. */
  const values = (predicate: string): unknown[] =>
    details.flatMap(({ node }) =>
      ((node[predicate] as readonly JsonLd[] | undefined) ?? []).map(
        (v) => v['@value'],
      ),
    );
  const strings = (predicate: string): string[] =>
    values(predicate).filter((v): v is string => typeof v === 'string');
  return Object.freeze({
    id: entry.id,
    links: Object.freeze([...entry.links]),
    details,
    text: Object.freeze(strings(SCHEMA_TEXT)),
    position: Object.freeze(values(SCHEMA_POSITION).flatMap(positionOf)),
    engine: Object.freeze(strings(SPS_ENGINE)),
  });
}

function termKey(term: Term): string {
  switch (term.kind) {
    case 'iri':
      return `<${term.value}>`;
    case 'blank':
      return `_:${term.id}`;
    case 'literal':
      // A JSON literal's payload is data: compared as JSON, keys sorted,
      // without the language-tag rules of RDF literals.
      return term.value['@type'] === '@json'
        ? `json:${jsonKey(term.value['@value'])}`
        : canonical(term.value);
    case 'list':
      // The empty list is rdf:nil; every other one has its own head node.
      return term.id === 0 ? '()' : `(#${term.id})`;
  }
}

/** JSON with object keys sorted, so equal payloads give equal keys. */
function jsonKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(jsonKey).join(',')}]`;
  if (isNode(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${jsonKey(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function literal(value: JsonLd): Term {
  return { kind: 'literal', value: Object.freeze(value) };
}

/** The values of a property, with `@set` wrappers unwrapped. */
function list(value: unknown): readonly unknown[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).flatMap((item: unknown) =>
    isNode(item) && Object.hasOwn(item, '@set') ? list(item['@set']) : [item],
  );
}

/** A node object: neither a value object nor a list. */
function isNodeObject(value: unknown): value is JsonLd {
  return isNode(value) && !('@value' in value) && !('@list' in value);
}

/** An absolute IRI; a relative key or a blank predicate states nothing. */
function isPredicate(key: string): boolean {
  return ABSOLUTE_IRI.test(key) && !key.startsWith('_:');
}

/**
 * The SDK reads expanded JSON-LD, as the Pod answers: a local `@context`
 * that could change what a key means rejects the answer rather than being
 * misread. `null`, `{}` and lists of them change nothing.
 */
function checkContext(node: JsonLd): void {
  if (Object.hasOwn(node, '@context') && !inert(node['@context']))
    throw invalid();
}

function inert(context: unknown): boolean {
  return (
    context === null ||
    (isNode(context) && Object.keys(context).length === 0) ||
    (Array.isArray(context) && context.every(inert))
  );
}

/** A 1-based position; other values stay in `details` only. */
function positionOf(lexical: unknown): readonly number[] {
  const number =
    typeof lexical === 'number'
      ? lexical
      : typeof lexical === 'string' && /^[+-]?\d+$/.test(lexical.trim())
        ? Number(lexical)
        : Number.NaN;
  return Number.isSafeInteger(number) && number > 0 ? [number] : [];
}

/** A JSON object, not an array. */
export function isNode(value: unknown): value is JsonLd {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid() {
  return requestFailure({ code: 'response', problem: 'body' });
}
