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
const SCHEMA_TEXT = 'https://schema.org/text';
const SCHEMA_POSITION = 'https://schema.org/position';
const SPS_ENGINE = 'https://schema.sempods.org/engine';

/**
 * Named-graph JSON-LD (SPS-FIND-027): one group object or an array of them,
 * each naming a Context of this Pod inside the requested downscope
 * (SPS-FIND-010). Graph membership follows the RDF the document encodes: a
 * statement in the default graph, under a blank graph name or in a graph
 * nested in a node, also a bare observation, makes the whole answer
 * untrusted. Serializations without statements, such as `{}`, are empty.
 */
export function decodeGroupedFind(
  body: unknown,
  base: string,
  scope: readonly string[] | undefined,
): readonly FindGraph[] {
  const requested = scope && new Set(scope);
  const groups: Group[] = [];
  for (const item of Array.isArray(body) ? body : [body]) {
    if (!isNode(item)) throw invalid();
    checkContext(item);
    if (!Object.hasOwn(item, '@graph')) {
      // A node of the default graph: allowed only while it states nothing.
      checkNode(item);
      if (hasStatements(item)) throw invalid();
      continue;
    }
    const context = item['@id'];
    const nodes = graphOf(item);
    if (!Object.keys(item).every(isGroupKey)) throw invalid();
    if (context === undefined && !Array.isArray(body)) {
      // The top-level wrapper is the default graph.
      if (nodes.some(hasStatements)) throw invalid();
      continue;
    }
    if (
      typeof context !== 'string' ||
      !isContextIri(context, base) ||
      (requested && !requested.has(context))
    )
      throw invalid();
    groups.push({ context, nodes });
  }
  return Object.freeze(
    observe(groups).map(({ context, nodes, observations }) =>
      Object.freeze({ context: context as string, nodes, observations }),
    ),
  );
}

/**
 * A graph without graph names (SPS-FIND-026): an array of node objects, one
 * node object, or a default-graph `{"@graph": …}`. A named graph, also one
 * nested in a node, rejects the answer, and so does any statement for an
 * explicitly empty downscope. Serializations without statements are empty.
 */
export function decodeFlatFind(
  body: unknown,
  scope: readonly string[] | undefined,
): FlatFindGraph {
  let nodes: readonly JsonLd[];
  if (Array.isArray(body)) {
    for (const item of body) checkNode(item);
    nodes = body as readonly JsonLd[];
  } else if (isNode(body) && Object.hasOwn(body, '@graph')) {
    checkContext(body);
    if (
      !Object.keys(body).every((key) => key === '@graph' || key === '@context')
    )
      throw invalid();
    nodes = graphOf(body);
  } else {
    checkNode(body);
    nodes = [body as JsonLd];
  }
  if (scope?.length === 0 && nodes.some(hasStatements)) throw invalid();
  const [decoded] = observe([{ context: undefined, nodes }]);
  return Object.freeze({
    nodes: decoded!.nodes,
    observations: decoded!.observations,
  });
}

interface Group {
  readonly context: string | undefined;
  readonly nodes: readonly JsonLd[];
}

interface Building {
  readonly links: FindLink[];
  readonly details: FindDetail[];
  readonly groups: Set<string | undefined>;
}

/** Marks an embedded observation that left its place for `details`. */
const MOVED = Symbol('moved');

/**
 * Separates generated observations from pod data across the whole answer,
 * also inside embedded node objects. A `sps:findResult` value that is a
 * blank node is an observation link; an IRI value is a stored statement and
 * stays (SPS-FIND-027). Blank-node labels identify one node within this
 * answer only: a link in one group and details in another are one
 * observation, and no label leaves this function, so two answers never
 * share an observation. A node without observations stays as answered.
 */
