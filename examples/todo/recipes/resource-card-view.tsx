import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { BoundPod, BrowserRuntime, Connection } from '@sempods/app-sdk';
import {
  useAppState,
  useConnections,
  useMessages,
  usePodLoad,
  useSdkLocale,
} from '@sempods/app-sdk/react';
import { commonVocabulary, describeValue, labelFor } from './rdf-values.js';
import {
  cardQuery,
  exampleRules,
  MAX_ATTEMPTS,
  previewCandidates,
  resourceCards,
  sourceFacts,
  type CardRule,
  type DateTerm,
  type Evidence,
  type Fact,
  type ResourceCard,
  type SourceFacts,
} from './resource-cards.js';

const texts = {
  en: {
    blank: 'Unnamed node',
    unsupported: 'Unsupported value',
    shown: 'Picture',
    loading: 'Loading picture',
    unread: 'Not read yet',
    unavailable: 'Picture unavailable',
    absent: 'No picture',
    dates: 'Dates',
    sameAs: 'Same as',
    picture: (n: number) => `Picture ${n}`,
    moreDates: (n: number) => `+${n} other dates`,
    from: (pod: string, context: string) => `${pod} · ${context}`,
  },
  de: {
    blank: 'Unbenannter Knoten',
    unsupported: 'Nicht unterstützter Wert',
    shown: 'Bild',
    loading: 'Bild wird geladen',
    unread: 'Noch nicht gelesen',
    unavailable: 'Bild nicht verfügbar',
    absent: 'Kein Bild',
    dates: 'Daten',
    sameAs: 'Identisch mit',
    picture: (n: number) => `Bild ${n}`,
    moreDates: (n: number) => `+${n} weitere Daten`,
    from: (pod: string, context: string) => `${pod} · ${context}`,
  },
};

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Reading (signed in, or without a token): bindPod never throws for it. */
const reads = ({ reading }: Connection) => reading !== null;

interface Report {
  readonly facts: SourceFacts | undefined;
  readonly settled: boolean;
  readonly failed: boolean;
}

/** What the current reads of a card's members say beyond its values. */
export interface CardStatus {
  /** A read has not answered yet: missing values may still come. */
  readonly unread: boolean;
  /** A read failed, was refused or lost access: values may be missing. */
  readonly unavailable: boolean;
}

export interface CardOptions {
  /**
   * Pass a module-level constant. Another array is compared by value, so
   * inline rules do not read again on every render; changed rules do.
   */
  readonly rules?: readonly CardRule[];
  /** For what the person looks at now, such as the details of one resource. */
  readonly priority?: 'current';
}

/**
 * Cards for the admitted `roots` from every reading connection: one read per
 * root and Pod. Render `readers` once; they render nothing. The app admits
 * and bounds the roots; `podReadLimit` on the runtime bounds the requests.
 */
export function useResourceCards(
  runtime: BrowserRuntime,
  roots: readonly string[],
  { rules: given = exampleRules, priority }: CardOptions = {},
) {
  // An inline rules array is new on every render; keep the equal one. The
  // stored form is serialized once, so a constant costs no comparison.
  const [stored, setStored] = useState(() => ({
    rules: given,
    json: JSON.stringify(given),
  }));
  if (stored.rules !== given) {
    const json = JSON.stringify(given);
    if (json !== stored.json) setStored({ rules: given, json });
  }
  const { rules } = stored;
  // A card without any reading connection is unread until startup settles.
  const { startup, startupError } = useAppState();
  const settled = startup !== undefined || startupError !== undefined;
  // Source precedence needs a stable order: Pod URL, then connection.
  // Adapt it, for example to put the active Pod first.
  const connections = useConnections()
    .filter(reads)
    .sort((a, b) => compare(a.podUrl, b.podUrl) || compare(a.id, b.id));
  const [reports, setReports] = useState<ReadonlyMap<string, Report>>(
    () => new Map(),
  );
  const report = useCallback((key: string, value?: Report) => {
    setReports((old) => {
      const next = new Map(old);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    });
  }, []);
  const admitted = [...new Set(roots)];
  // Facts in source order, then in the roots' order.
  const pairs = connections.flatMap((connection) =>
    admitted.map((root) => ({
      key: JSON.stringify([connection.id, root]),
      connection,
      root,
    })),
  );
  // Only current pairs count, also before a removed reader's cleanup ran.
  const facts = pairs.flatMap(({ key }) => reports.get(key)?.facts ?? []);
  const cards = resourceCards(admitted, facts, rules);
  const status = (card: ResourceCard): CardStatus => {
    const own = pairs
      .filter(({ root }) => card.members.includes(root))
      .map(({ key }) => reports.get(key));
    if (own.length === 0) return { unread: !settled, unavailable: settled };
    return {
      unread: own.some((read) => !read?.settled),
      unavailable: own.some((read) => read?.failed),
    };
  };
  const readers = pairs.map(({ key, connection, root }) => (
    <CardRead
      key={key}
      id={key}
      pod={runtime.bindPod(connection.id)}
      podUrl={connection.podUrl}
      root={root}
      rules={rules}
      priority={priority}
      report={report}
    />
  ));
  return { cards, status, readers };
}

