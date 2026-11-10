/**
 * Bounded resource cards from declared short property paths, each value with
 * the exact Pod and Context it was read from. App-local recipe code on public
 * types, without React: copy and adapt it. The rules, the alias predicates and
 * the limits belong to the app.
 */
import type { SelectResult, SparqlTerm } from '@sempods/client-sdk';
import { exactTerm, webAddress } from './rdf-values.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const FOAF = 'http://xmlns.com/foaf/0.1/';

/** Both schema.org namespaces are in use; list the `https:` form first. */
const schema = (name: string) => [
  `https://schema.org/${name}`,
  `http://schema.org/${name}`,
];

/** One step of a path: alternative predicates, the preferred first. */
export type Step = readonly string[];
/** A direct value of the resource, or a value of a node it links to. */
export type PropertyPath = readonly [Step] | readonly [Step, Step];

export interface CardRule {
  readonly id: string;
  /** The rule presents resources of one of these types; `[]` matches any. */
  readonly types: readonly string[];
  /** Paths to image addresses, the preferred first. */
  readonly images: readonly PropertyPath[];
  /** Date predicates, the preferred first. */
  readonly dates: readonly string[];
}

const imageLinks = [...schema('image'), `${FOAF}img`, `${FOAF}depiction`];
/** The smaller variant first: a card shows a thumbnail before the original. */
const imageVariants = [...schema('thumbnailUrl'), ...schema('contentUrl')];
const pictures: readonly PropertyPath[] = [
  [imageLinks, imageVariants],
  [imageLinks],
];

/** App placeholder: rules in precedence order; the first matching type wins. */
export const exampleRules: readonly CardRule[] = [
  {
    id: 'person',
    types: [...schema('Person'), `${FOAF}Person`],
    images: pictures,
    dates: [],
  },
  {
    id: 'event',
    types: schema('Event'),
    images: pictures,
    dates: schema('startDate'),
  },
  {
    id: 'image',
    types: schema('ImageObject'),
    images: [[imageVariants]],
    dates: [],
  },
  { id: 'resource', types: [], images: pictures, dates: [] },
];

/** `owl:sameAs` only: `schema:sameAs` names a web page about the item. */
export const exampleAliases: readonly string[] = [
  'http://www.w3.org/2002/07/owl#sameAs',
];

/** Rows one card read returns at most; one more row marks it as truncated. */
export const MAX_ROWS = 200;
/** Pictures per card, and variants (thumbnail, original, direct) per picture. */
export const MAX_IMAGES = 4;
export const MAX_VARIANTS = 3;
/** Failed image addresses after which a preview stops and shows "unavailable". */
export const MAX_ATTEMPTS = 6;

/** Where one value comes from: one statement in one Context of one Pod. */
export interface Evidence {
  readonly pod: string;
  /** The Context IRI (the SPARQL graph). */
  readonly context: string;
  /** The statement's subject as received; a blank node is local to its read. */
  readonly subject: string;
  readonly predicate: string;
}

/** A value with every statement that supports it. */
export interface Fact<T> {
  readonly value: T;
  readonly evidence: readonly Evidence[];
}

export type DateTerm = Extract<SparqlTerm, { type: 'literal' }>;

interface ImageMatch {
  /** The first step's predicate when the address belongs to a linked node. */
  readonly link?: string;
  readonly predicate: string;
  /** The checked address; undefined when the address guard refused it. */
  readonly url: string | undefined;
  /** A direct value that is an IRI: the card's rule may know it as a node. */
  readonly target?: string;
  /**
   * The image's node: variants of one node are one picture. An IRI, or for a
   * blank node a key that is unique to its read result.
   */
  readonly node?: string;
  readonly evidence: readonly Evidence[];
}

/** What one read of one root in one Pod found. Rule-independent. */
export interface SourceFacts {
  readonly root: string;
  readonly pod: string;
  readonly types: readonly Fact<string>[];
  readonly aliases: readonly Fact<string>[];
  readonly images: readonly ImageMatch[];
  readonly dates: readonly (Fact<DateTerm> & { readonly predicate: string })[];
  readonly truncated: boolean;
}