function observe(groups: readonly Group[]): readonly (Group & {
  readonly observations: readonly FindObservation[];
})[] {
  const labelled = new Map<string, Building>();
  const order: Building[] = [];
  const start = (): Building => {
    const entry: Building = { links: [], details: [], groups: new Set() };
    order.push(entry);
    return entry;
  };
  const discover = (node: JsonLd): void => {
    if (isHit(node))
      for (const value of findResults(node)) {
        const label = blankLabel(value);
        if (label && !labelled.has(label)) labelled.set(label, start());
      }
    // The same link, written from the observation with `@reverse`.
    const own = blankLabel(node);
    if (own && reverseHits(node).length > 0 && !labelled.has(own))
      labelled.set(own, start());
    for (const child of embedded(node)) discover(child);
  };
  for (const { nodes } of groups) nodes.forEach(discover);

  const stripped = groups.map(({ context, nodes }) => {
    const item = (value: unknown): unknown => {
      if (!isNode(value) || '@value' in value) return value;
      for (const key of ['@list', '@set'])
        if (Object.hasOwn(value, key)) {
          const inner = values(value[key]);
          return inner === value[key] ? value : { ...value, [key]: inner };
        }
      const own = blankLabel(value);
      const observation =
        own === undefined
          ? undefined
          : own
            ? labelled.get(own)
            : reverseHits(value).length > 0
              ? start()
              : undefined;
      if (observation) {
        absorb(value, observation);
        return MOVED;
      }
      return strip(value);
    };
    /**
     * An observation node: its reverse `sps:findResult` links are links like
     * forward ones, and a hit they name is a node of this group.
     */
    const absorb = (value: JsonLd, entry: Building): void => {
      let node = value;
      const reverse = value['@reverse'];
      if (isNode(reverse) && Object.hasOwn(reverse, FIND_RESULT)) {
        const all = list(reverse[FIND_RESULT]);
        for (const hit of all.filter(isHitValue)) {
          entry.links.push(
            Object.freeze(
              context === undefined
                ? { hit: hit['@id'] }
                : { hit: hit['@id'], context },
            ),
          );
          entry.groups.add(context);
          const facts = without(hit, '@id');
          if (Object.keys(facts).length > 0) extra.push(strip(hit));
          else named.add(hit['@id']);
        }
        const rest = without(reverse, FIND_RESULT);
        const others = all.filter((v) => !isHitValue(v));
        const next =
          others.length > 0 ? { ...rest, [FIND_RESULT]: others } : rest;
        node =
          Object.keys(next).length > 0
            ? { ...value, '@reverse': next }
            : without(value, '@reverse');
      }
      node = settle(node);
      if (Object.keys(without(node, '@id')).length > 0) {
        entry.details.push(detail(context, node));
        entry.groups.add(context);
      }
    };
    /**
     * An observation's own statements. A resource it embeds is pod data: its
     * description moves to the group's nodes, as if written separately, and
     * a reference stays; embedded observations are extracted.
     */
    const settle = (node: JsonLd): JsonLd => {
      let changed = false;
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node)) {
        if (key === '@reverse' && isNode(value)) {
          // The same for resources that name the observation from their side.
          const reverse = settle(value);
          changed ||= reverse !== value;
          out[key] = reverse;
          continue;
        }
        if (key.startsWith('@') && key !== '@included') {
          out[key] = value;
          continue;
        }
        const next = settled(value);
        changed ||= next !== value;
        out[key] = next;
      }
      return changed ? out : node;
    };
    const settled = (value: unknown): unknown => {
      const all = Array.isArray(value) ? value : [value];
      const next = all.map((child: unknown) => {
        if (!isHitValue(child)) return item(child);
        if (Object.keys(child).length === 1) return child;
        extra.push(item(child) as JsonLd);
        return { '@id': child['@id'] };
      });
      return next.every((v, i) => v === all[i])
        ? value
        : next.filter((v) => v !== MOVED);
    };
    const extra: JsonLd[] = [];
    const named = new Set<string>();
    const values = (value: unknown): unknown => {
      if (!Array.isArray(value)) {
        const next = item(value);
        return next === MOVED ? [] : next;
      }
      const next = value.map(item);
      return next.every((v, i) => v === value[i])
        ? value
        : next.filter((v) => v !== MOVED);
    };
    const link = (hit: string, value: unknown): void => {
      const label = blankLabel(value)!;
      const entry = label === '' ? start() : labelled.get(label)!;
      entry.links.push(
        Object.freeze(context === undefined ? { hit } : { hit, context }),
      );
      entry.groups.add(context);
      // An embedded node carries its details, and maybe reverse links to
      // more hits, in place of a reference.
      absorb(value as JsonLd, entry);
    };
    const strip = (node: JsonLd): JsonLd => {
      let changed = false;
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node)) {
        if (key === FIND_RESULT && isHit(node)) {
          const all = findResults(node);
          if (all.some((v) => blankLabel(v) !== undefined)) {
            changed = true;
            const stored = all.filter((v) => blankLabel(v) === undefined);
            all
              .filter((v) => blankLabel(v) !== undefined)
              .forEach((v) => link(node['@id'] as string, v));
            const kept = values(stored);
            if ((kept as unknown[]).length > 0) out[key] = kept;
            continue;
          }
        }
        if (key === '@reverse' && isNode(value)) {
          const reverse: Record<string, unknown> = {};
          let moved = false;
          for (const [p, v] of Object.entries(value)) {
            reverse[p] = values(v);
            moved ||= reverse[p] !== v;
          }
          changed ||= moved;
          out[key] = moved ? reverse : value;
          continue;
        }
        const next =
          key.startsWith('@') && key !== '@included' ? value : values(value);
        changed ||= next !== value;
        out[key] = next;
      }
      return changed ? Object.freeze(out) : node;
    };
    const kept: JsonLd[] = [];
    for (const node of nodes) {
      const next = item(node);
      // A top-level `{}` states nothing and is no node of the answer.
      if (next !== MOVED && (Object.keys(node).length > 0 || next !== node))
        kept.push(next as JsonLd);
    }
    kept.push(...extra);
    // A hit named only by a reverse link still appears as a node.
    const present = new Set(kept.map((node) => node['@id']));
    for (const hit of named)
      if (!present.has(hit)) kept.push(Object.freeze({ '@id': hit }));
    return { context, nodes: kept };
  });
  const observations = order.map((entry) => ({
    entry,
    observation: freezeObservation(entry),
  }));
  return stripped.map(({ context, nodes }) => ({
    context,
    nodes: Object.freeze(nodes),
    observations: Object.freeze(
      observations
        .filter(({ entry }) => entry.groups.has(context))
        .map(({ observation }) => observation),
    ),
  }));
}