// Memoized: a report from one read re-renders the host, not every read.
const CardRead = memo(function CardRead(props: {
  readonly id: string;
  readonly pod: BoundPod;
  readonly podUrl: string;
  readonly root: string;
  readonly rules: readonly CardRule[];
  readonly priority: 'current' | undefined;
  readonly report: (key: string, value?: Report) => void;
}) {
  const { id, pod, podUrl, root, rules, priority, report } = props;
  const query = useMemo(() => queryFor(root, rules), [root, rules]);
  // The query is the read's input: new rules read again. A root that is no
  // IRI is not read: without a handle, the read becomes unavailable.
  const load = usePodLoad(
    query === undefined ? null : pod,
    (reader, signal) =>
      reader.sparql.select(query ?? '', {
        signal,
        ...(priority ? { priority } : {}),
      }),
    { key: query ?? root },
  );
  const data = load.data;
  const facts = useMemo(
    () => data && sourceFacts(data, root, podUrl, rules),
    [data, root, podUrl, rules],
  );
  const { kind } = load.state;
  const settled = kind !== 'loading';
  // Failed, refused, cancelled, or withdrawn: no data from this source.
  const failed = settled && kind !== 'ready';
  useEffect(
    () => report(id, { facts, settled, failed }),
    [id, facts, settled, failed, report],
  );
  // Unmount (root no longer admitted, connection gone) withdraws the facts.
  useEffect(() => () => report(id), [id, report]);
  return null;
});

function queryFor(root: string, rules: readonly CardRule[]) {
  try {
    return cardQuery(root, rules);
  } catch {
    return undefined;
  }
}

type PreviewState = 'shown' | 'loading' | 'unread' | 'unavailable' | 'absent';

function previewState(
  ready: boolean,
  url: string | undefined,
  urls: readonly string[],
  status: CardStatus,
  card: ResourceCard,
): PreviewState {
  if (ready) return 'shown';
  if (url) return 'loading';
  // Every address failed, or the attempts are used up.
  if (urls.length > 0) return 'unavailable';
  if (status.unread) return 'unread';
  if (status.unavailable || card.refused > 0) return 'unavailable';
  return 'absent';
}

/**
 * A bounded preview: ordinary `<img>` elements tried in order. After
 * `MAX_ATTEMPTS` failed addresses it tries no further one. The browser loads
 * them as it loads any image, without a Pod token. The placeholder keeps its
 * size in every state.
 */
export function ImagePreview({
  card,
  status,
  size = 48,
}: {
  readonly card: ResourceCard;
  readonly status: CardStatus;
  readonly size?: number;
}) {
  const t = useMessages(texts);
  const urls = previewCandidates(card.images);
  const [failed, setFailed] = useState<readonly string[]>([]);
  const [loaded, setLoaded] = useState<readonly string[]>([]);
  // Keep a loaded picture while it is still a candidate; a withdrawn address
  // is no candidate, so its element is removed in this render. After
  // MAX_ATTEMPTS failures, the preview tries no further address.
  const url =
    urls.find((value) => loaded.includes(value) && !failed.includes(value)) ??
    (failed.length < MAX_ATTEMPTS
      ? urls.find((value) => !failed.includes(value))
      : undefined);
  const ready = url !== undefined && loaded.includes(url);
  const state = previewState(ready, url, urls, status, card);
  const cell = { gridArea: '1 / 1', width: size, height: size };
  return (
    <span
      role="img"
      aria-label={t[state]}
      title={t[state]}
      data-state={state}
      style={{ display: 'inline-grid', overflow: 'hidden', ...cell }}
    >
      {url && (
        <img
          key={url}
          src={url}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          style={{ ...cell, objectFit: 'cover', opacity: ready ? 1 : 0 }}
          onLoad={() => setLoaded((old) => [...old, url])}
          onError={() => setFailed((old) => [...old, url])}
        />
      )}
      {!ready && (
        <span aria-hidden="true" className="card-placeholder" style={cell} />
      )}
    </span>
  );
}

