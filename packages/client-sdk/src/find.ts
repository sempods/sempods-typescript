import { isContextIri } from './catalogue.js';
import { SdkError } from './errors.js';
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
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SCHEMA_TEXT = 'https://schema.org/text';
const SCHEMA_POSITION = 'https://schema.org/position';
const SPS_ENGINE = 'https://schema.sempods.org/engine';

/*
 * A Find answer is read by the RDF it encodes, not by its JSON shape: the
 * document becomes quads first, so every serialization of one dataset
 * (embedded or separate nodes, `@reverse`, `@set`, `@list`, `@included`,
 * scalar or array values) gives the same result. `nodes` and the
 * observations are then built from those quads.
 */

type Subject =
  | { readonly kind: 'iri'; readonly value: string }
  | { readonly kind: 'blank'; readonly id: string };
type Term =
  | Subject
  | { readonly kind: 'literal'; readonly value: JsonLd }
  | { readonly kind: 'list'; readonly items: readonly Term[] };
/** `undefined` is the default graph. */
type Graph = string | undefined;
interface Quad {
  readonly s: Subject;
  readonly p: string;
  readonly o: Term;
  readonly g: Graph;
}

/**
 * Named-graph JSON-LD (SPS-FIND-027): one group object or an array of them,
 * each naming a Context of this Pod inside the requested downscope
 * (SPS-FIND-010). A statement in the default graph or a graph with a blank
 * name, also a bare observation, rejects the whole answer, and so does a
 * graph nested below a group. Groups that name the same Context merge.
 */
export function decodeGroupedFind(
  body: unknown,
  base: string,
  scope: readonly string[] | undefined,
): readonly FindGraph[] {
  const requested = scope && new Set(scope);
  const reader = new Reader(true);
  reader.document(body);
  for (const name of reader.names)
    if (
      name === undefined ||
      !isContextIri(name, base) ||
      (requested && !requested.has(name))
    )
      throw invalid();
  if (reader.quads.some((quad) => quad.g === undefined)) throw invalid();
  return Object.freeze(
    build(reader.quads, reader.names).map(({ graph, nodes, observations }) =>
      Object.freeze({ context: graph as string, nodes, observations }),
    ),
  );
}

/**
 * A graph without graph names (SPS-FIND-026): node objects, one node object
 * or a default-graph `{"@graph": …}`. Any named graph rejects the answer,
 * and so does any statement for an explicitly empty downscope.
 */
export function decodeFlatFind(
  body: unknown,
  scope: readonly string[] | undefined,
): FlatFindGraph {
  const reader = new Reader(false);
  reader.document(body);
  if (scope?.length === 0 && reader.quads.length > 0) throw invalid();
  const [built] = build(reader.quads, [undefined]);
  return Object.freeze({
    nodes: built!.nodes,
    observations: built!.observations,
  });
}

/**
 * Expanded JSON-LD to quads (JSON-LD 1.1 toRdf for documents without an
 * active context). Blank-node labels are scoped to this answer.
 */
class Reader {
  readonly quads: Quad[] = [];
  /** Named graphs in order of appearance; a blank name is `undefined`. */
  readonly names: Graph[] = [];
  private readonly seen = new Set<string>();
  private readonly subjects = new WeakMap<JsonLd, Subject>();
  /** Embedded nodes read after the statement that embeds them. */
  private readonly pending: (() => void)[] = [];
  private fresh = 0;

  constructor(private readonly grouped: boolean) {}

  document(body: unknown): void {
    if (
      isNode(body) &&
      Object.hasOwn(body, '@graph') &&
      Object.keys(body).every((key) => key === '@graph' || key === '@context')
    ) {
      // The top-level wrapper is the default graph; named graphs inside it
      // stay named.
      checkContext(body);
      for (const node of list(body['@graph'])) this.top(node);
    } else
      for (const node of Array.isArray(body) ? body : [body]) this.top(node);
  }

  private top(value: unknown): void {
    if (!isNodeObject(value)) throw invalid();
    if (!Object.hasOwn(value, '@graph')) {
      this.node(value, undefined);
      return;
    }
    // A named graph: a group states nothing about itself.
    if (!this.grouped || !Object.keys(value).every(isGroupKey)) throw invalid();
    checkContext(value);
    const own = value['@id'];
    if (own !== undefined && typeof own !== 'string') throw invalid();
    const name = own === undefined || own.startsWith('_:') ? undefined : own;
    if (!this.names.includes(name)) this.names.push(name);
    if (name === undefined) throw invalid();
    for (const node of list(value['@graph'])) this.node(node, name);
  }

