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
  /**
   * The resource is itself one picture, such as an `ImageObject`: the values
   * of its one-step paths are variants of it. Otherwise each is a picture.
   */
  readonly isImage?: boolean;
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
    isImage: true,
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
/** Distinct addresses one preview tries over its lifetime, loaded or failed. */
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
  /** The predicates walked: `[predicate]`, or `[link, variant]` for a linked node. */
  readonly steps: readonly [string] | readonly [string, string];
  /** The checked address; undefined when the address guard refused it. */
  readonly url: string | undefined;
  /** A direct value that is an IRI: the card's rule may know it as a node. */
  readonly target?: string;
  /**
   * A linked node: its variants are one picture. An IRI, or for a blank node
   * a key that is unique to its read result.
   */
  readonly node?: string;
  readonly evidence: readonly Evidence[];
}

/** What one read of one root in one Pod found. Rule-independent. */
export interface SourceFacts {
  readonly root: string;
  readonly types: readonly Fact<string>[];
  readonly aliases: readonly Fact<string>[];
  readonly images: readonly ImageMatch[];
  readonly dates: readonly (Fact<DateTerm> & { readonly predicate: string })[];
  readonly truncated: boolean;
}

/** A fact while it is being collected. */
type Collecting<T> = { value: T; evidence: Evidence[] };

