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
 * (SPS-FIND-010). A statement in the default graph or under a blank graph
 * name, also a bare observation, makes the whole answer untrusted.
 */
export function decodeGroupedFind(
  body: unknown,
  base: string,
  scope: readonly string[] | undefined,
): readonly FindGraph[] {
  const requested = scope && new Set(scope);
  const groups = Array.isArray(body) ? body : [body];
  const raw = groups.map((group: unknown) => {
    if (!isNode(group) || !Object.keys(group).every(isGroupKey))
      throw invalid();
    const context = group['@id'];
    const nodes = group['@graph'];
    if (
      typeof context !== 'string' ||
      !isContextIri(context, base) ||
      (requested && !requested.has(context)) ||
      !Array.isArray(nodes) ||
      !nodes.every(isGraphNode)
    )
      throw invalid();
    return { context, nodes: nodes as readonly JsonLd[] };
  });
  const decoded = observe(raw);
  return Object.freeze(
    decoded.map(({ context, nodes, observations }) =>
      Object.freeze({ context: context as string, nodes, observations }),
    ),
  );
}

/**
 * A graph without graph names (SPS-FIND-026): an array of node objects, one
 * node object, or a default-graph `{"@graph": [...]}`. A named graph rejects
 * the answer, and so does any statement for an explicitly empty downscope.
 */
export function decodeFlatFind(
  body: unknown,
  scope: readonly string[] | undefined,
): FlatFindGraph {
  let nodes: unknown;
  if (Array.isArray(body)) nodes = body;
  else if (isNode(body) && Object.hasOwn(body, '@graph')) {
    if (Object.keys(body).length !== 1) throw invalid();
    nodes = body['@graph'];
  } else nodes = [body];
  if (!Array.isArray(nodes) || !nodes.every(isGraphNode)) throw invalid();
  if (scope?.length === 0 && nodes.length > 0) throw invalid();
  const [decoded] = observe([
    { context: undefined, nodes: nodes as readonly JsonLd[] },
  ]);
  return Object.freeze({
    nodes: decoded?.nodes ?? Object.freeze([]),
    observations: decoded?.observations ?? Object.freeze([]),
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

/**
 * Separates generated observations from pod data across the whole answer.
 * A `sps:findResult` value that is a blank node is an observation link; an
 * IRI value is a stored statement and stays (SPS-FIND-027). Blank-node labels
 * identify one node within this answer only: a link in one group and details
 * in another are one observation, and no label leaves this function, so two
 * answers never share an observation.
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
  for (const { nodes } of groups)
    for (const node of nodes) {
      if (!isHit(node)) continue;
      for (const value of findResults(node)) {
        const label = blankLabel(value);
        if (label !== undefined && !labelled.has(label))
          labelled.set(label, start());
      }
    }
  const stripped = groups.map(({ context, nodes }) => {
    const kept: JsonLd[] = [];
    for (const node of nodes) {
      const own = typeof node['@id'] === 'string' ? node['@id'] : undefined;
      const detailOf = own === undefined ? undefined : labelled.get(own);
      if (detailOf) {
        detailOf.details.push(detail(context, node));
        detailOf.groups.add(context);
        continue;
      }
      const values = findResults(node);
      if (values.length === 0 || own === undefined || !isHit(node)) {
        kept.push(node);
        continue;
      }
      const stored: unknown[] = [];
      for (const value of values) {
        const label = blankLabel(value);
        if (label === undefined) {
          stored.push(value);
          continue;
        }
        const entry = label === '' ? start() : labelled.get(label)!;
        entry.links.push(
          Object.freeze(
            context === undefined ? { hit: own } : { hit: own, context },
          ),
        );
        entry.groups.add(context);
        // An embedded node carries its details in place of a reference.
        const embedded = withoutId(value as JsonLd);
        if (Object.keys(embedded).length > 0) {
          entry.details.push(detail(context, embedded));
        }
      }
      const rest = without(node, FIND_RESULT);
      kept.push(
        Object.freeze(
          stored.length > 0 ? { ...rest, [FIND_RESULT]: stored } : rest,
        ),
      );
    }
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
    details.flatMap(({ node }) => {
      const value = node[predicate];
      return Array.isArray(value) ? value : value === undefined ? [] : [value];
    });
  return Object.freeze({
    links: Object.freeze([...entry.links]),
    details,
    text: Object.freeze(values(SCHEMA_TEXT).flatMap(stringOf)),
    position: Object.freeze(values(SCHEMA_POSITION).flatMap(integerOf)),
    engine: Object.freeze(values(SPS_ENGINE).flatMap(stringOf)),
  });
}

function detail(context: string | undefined, node: JsonLd): FindDetail {
  const own = Object.freeze(withoutId(node));
  return Object.freeze(
    context === undefined ? { node: own } : { context, node: own },
  );
}

function withoutId(node: JsonLd): JsonLd {
  return without(node, '@id');
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
  const value = node[FIND_RESULT];
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
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

function stringOf(value: unknown): readonly string[] {
  const lexical = isNode(value) ? value['@value'] : value;
  return typeof lexical === 'string' ? [lexical] : [];
}

function integerOf(value: unknown): readonly number[] {
  const lexical = isNode(value) ? value['@value'] : value;
  const number =
    typeof lexical === 'number'
      ? lexical
      : typeof lexical === 'string' && /^[+-]?\d+$/.test(lexical.trim())
        ? Number(lexical)
        : Number.NaN;
  return Number.isSafeInteger(number) ? [number] : [];
}

function isGroupKey(key: string): boolean {
  return key === '@id' || key === '@graph';
}

/** A node object; a nested `@graph` would name a graph inside the answer. */
function isGraphNode(value: unknown): value is JsonLd {
  return isNode(value) && !Object.hasOwn(value, '@graph');
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