function useDescribe() {
  const { format, language } = useSdkLocale();
  const t = useMessages(texts);
  return {
    t,
    language,
    describe: (date: Fact<DateTerm>) =>
      describeValue(date.value, {
        format,
        language,
        vocabulary: commonVocabulary,
        texts: t,
      }),
  };
}

/** A compact card: preview, label and the preferred date. */
export function ResourceCardView({
  card,
  status,
  label,
}: {
  readonly card: ResourceCard;
  readonly status: CardStatus;
  readonly label: string;
}) {
  const { t, describe } = useDescribe();
  const [first, ...others] = card.dates;
  const date = first && describe(first);
  return (
    <article aria-label={label} data-rule={card.rule}>
      <ImagePreview card={card} status={status} />
      <span dir="auto">{label}</span>
      {date && (
        <small lang={date.language} dir="auto">
          {' '}
          {date.text}
        </small>
      )}
      {others.length > 0 && <small> {t.moreDates(others.length)}</small>}
    </article>
  );
}

function Sources({ evidence }: { readonly evidence: readonly Evidence[] }) {
  const t = useMessages(texts);
  return (
    <ul>
      {evidence.map((e) => (
        <li key={JSON.stringify(e)} title={`${e.subject} ${e.predicate}`}>
          {t.from(e.pod, e.context)}
        </li>
      ))}
    </ul>
  );
}

/** Every date, picture variant and alias with the statements behind it. */
export function CardEvidence({ card }: { readonly card: ResourceCard }) {
  const { t, describe, language } = useDescribe();
  const rows: ReactNode[] = [];
  if (card.dates.length > 0)
    rows.push(
      <div key="dates">
        <dt>{t.dates}</dt>
        {card.dates.map((date) => {
          const shown = describe(date);
          return (
            <dd key={shown.exact}>
              <span lang={shown.language} dir="auto">
                {shown.text}
              </span>{' '}
              <code dir="ltr" style={{ whiteSpace: 'pre-wrap' }}>
                {shown.exact}
              </code>
              <Sources evidence={date.evidence} />
            </dd>
          );
        })}
      </div>,
    );
  card.images.forEach((image, index) =>
    rows.push(
      <div key={`image ${index}`}>
        <dt>{t.picture(index + 1)}</dt>
        {image.variants.map((variant) => (
          <dd key={variant.value}>
            <code dir="ltr">{variant.value}</code>
            <Sources evidence={variant.evidence} />
          </dd>
        ))}
      </div>,
    ),
  );
  if (card.sameAs.length > 0)
    rows.push(
      <div key="sameAs">
        <dt>{t.sameAs}</dt>
        {card.sameAs.map((alias) => (
          <dd key={alias.value}>
            {labelFor(alias.value, commonVocabulary, language)}{' '}
            <code dir="ltr">{`<${alias.value}>`}</code>
            <Sources evidence={alias.evidence} />
          </dd>
        ))}
      </div>,
    );
  return <dl>{rows}</dl>;
}

/**
 * App placeholder: a list with one card per resource; members joined by
 * `sameAs` share one entry. The app's own layout replaces it.
 */
export function CardList({
  runtime,
  roots,
}: {
  readonly runtime: BrowserRuntime;
  readonly roots: readonly string[];
}) {
  const { cards, status, readers } = useResourceCards(runtime, roots);
  const { language } = useSdkLocale();
  const shown = [...new Set(roots.flatMap((root) => cards.get(root) ?? []))];
  return (
    <>
      {readers}
      <ul>
        {shown.map((card) => (
          <li key={card.root}>
            <ResourceCardView
              card={card}
              status={status(card)}
              label={labelFor(card.root, commonVocabulary, language)}
            />
          </li>
        ))}
      </ul>
    </>
  );
}

/** The selected resource, read before the list's waiting reads. */
export function CardDetails({
  runtime,
  root,
}: {
  readonly runtime: BrowserRuntime;
  readonly root: string;
}) {
  const { cards, status, readers } = useResourceCards(runtime, [root], {
    priority: 'current',
  });
  const { language } = useSdkLocale();
  const card = cards.get(root);
  return (
    <section aria-label={labelFor(root, commonVocabulary, language)}>
      {readers}
      {card && (
        <>
          {/* A new resource starts with no failed or loaded addresses. */}
          <ImagePreview
            key={root}
            card={card}
            status={status(card)}
            size={160}
          />
          <CardEvidence card={card} />
        </>
      )}
    </section>
  );
}