const iri = (value: string) => {
  // Roots come from decoded terms; this is a second check, not a sanitizer.
  if (/[\p{Cc}\s<>"{}|^`\\]/u.test(value) || !/^[a-z][a-z\d+.-]*:/i.test(value))
    throw new Error(`Not an IRI for a card read: ${value}`);
  return `<${value}>`;
};
const list = (values: Iterable<string>) =>
  [...new Set(values)].map(iri).join(' ');

/** Link and variant predicate of each declared two-step path. */
const pairsOf = (rules: readonly CardRule[]) =>
  rules
    .flatMap((rule) => rule.images)
    .flatMap((path) =>
      path.length === 2
        ? path[0].flatMap((link) => path[1].map((variant) => [link, variant]))
        : [],
    );

/**
 * One SELECT for one root: the declared predicates of the root, and the
 * second step of each two-step path, as declared pairs of link and variant
 * predicate. Nothing else is read, and no value becomes another root: the
 * enrichment is metadata only.
 */
export function cardQuery(
  root: string,
  rules: readonly CardRule[],
  aliases: readonly string[] = exampleAliases,
): string {
  const facts = [RDF_TYPE, ...aliases, ...rules.flatMap((rule) => rule.dates)];
  const firstSteps = rules.flatMap((rule) =>
    rule.images.flatMap((path) => path[0]),
  );
  const pairs = [
    ...new Set(
      pairsOf(rules).map(
        ([link, variant]) => `(${iri(link!)} ${iri(variant!)})`,
      ),
    ),
  ];
  // Sort order: the root's types, aliases and dates first; then one block per
  // image node (`?node`), its link first (`?step`) and then its variants. A
  // long read is never cut before the root's own facts, and the kept rows of
  // a cut picture still include the link they need to join.
  const branches = [
    `{
    VALUES ?p { ${list(facts)} }
    GRAPH ?g { ${iri(root)} ?p ?o }
    BIND(${iri(root)} AS ?s)
    BIND(0 AS ?order)
  }`,
  ];
  if (firstSteps.length)
    branches.push(`{
    VALUES ?p { ${list(firstSteps)} }
    GRAPH ?g { ${iri(root)} ?p ?o }
    BIND(${iri(root)} AS ?s)
    BIND(1 AS ?order)
    BIND(?o AS ?node)
    BIND(0 AS ?step)
  }`);
  if (pairs.length)
    branches.push(`{
    VALUES (?link ?p) { ${pairs.join(' ')} }
    GRAPH ?origin { ${iri(root)} ?link ?s }
    GRAPH ?g { ?s ?p ?o }
    BIND(1 AS ?order)
    BIND(?s AS ?node)
    BIND(1 AS ?step)
  }`);
  return `SELECT DISTINCT ?s ?p ?o ?g WHERE {
  ${branches.join(' UNION ')}
} ORDER BY ?order ?node ?step ?s ?p ?g ?o LIMIT ${MAX_ROWS + 1}`;
}

/** Adds `evidence` unless the list already holds that statement. */
function addEvidence(list: Evidence[], evidence: Evidence) {
  const same = (e: Evidence) =>
    e.pod === evidence.pod &&
    e.context === evidence.context &&
    e.subject === evidence.subject &&
    e.predicate === evidence.predicate;
  if (!list.some(same)) list.push(evidence);
}

/** Adds `evidence` to the fact with an equal key, or appends a new fact. */
function add<T>(
  facts: Collecting<T>[],
  value: T,
  evidence: Evidence,
  key: (value: T) => string = String,
) {
  const found = facts.find((fact) => key(fact.value) === key(value));
  if (found) addEvidence(found.evidence, evidence);
  else facts.push({ value, evidence: [evidence] });
}

/** An address value: an IRI, or a literal without a language or datatype. */
function addressValue(term: SparqlTerm) {
  if (term.type === 'iri') return term.value;
  if (term.type !== 'literal' || term.language) return undefined;
  const plain = !term.datatype || term.datatype === `${XSD}string`;
  return plain || term.datatype === `${XSD}anyURI` ? term.value : undefined;
}

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
  const read = readId(result);
  const aliasSet = new Set(aliases);
  const dateSet = new Set(rules.flatMap((rule) => rule.dates));
  const paths = rules.flatMap((rule) => rule.images);
  const oneStep = new Set(
    paths.flatMap((path) => (path.length === 1 ? path[0] : [])),
  );
  const twoStep = new Set(
    pairsOf(rules).map(([link, variant]) => `${link} ${variant}`),
  );
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
  const types: Collecting<string>[] = [];
  const aliasFacts: Collecting<string>[] = [];
  const dates: (Collecting<DateTerm> & { predicate: string })[] = [];
  // Which matches count, and which link describes an image, depends on the
  // card's rule: the facts keep them all.
  const images: ImageMatch[] = [];
  const image = (match: Omit<ImageMatch, 'url'>, value: string | undefined) =>
    images.push({
      ...match,
      url: value === undefined ? undefined : imageAddress(value),
    });
  // Second step: a link statement of the root and a statement of the node it
  // links to, joined within this read only as a declared pair. The node may
  // be the root itself (`<root> schema:image <root>`).
  const links = new Map<string, typeof rows>();
  for (const row of rows)
    if (row.own) {
      const node = exactTerm(row.o);
      const linked = links.get(node);
      if (linked) linked.push(row);
      else links.set(node, [row]);
    }
  for (const row of rows)
    for (const link of links.get(row.evidence.subject) ?? [])
      if (twoStep.has(`${link.p} ${row.p}`))
        image(
          {
            steps: [link.p, row.p],
            // A blank node's label means nothing outside its read.
            node:
              row.s.type === 'iri'
                ? row.s.value
                : JSON.stringify([read, row.evidence.subject]),
            evidence: [link.evidence, row.evidence],
          },
          addressValue(row.o),
        );
  for (const { o, p, evidence, own } of rows) {
    if (!own) continue;
    if (p === RDF_TYPE && o.type === 'iri') add(types, o.value, evidence);
    if (aliasSet.has(p) && o.type === 'iri' && o.value !== root)
      add(aliasFacts, o.value, evidence);
    if (dateSet.has(p) && o.type === 'literal') {
      const date = dates.find(
        (date) =>
          date.predicate === p && exactTerm(date.value) === exactTerm(o),
      );
      if (date) addEvidence(date.evidence, evidence);
      else dates.push({ value: o, evidence: [evidence], predicate: p });
    }
    // A blank node is no address.
    if (oneStep.has(p) && o.type !== 'blank')
      image(
        {
          steps: [p],
          ...(o.type === 'iri' ? { target: o.value } : {}),
          evidence: [evidence],
        },
        addressValue(o),
      );
  }
  return {
    root,
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
 * Groups of items connected by a shared key, also through a chain of items.
 * The earliest item leads its group; groups follow their first items.
 */
function connected<T>(
  items: readonly T[],
  keysOf: (item: T) => readonly string[],
): T[][] {
  const parent = items.map((_, index) => index);
  const find = (i: number): number => (parent[i] === i ? i : find(parent[i]!));
  const seen = new Map<string, number>();
  items.forEach((item, index) => {
    for (const key of keysOf(item)) {
      const other = seen.get(key);
      if (other === undefined) {
        seen.set(key, index);
        continue;
      }
      const [a, b] = [find(other), find(index)];
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    }
  });
  const groups = new Map<number, T[]>();
  items.forEach((item, index) => {
    const lead = find(index);
    const group = groups.get(lead);
    if (group) group.push(item);
    else groups.set(lead, [item]);
  });
  return [...groups.values()];
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
  const ranked = facts.filter((fact) => admitted.includes(fact.root));
  // Admitted roots joined by an alias share a card, the earliest leading. An
  // alias to anything else is kept as a fact but never read.
  const aliasesOf = (root: string) =>
    ranked
      .filter((fact) => fact.root === root)
      .flatMap((fact) => fact.aliases.map((alias) => alias.value))
      .filter((alias) => admitted.includes(alias));
  const cards = new Map<string, ResourceCard>();
  for (const members of connected(admitted, (root) => [
    root,
    ...aliasesOf(root),
  ])) {
    const own = ranked.filter((fact) => members.includes(fact.root));
    const card = cardOf(members[0]!, members, own, rules);
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
  const types: Collecting<string>[] = [];
  for (const fact of facts)
    for (const type of fact.types)
      for (const evidence of type.evidence) add(types, type.value, evidence);
  // Type precedence is the rules' order, never the order of sources or types.
  const rule =
    rules.find(
      (rule) =>
        rule.types.length === 0 ||
        types.some((type) => rule.types.includes(type.value)),
    ) ?? rules.at(-1)!;
  const sameAs: Collecting<string>[] = [];
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
 * that share a node or an address are one picture. Its variants follow the
 * path order, then the predicate order of the path's last step. The limits
 * apply last.
 */
function imagesOf(
  rule: CardRule,
  facts: readonly SourceFacts[],
): { images: CardImage[]; refused: number } {
  const matches = facts
    .flatMap((fact) => fact.images)
    .flatMap((match) => {
      const path = rule.images.findIndex(
        (path) =>
          path.length === match.steps.length &&
          path.every((step, i) => step.includes(match.steps[i]!)),
      );
      if (path < 0) return [];
      const ranks = rule.images[path]!.map((step, i) =>
        step.indexOf(match.steps[i]!),
      );
      // Only the card's rule says whether direct values are one picture.
      const node =
        match.steps.length === 2
          ? match.node
          : rule.isImage
            ? 'the resource itself'
            : undefined;
      return [{ ...match, node, path, first: ranks[0]!, last: ranks.at(-1)! }];
    });
  // A node this rule describes through a two-step path is no address itself.
  const described = new Set(
    matches.flatMap((match) =>
      match.steps.length === 2 && match.node ? [match.node] : [],
    ),
  );
  const kept = matches.filter(
    (match) => match.target === undefined || !described.has(match.target),
  );
  // Stable sort: sources and rows keep their order within equal ranks.
  const usable = kept
    .flatMap((match) =>
      match.url === undefined ? [] : [{ ...match, url: match.url }],
    )
    .sort((a, b) => a.path - b.path || a.first - b.first);
  const pictures = connected(usable, (match) =>
    match.node
      ? [`url ${match.url}`, `node ${match.node}`]
      : [`url ${match.url}`],
  );
  const better = (
    a: { path: number; last: number },
    b: { path: number; last: number },
  ) => a.path - b.path || a.last - b.last;
  const images = pictures.slice(0, MAX_IMAGES).map((group) => {
    const variants: (Collecting<string> & { path: number; last: number })[] =
      [];
    for (const match of group) {
      const variant = variants.find((variant) => variant.value === match.url);
      if (!variant) {
        variants.push({
          value: match.url,
          evidence: [...match.evidence],
          path: match.path,
          last: match.last,
        });
        continue;
      }
      // The same address under several predicates keeps its best preference.
      if (better(match, variant) < 0)
        Object.assign(variant, { path: match.path, last: match.last });
      for (const evidence of match.evidence)
        addEvidence(variant.evidence, evidence);
    }
    return {
      // The limit applies after ranking, so a thumbnail is never cut.
      variants: variants
        .sort(better)
        .slice(0, MAX_VARIANTS)
        .map(({ value, evidence }) => ({ value, evidence })),
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
  const dates: Collecting<DateTerm>[] = [];
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