function freezeObservation(entry: Building): FindObservation {
  const details = Object.freeze([...entry.details]);
  const values = (predicate: string) =>
    details.flatMap(({ node }) => list(node[predicate]));
  return Object.freeze({
    links: Object.freeze([...entry.links]),
    details,
    text: Object.freeze(values(SCHEMA_TEXT).flatMap(stringOf)),
    position: Object.freeze(values(SCHEMA_POSITION).flatMap(positionOf)),
    engine: Object.freeze(values(SPS_ENGINE).flatMap(stringOf)),
  });
}

function detail(context: string | undefined, node: JsonLd): FindDetail {
  const own = Object.freeze(without(node, '@id'));
  return Object.freeze(
    context === undefined ? { node: own } : { context, node: own },
  );
}

function without(node: JsonLd, key: string): JsonLd {
  const copy = { ...node };
  delete copy[key];
  return copy;
}

/** A hit is an IRI (SPS-FIND-029); a blank subject's links stay as answered. */
function isHit(node: JsonLd): boolean {
  const own = node['@id'];
  return typeof own === 'string' && !own.startsWith('_:');
}

function findResults(node: JsonLd): readonly unknown[] {
  return list(node[FIND_RESULT]);
}

/** The values of a property, with `@set` wrappers unwrapped. */
function list(value: unknown): readonly unknown[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).flatMap((item: unknown) =>
    isNode(item) && Object.hasOwn(item, '@set') ? list(item['@set']) : [item],
  );
}

/** The hits a node names as reverse `sps:findResult` subjects. */
function reverseHits(node: JsonLd): readonly JsonLd[] {
  const reverse = node['@reverse'];
  return isNode(reverse) ? list(reverse[FIND_RESULT]).filter(isHitValue) : [];
}

function isHitValue(value: unknown): value is JsonLd & { '@id': string } {
  return (
    isNode(value) && !('@value' in value) && !('@list' in value) && isHit(value)
  );
}

/**
 * The blank-node label of an observation reference: `_:m` for a reference,
 * `''` for an embedded node without `@id` (a fresh blank node), and
 * `undefined` for an IRI or a literal, which are stored data.
 */
function blankLabel(value: unknown): string | undefined {
  if (
    !isNode(value) ||
    '@value' in value ||
    '@list' in value ||
    '@set' in value
  )
    return undefined;
  const id = value['@id'];
  if (id === undefined) return '';
  return typeof id === 'string' && id.startsWith('_:') ? id : undefined;
}

/** The node objects a node embeds: property, `@reverse` and `@included` values. */
function embedded(node: JsonLd): JsonLd[] {
  const out: JsonLd[] = [];
  const items = (value: unknown): void => {
    for (const item of Array.isArray(value) ? value : [value]) {
      // A literal, also a JSON literal, is opaque.
      if (!isNode(item) || '@value' in item) continue;
      if ('@list' in item) items(item['@list']);
      else if ('@set' in item) items(item['@set']);
      else out.push(item);
    }
  };
  for (const [key, value] of Object.entries(node)) {
    if (key === '@reverse') {
      if (!isNode(value)) throw invalid();
      Object.values(value).forEach(items);
    } else if (key === '@included' || !key.startsWith('@')) items(value);
  }
  return out;
}

/**
 * A node object of a graph, also every node it embeds: a nested `@graph`
 * would name a graph inside the answer, and only a context without effect
 * is understood.
 */
function checkNode(value: unknown): asserts value is JsonLd {
  if (
    !isNode(value) ||
    '@value' in value ||
    '@list' in value ||
    '@set' in value ||
    Object.hasOwn(value, '@graph')
  )
    throw invalid();
  checkContext(value);
  embedded(value).forEach(checkNode);
}

/** The nodes of a `@graph`: one node object or an array of them. */
function graphOf(group: JsonLd): readonly JsonLd[] {
  const value = group['@graph'];
  const nodes = Array.isArray(value) ? value : [value];
  nodes.forEach(checkNode);
  return nodes as readonly JsonLd[];
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

/** Whether a node object encodes at least one RDF statement. */
function hasStatements(node: JsonLd): boolean {
  return Object.entries(node).some(([key, value]) => {
    if (key === '@included')
      return (Array.isArray(value) ? value : [value]).some(
        (v) => isNode(v) && hasStatements(v),
      );
    if (key === '@reverse')
      return isNode(value) && Object.values(value).some(present);
    return (key === '@type' || !key.startsWith('@')) && present(value);
  });
}

function present(value: unknown): boolean {
  return !Array.isArray(value) || value.length > 0;
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
