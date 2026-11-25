import { isContextIri } from './catalogue.js';
import { deepFreeze } from './edit/terms.js';
import { requestFailure } from './errors.js';
import { fromJsonLd, JsonLdError, type Dataset } from './rdf/jsonld.js';
import { nodeMap } from './rdf/nodes.js';
import {
  lexical,
  listChain,
  XSD,
  type Graph,
  type Quad,
  type Subject,
  type Term,
} from './rdf/terms.js';
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
  const { quads, names } = read(body, base);
  if (
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
  base: string,
  scope: readonly string[] | undefined,
): FlatFindGraph {
  const { quads, names } = read(body, base);
  if (names.length > 0) throw invalid();
  if (scope?.length === 0 && quads.length > 0) throw invalid();
  const [{ nodes, observations }] = build(quads, [undefined]) as [Built];
  return Object.freeze({ nodes, observations });
}

/**
 * The answer's quads (JSON-LD 1.1 toRdf, with the Find URL as the document
 * base) and its graph names in order, also of an empty graph, because a
 * group without statements still names a Context the decoder must check.
 * Named graphs are groups only where JSON-LD puts them, at the top of the
 * document; one nested in a node, or with a blank name, rejects the answer.
 */
function read(
  body: unknown,
  base: string,
): { readonly quads: readonly Quad[]; readonly names: readonly string[] } {
  let dataset: Dataset;
  try {
    dataset = fromJsonLd(body, `${base}/_system/find`);
  } catch (error) {
    if (error instanceof JsonLdError) throw invalid();
    throw error;
  }
  const { graphs, nested } = dataset;
  if (nested || graphs.some((name) => name.startsWith('_:'))) throw invalid();
  let fresh = 0;
  const blank = (): Subject => ({ kind: 'blank', id: `l${fresh++}` });
  const quads = dataset.quads.flatMap((quad): readonly Quad[] => {
    const { p, o, g } = quad;
    if (p !== FIND_RESULT || o.kind !== 'list' || o.items.length === 0)
      return [quad];
    // A collection's head is a blank node: as the object of a link it is an
    // observation, so its rdf:first/rdf:rest chain is written out.
    const chain = listChain(o, g, blank);
    return [...chain.quads, { ...quad, o: chain.head }];
  });
  return { quads, names: graphs };
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
  // A random namespace per answer: blank nodes of two answers never share
  // a label, also across workers and copies of this module.
  const answer = crypto.randomUUID().replaceAll('-', '');
  const label = (id: string) => `_:a${answer}-${id}`;
  const map = nodeMap(label);
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

  for (const { s, p, o, g } of quads) {
    const target = observationOf(o);
    const source = observationOf(s);
    if (target && s.kind === 'iri' && p === FIND_RESULT) {
      target.links.push(
        Object.freeze(
          g === undefined ? { hit: s.value } : { hit: s.value, context: g },
        ),
      );
      map.node(g, s);
    } else if (source) {
      // Another observation is named by its `id`.
      map.add(detailIn(source, g), p, o);
    } else if (target) {
      // A statement that names an observation from the other side.
      const detail = detailIn(target, g);
      const reverse = (detail['@reverse'] ??= {}) as Record<string, JsonLd[]>;
      (reverse[p] ??= []).push(map.value(s));
    } else map.add(map.node(g, s), p, o);
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
  return graphs.map((graph) => ({
    graph,
    nodes: deepFreeze(map.nodes(graph)) as readonly JsonLd[],
    observations: Object.freeze(placed.get(graph)!),
  }));
}

function freezeObservation(entry: Building): FindObservation {
  const details: readonly FindDetail[] = deepFreeze(
    [...entry.details].map(([graph, node]) =>
      graph === undefined ? { node } : { context: graph, node },
    ),
  );
  /** The value objects of a predicate across the details' canonical arrays. */
  const values = (predicate: string): readonly JsonLd[] =>
    details.flatMap(
      ({ node }) => (node[predicate] as readonly JsonLd[] | undefined) ?? [],
    );
  /** Plain, `xsd:string` or language-tagged literals, by their RDF form. */
  const strings = (predicate: string): string[] =>
    values(predicate).flatMap((v) => {
      const rdf = lexical(v);
      const type = rdf['@type'];
      return typeof rdf['@value'] === 'string' &&
        (type === undefined || type === `${XSD}string`)
        ? [rdf['@value']]
        : [];
    });
  return Object.freeze({
    id: entry.id,
    links: Object.freeze([...entry.links]),
    details,
    text: Object.freeze(strings(SCHEMA_TEXT)),
    position: Object.freeze(values(SCHEMA_POSITION).flatMap(positionOf)),
    engine: Object.freeze(strings(SPS_ENGINE)),
  });
}

/** XSD datatypes whose values are integers. */
const INTEGERS = new Set(
  [
    'integer',
    'long',
    'int',
    'short',
    'byte',
    'nonNegativeInteger',
    'positiveInteger',
    'unsignedLong',
    'unsignedInt',
    'unsignedShort',
    'unsignedByte',
  ].map((name) => `${XSD}${name}`),
);

/**
 * A 1-based position: a native integer, or a string typed as an XSD
 * integer. Other values, also an untyped `"3"`, stay in `details` only.
 */
function positionOf(value: JsonLd): readonly number[] {
  const lexical = value['@value'];
  const type = value['@type'];
  const number =
    typeof lexical === 'number' &&
    (type === undefined || INTEGERS.has(type as string))
      ? lexical
      : typeof lexical === 'string' &&
          INTEGERS.has(type as string) &&
          /^[+-]?\d+$/.test(lexical)
        ? Number(lexical)
        : Number.NaN;
  return Number.isSafeInteger(number) && number > 0 ? [number] : [];
}

function invalid() {
  return requestFailure({ code: 'response', problem: 'body' });
}