  /** One node object in `graph`, also every node object it embeds. */
  private node(value: unknown, graph: Graph): void {
    if (!isNodeObject(value) || Object.hasOwn(value, '@graph')) throw invalid();
    checkContext(value);
    const subject = this.subjectOf(value);
    for (const [key, entry] of Object.entries(value)) {
      if (key === '@type') {
        for (const type of list(entry)) {
          if (typeof type !== 'string') throw invalid();
          this.emit(subject, RDF_TYPE, reference(type), graph);
        }
      } else if (key === '@reverse') {
        if (!isNode(entry)) throw invalid();
        for (const [predicate, values] of Object.entries(entry))
          for (const item of list(values)) {
            if (!isNodeObject(item)) throw invalid();
            if (isPredicate(predicate))
              this.emit(this.subjectOf(item), predicate, subject, graph);
            this.node(item, graph);
          }
      } else if (key === '@included') {
        for (const item of list(entry)) this.node(item, graph);
      } else if (!key.startsWith('@') && isPredicate(key)) {
        for (const item of list(entry)) {
          const object = this.object(item, graph);
          if (object) this.emit(subject, key, object, graph);
          else this.flush();
        }
      }
    }
  }

  /** A property value as a term; an embedded node object is read after it. */
  private object(value: unknown, graph: Graph): Term | undefined {
    if (Array.isArray(value)) throw invalid();
    if (!isNode(value))
      return value === null ? undefined : literal({ '@value': value });
    if (Object.hasOwn(value, '@value')) {
      if (value['@value'] === null) return undefined;
      const rest = { ...value };
      delete rest['@index'];
      return literal(rest);
    }
    if (Object.hasOwn(value, '@list')) {
      const items: Term[] = [];
      for (const item of list(value['@list'])) {
        const term = this.object(item, graph);
        if (term) items.push(term);
      }
      return { kind: 'list', items };
    }
    const subject = this.subjectOf(value);
    this.pending.push(() => this.node(value, graph));
    return subject;
  }

  private emit(s: Subject, p: string, o: Term, g: Graph): void {
    const key = JSON.stringify([termKey(s), p, termKey(o), g ?? null]);
    if (!this.seen.has(key)) {
      this.seen.add(key);
      this.quads.push({ s, p, o, g });
    }
    this.flush();
  }

  private flush(): void {
    for (const run of this.pending.splice(0)) run();
  }

  /** One subject per node object; one without `@id` is a fresh blank node. */
  private subjectOf(value: JsonLd): Subject {
    let subject = this.subjects.get(value);
    if (!subject) {
      const id = value['@id'];
      if (id !== undefined && typeof id !== 'string') throw invalid();
      subject =
        id === undefined
          ? { kind: 'blank', id: `f${this.fresh++}` }
          : reference(id);
      this.subjects.set(value, subject);
    }
    return subject;
  }
}

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
  readonly graphs: Set<Graph>;
  readonly details: Map<Graph, Record<string, unknown>>;
}