const iri = (value: string) => {
  // Roots come from decoded terms; this is a second check, not a sanitizer.
  if (/[\p{Cc}\s<>"{}|^`\\]/u.test(value) || !/^[a-z][a-z\d+.-]*:/i.test(value))
    throw new Error(`Not an IRI for a card read: ${value}`);
  return `<${value}>`;
};
const list = (values: Iterable<string>) =>
  [...new Set(values)].map(iri).join(' ');

/** The predicates a set of rules declares, for the read and the facts. */
function declared(rules: readonly CardRule[], aliases: readonly string[]) {
  const paths = rules.flatMap((rule) => rule.images);
  const links = paths.flatMap((path) => (path.length === 2 ? path[0] : []));
  return {
    direct: new Set([
      RDF_TYPE,
      ...aliases,
      ...paths.flatMap((path) => path[0]),
      ...rules.flatMap((rule) => rule.dates),
    ]),
    links: new Set(links),
    variants: new Set(
      paths.flatMap((path) => (path.length === 2 ? path[1] : [])),
    ),
  };
}

/**
 * One SELECT for one root: the declared predicates of the root, and the
 * second step of each two-step path. Nothing else is read, and no value
 * becomes another root: the enrichment is metadata only.
 */
export function cardQuery(
  root: string,
  rules: readonly CardRule[],
  aliases: readonly string[] = exampleAliases,
): string {
  const { direct, links, variants } = declared(rules, aliases);
  const linked = links.size
    ? `UNION {
    VALUES ?link { ${list(links)} }
    VALUES ?p { ${list(variants)} }
    GRAPH ?origin { ${iri(root)} ?link ?s }
    GRAPH ?g { ?s ?p ?o }
  }`
    : '';
  return `SELECT DISTINCT ?s ?p ?o ?g WHERE {
  {
    VALUES ?p { ${list(direct)} }
    GRAPH ?g { ${iri(root)} ?p ?o }
    BIND(${iri(root)} AS ?s)
  } ${linked}
} ORDER BY ?s ?p ?g ?o LIMIT ${MAX_ROWS + 1}`;
}

/** Adds `evidence` to the fact with an equal key, or appends a new fact. */
function add<T>(
  facts: { value: T; evidence: Evidence[] }[],
  value: T,
  evidence: Evidence,
  key: (value: T) => string = String,
) {
  const found = facts.find((fact) => key(fact.value) === key(value));
  if (!found) facts.push({ value, evidence: [evidence] });
  else if (!found.evidence.some((e) => sameEvidence(e, evidence)))
    found.evidence.push(evidence);
}
const sameEvidence = (a: Evidence, b: Evidence) =>
  a.pod === b.pod &&
  a.context === b.context &&
  a.subject === b.subject &&
  a.predicate === b.predicate;

/** An address value: an IRI, or a literal without a language or datatype. */
function addressValue(term: SparqlTerm) {
  if (term.type === 'iri') return term.value;
  if (term.type !== 'literal' || term.language) return undefined;
  const plain = !term.datatype || term.datatype === `${XSD}string`;
  return plain || term.datatype === `${XSD}anyURI` ? term.value : undefined;
}

const declaresPath = (
  rules: readonly CardRule[],
  link: string,
  predicate: string,
) =>
  rules.some((rule) =>
    rule.images.some(
      (path) =>
        path.length === 2 &&
        path[0].includes(link) &&
        path[1].includes(predicate),
    ),
  );

/** A number per read result, so blank nodes of two reads never meet. */
const reads = new WeakMap<SelectResult, number>();
let lastRead = 0;
const readId = (result: SelectResult) => {
  if (!reads.has(result)) reads.set(result, ++lastRead);
  return reads.get(result)!;
};

/**
 * Facts from one card read of `root` in the Pod `pod`. Rows outside the
 * declared paths are ignored, and blank nodes never leave this read.
 */
export function sourceFacts(
  result: SelectResult,
  root: string,
  pod: string,
  rules: readonly CardRule[],
  aliases: readonly string[] = exampleAliases,
): SourceFacts {
  const { direct, variants } = declared(rules, aliases);
  const read = readId(result);
  const aliasSet = new Set(aliases);
  const dateSet = new Set(rules.flatMap((rule) => rule.dates));
  const rows = result.rows.slice(0, MAX_ROWS).flatMap((row) => {
    const { s, p, o, g } = row;
    if (!s || !o || p?.type !== 'iri' || g?.type !== 'iri') return [];
    if (s.type !== 'iri' && s.type !== 'blank') return [];
    const subject = exactTerm(s);
    const evidence = { pod, context: g.value, subject, predicate: p.value };
    return [
      { s, p: p.value, o, evidence, own: s.type === 'iri' && s.value === root },
    ];
  });
  const types: { value: string; evidence: Evidence[] }[] = [];
  const aliasFacts: { value: string; evidence: Evidence[] }[] = [];
  const dates: { value: DateTerm; evidence: Evidence[]; predicate: string }[] =
    [];
  const images: ImageMatch[] = [];
  // Second step: a link statement and a statement of the linked node, joined
  // within this read only where one declared path has both predicates.
  const joins = rows.flatMap((row) =>
    row.own
      ? []
      : rows
          .filter(
            (link) =>
              link.own &&
              exactTerm(link.o) === exactTerm(row.s) &&
              declaresPath(rules, link.p, row.p),
          )
          .map((link) => ({ link, row })),
  );
  // Which matches count, and which link describes an image, depends on the
  // card's rule: the facts keep them all.
  const image = (match: Omit<ImageMatch, 'url'>, value: string | undefined) =>
    images.push({
      ...match,
      url: value === undefined ? undefined : imageAddress(value),
    });
  for (const { link, row } of joins)
    image(
      {
        link: link.p,
        predicate: row.p,
        // A blank node's label means nothing outside its read.
        node:
          row.s.type === 'iri'
            ? row.s.value
            : JSON.stringify([read, exactTerm(row.s)]),
        evidence: [link.evidence, row.evidence],
      },
      addressValue(row.o),
    );
  for (const row of rows) {
    const { o, p, evidence } = row;
    if (!row.own || !direct.has(p)) continue;
    if (p === RDF_TYPE && o.type === 'iri') add(types, o.value, evidence);
    if (aliasSet.has(p) && o.type === 'iri' && o.value !== root)
      add(aliasFacts, o.value, evidence);
    if (dateSet.has(p) && o.type === 'literal') {
      const existing = dates.find(
        (date) =>
          date.predicate === p && exactTerm(date.value) === exactTerm(o),
      );
      if (existing) existing.evidence.push(evidence);
      else dates.push({ value: o, evidence: [evidence], predicate: p });
    }
    if (
      rules.some((rule) =>
        rule.images.some((path) => path.length === 1 && path[0].includes(p)),
      )
    ) {
      if (o.type === 'blank') continue; // A blank node is no address.
      // The root's own variants are variants of the root as one picture.
      image(
        {
          predicate: p,
          ...(variants.has(p) ? { node: root } : {}),
          ...(o.type === 'iri' ? { target: o.value } : {}),
          evidence: [evidence],
        },
        addressValue(o),
      );
    }
  }
  return {
    root,
    pod,
    types,
    aliases: aliasFacts,
    images,
    dates,
    truncated: result.rows.length > MAX_ROWS,
  };
}

/**
 * The address a preview may try, or undefined: a named `https:` host without
 * user name or password. IP literals (also IPv4 in hex or octal, which `URL`
 * normalizes), single-label and local-looking names are refused. This checks
 * the initial address only: redirects and DNS answers are the browser's.
 */
export function imageAddress(value: string): string | undefined {
  const address = webAddress(value);
  if (!address) return undefined;
  const url = new URL(address.href);
  if (url.protocol !== 'https:') return undefined;
  const host = url.hostname.toLowerCase().replace(/\.+$/, '');
  if (
    host.includes(':') ||
    host.split('.').some((label) => !label) ||
    /^[\d.]+$/.test(host) ||
    !host.includes('.') ||
    /(^|\.)(localhost|localdomain|local|internal|home|lan|arpa|test|invalid)$/.test(
      host,
    )
  )
    return undefined;
  url.hash = '';
  return url.href;
}

/** One picture: its variants in preference order, each with its evidence. */
export interface CardImage {
  readonly variants: readonly Fact<string>[];
}

export interface ResourceCard {
  /** The root this card is keyed by: the first admitted member. */
  readonly root: string;
  /** Admitted roots shown as this card, joined by alias statements. */
  readonly members: readonly string[];
  readonly rule: string;
  readonly types: readonly Fact<string>[];
  /** The alias statements that join the members, for inspection. */
  readonly sameAs: readonly Fact<string>[];
  readonly images: readonly CardImage[];
  /** Distinct date terms, preferred first; more than one is a conflict to show. */
  readonly dates: readonly Fact<DateTerm>[];
  /** Image values the address guard refused. */
  readonly refused: number;
  readonly truncated: boolean;
}

/**
 * Cards for the admitted `roots`, from the facts of every current read. The
 * order of `facts` is the source precedence (for example the person's Pod
 * first). Recomputed from the facts each time: removing a source's facts
 * removes its values, and splits members its alias statements joined.
 * Returns each member root mapped to its card.
 */
export function resourceCards(
  roots: readonly string[],
  facts: readonly SourceFacts[],
  rules: readonly CardRule[],
): ReadonlyMap<string, ResourceCard> {
  const admitted = [...new Set(roots)];
  const order = new Map(admitted.map((root, index) => [root, index]));
  const ranked = facts.filter((fact) => order.has(fact.root));
  // Union of admitted roots joined by an alias; an alias to anything else is
  // kept as a fact but never read.
  const parent = new Map(admitted.map((root) => [root, root]));
  const find = (root: string): string => {
    const up = parent.get(root)!;
    return up === root ? root : find(up);
  };
  for (const fact of ranked)
    for (const alias of fact.aliases) {
      if (!order.has(alias.value)) continue;
      const [a, b] = [find(fact.root), find(alias.value)];
      if (a === b) continue;
      // The earlier admitted root represents the group.
      if (order.get(a)! < order.get(b)!) parent.set(b, a);
      else parent.set(a, b);
    }
  const cards = new Map<string, ResourceCard>();
  const groups = new Map<string, string[]>();
  for (const root of admitted) {
    const group = groups.get(find(root)) ?? [];
    group.push(root);
    groups.set(find(root), group);
  }
  for (const [root, members] of groups) {
    const own = ranked.filter((fact) => members.includes(fact.root));
    const card = cardOf(root, members, own, rules);
    for (const member of members) cards.set(member, card);
  }
  return cards;
}

function cardOf(
  root: string,
  members: readonly string[],
  facts: readonly SourceFacts[],
  rules: readonly CardRule[],
): ResourceCard {
  const types: { value: string; evidence: Evidence[] }[] = [];
  for (const fact of facts)
    for (const type of fact.types)
      for (const evidence of type.evidence) add(types, type.value, evidence);
  // Type precedence is the rules' order, never the order of sources or types.
  const rule =
    rules.find((rule) =>
      rule.types.length === 0
        ? true
        : types.some((type) => rule.types.includes(type.value)),
    ) ?? rules.at(-1)!;
  const sameAs: { value: string; evidence: Evidence[] }[] = [];
  for (const fact of facts)
    for (const alias of fact.aliases)
      if (members.includes(alias.value))
        for (const evidence of alias.evidence)
          add(sameAs, alias.value, evidence);
  return {
    root,
    members,
    rule: rule.id,
    types,
    sameAs,
    ...imagesOf(rule, facts),
    dates: datesOf(rule, facts),
    truncated: facts.some((fact) => fact.truncated),
  };
}

/**
 * Pictures for the card's rule. Precedence: the rule's path order, then the
 * first step's predicate order, then sources and the read's rows. Matches
 * that share a node or an address are one picture; within it the declared
 * predicate order sorts the variants. The limits apply last.
 */
function imagesOf(
  rule: CardRule,
  facts: readonly SourceFacts[],
): { images: CardImage[]; refused: number } {
  const matches = facts
    .flatMap((fact) => fact.images)
    .flatMap((match, index) => {
      const path = rule.images.findIndex((path) =>
        path.length === 2
          ? match.link !== undefined &&
            path[0].includes(match.link) &&
            path[1].includes(match.predicate)
          : match.link === undefined && path[0].includes(match.predicate),
      );
      if (path < 0) return [];
      const steps = rule.images[path]!;
      const first = steps[0].indexOf(match.link ?? match.predicate);
      // Variant rank: the declared order of a variant predicate. A direct
      // address that is no variant of a node comes after every variant.
      const rank =
        steps.length === 2
          ? steps[1].indexOf(match.predicate)
          : match.node !== undefined
            ? steps[0].indexOf(match.predicate)
            : Number.MAX_SAFE_INTEGER;
      return [{ ...match, path, first, rank, index }];
    });
  // A node this rule describes through a two-step path is no address itself.
  const described = new Set(
    matches.flatMap((match) =>
      match.link !== undefined && match.node ? [match.node] : [],
    ),
  );
  const kept = matches.filter(
    (match) => match.target === undefined || !described.has(match.target),
  );
  const usable = kept
    .flatMap((match) =>
      match.url === undefined ? [] : [{ ...match, url: match.url }],
    )
    .sort((a, b) => a.path - b.path || a.first - b.first || a.index - b.index);
  // Matches connected by a node or an address, also transitively, are one picture.
  const parent = usable.map((_, index) => index);
  const find = (i: number): number => (parent[i] === i ? i : find(parent[i]!));
  const seen = new Map<string, number>();
  usable.forEach((match, index) => {
    const keys = [`url ${match.url}`];
    if (match.node) keys.push(`node ${match.node}`);
    for (const key of keys) {
      const other = seen.get(key);
      if (other === undefined) {
        seen.set(key, index);
        continue;
      }
      const [a, b] = [find(other), find(index)];
      // The earlier match leads, so the picture keeps its place.
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    }
  });
  const groups = new Map<number, typeof usable>();
  usable.forEach((match, index) => {
    const group = groups.get(find(index)) ?? [];
    group.push(match);
    groups.set(find(index), group);
  });
  const images = [...groups.values()].slice(0, MAX_IMAGES).map((group) => {
    const variants: { value: string; evidence: Evidence[]; rank: number }[] =
      [];
    for (const match of group) {
      const variant = variants.find((variant) => variant.value === match.url);
      if (!variant) {
        variants.push({
          value: match.url,
          evidence: [...match.evidence],
          rank: match.rank,
        });
        continue;
      }
      // The same address under several predicates keeps its best rank.
      variant.rank = Math.min(variant.rank, match.rank);
      for (const evidence of match.evidence)
        if (!variant.evidence.some((e) => sameEvidence(e, evidence)))
          variant.evidence.push(evidence);
    }
    return {
      variants: variants
        .map((variant, index) => ({ variant, index }))
        .sort((a, b) => a.variant.rank - b.variant.rank || a.index - b.index)
        // The limit applies after ranking, so a thumbnail is never cut.
        .slice(0, MAX_VARIANTS)
        .map(({ variant: { value, evidence } }) => ({ value, evidence })),
    };
  });
  return {
    images,
    refused: kept.filter((match) => match.url === undefined).length,
  };
}

/** Distinct date terms in the rule's predicate order, then by source. */
function datesOf(
  rule: CardRule,
  facts: readonly SourceFacts[],
): Fact<DateTerm>[] {
  const dates: { value: DateTerm; evidence: Evidence[] }[] = [];
  for (const predicate of rule.dates)
    for (const fact of facts)
      for (const date of fact.dates)
        if (date.predicate === predicate)
          for (const evidence of date.evidence)
            add(dates, date.value, evidence, exactTerm);
  return dates;
}

/**
 * The addresses a preview may try, in order and deduplicated. The preview
 * bounds its attempts with `MAX_ATTEMPTS`.
 */
export function previewCandidates(images: readonly CardImage[]): string[] {
  return [
    ...new Set(images.flatMap((image) => image.variants.map((v) => v.value))),
  ];
}