/** Counts answers, so pod blank nodes of two answers never share a label. */
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
  const observed = new Map<string, Building>();
  for (const { s, p, o } of quads)
    if (
      s.kind === 'iri' &&
      p === FIND_RESULT &&
      o.kind === 'blank' &&
      !observed.has(o.id)
    )
      observed.set(o.id, {
        id: label(o.id),
        links: [],
        graphs: new Set(),
        details: new Map(),
      });
  const isObservation = (term: Term): term is Subject & { kind: 'blank' } =>
    term.kind === 'blank' && observed.has(term.id);

  const value = (term: Term): JsonLd => {
    switch (term.kind) {
      case 'iri':
        return { '@id': term.value };
      case 'blank':
        return { '@id': label(term.id) };
      case 'literal':
        return term.value;
      case 'list':
        return { '@list': term.items.map(value) };
    }
  };
  const add = (node: Record<string, unknown>, p: string, o: Term): void => {
    if (p === RDF_TYPE && (o.kind === 'iri' || o.kind === 'blank'))
      ((node['@type'] ??= []) as string[]).push(value(o)['@id'] as string);
    else ((node[p] ??= []) as JsonLd[]).push(value(o));
  };

  const groups = new Map<Graph, Map<string, Record<string, unknown>>>();
  for (const graph of graphs) groups.set(graph, new Map());
  const nodeIn = (graph: Graph, s: Subject): Record<string, unknown> => {
    let nodes = groups.get(graph);
    if (!nodes) groups.set(graph, (nodes = new Map()));
    const key = termKey(s);
    let node = nodes.get(key);
    if (!node) nodes.set(key, (node = { '@id': value(s)['@id'] }));
    return node;
  };
  const detailIn = (entry: Building, graph: Graph) => {
    let node = entry.details.get(graph);
    if (!node) entry.details.set(graph, (node = {}));
    entry.graphs.add(graph);
    return node;
  };

  for (const { s, p, o, g } of quads) {
    if (s.kind === 'iri' && p === FIND_RESULT && isObservation(o)) {
      const entry = observed.get(o.id)!;
      entry.links.push(
        Object.freeze(
          g === undefined ? { hit: s.value } : { hit: s.value, context: g },
        ),
      );
      entry.graphs.add(g);
      nodeIn(g, s);
    } else if (isObservation(s)) {
      // Another observation is named by its `id`.
      add(detailIn(observed.get(s.id)!, g), p, o);
    } else if (isObservation(o)) {
      // A statement that names an observation from the other side.
      const detail = detailIn(observed.get(o.id)!, g);
      const reverse = (detail['@reverse'] ??= {}) as Record<string, JsonLd[]>;
      (reverse[p] ??= []).push(value(s));
    } else add(nodeIn(g, s), p, o);
  }

  const observations = [...observed.values()].map((entry) => ({
    entry,
    observation: freezeObservation(entry),
  }));
  return [...groups].map(([graph, nodes]) => ({
    graph,
    nodes: Object.freeze([...nodes.values()].map(freezeNode)),
    observations: Object.freeze(
      observations
        .filter(({ entry }) => entry.graphs.has(graph))
        .map(({ observation }) => observation),
    ),
  }));
}

function freezeNode(node: Record<string, unknown>): JsonLd {
  for (const value of Object.values(node))
    if (Array.isArray(value)) Object.freeze(value);
    else if (isNode(value)) freezeNode(value as Record<string, unknown>);
  return Object.freeze(node);
}

function freezeObservation(entry: Building): FindObservation {
  const details: readonly FindDetail[] = Object.freeze(
    [...entry.details].map(([graph, node]) =>
      Object.freeze(
        graph === undefined
          ? { node: freezeNode(node) }
          : { context: graph, node: freezeNode(node) },
      ),
    ),
  );
  const values = (predicate: string) =>
    details.flatMap(({ node }) => list(node[predicate]));
  return Object.freeze({
    id: entry.id,
    links: Object.freeze([...entry.links]),
    details,
    text: Object.freeze(values(SCHEMA_TEXT).flatMap(stringOf)),
    position: Object.freeze(values(SCHEMA_POSITION).flatMap(positionOf)),
    engine: Object.freeze(values(SPS_ENGINE).flatMap(stringOf)),
  });
}

function termKey(term: Term): string {
  switch (term.kind) {
    case 'iri':
      return `<${term.value}>`;
    case 'blank':
      return `_:${term.id}`;
    case 'literal':
      return JSON.stringify(
        Object.keys(term.value)
          .sort()
          .map((key) => [key, term.value[key]]),
      );
    case 'list':
      return `(${term.items.map(termKey).join(' ')})`;
  }
}

function literal(value: JsonLd): Term {
  return { kind: 'literal', value: Object.freeze({ ...value }) };
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
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(key) && !key.startsWith('_:');
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

function stringOf(value: unknown): readonly string[] {
  const lexical = isNode(value) ? value['@value'] : value;
  return typeof lexical === 'string' ? [lexical] : [];
}

/** A 1-based position; other values stay in `details` only. */
function positionOf(value: unknown): readonly number[] {
  const lexical = isNode(value) ? value['@value'] : value;
  const number =
    typeof lexical === 'number'
      ? lexical
      : typeof lexical === 'string' && /^[+-]?\d+$/.test(lexical.trim())
        ? Number(lexical)
        : Number.NaN;
  return Number.isSafeInteger(number) && number > 0 ? [number] : [];
}

function isGroupKey(key: string): boolean {
  return key === '@id' || key === '@graph' || key === '@context';
}

function isNode(value: unknown): value is JsonLd {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(): SdkError {
  return new SdkError(
    { code: 'response', problem: 'body' },
    'Pod request failed: response.',
  );
}
