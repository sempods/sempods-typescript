import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type {
  BoundPod,
  BrowserRuntime,
  Connection,
  LoadState,
} from '@sempods/app-sdk';
import {
  useConnections,
  useMessages,
  usePodLoad,
} from '@sempods/app-sdk/react';
import {
  hiddenIn,
  isIri,
  neighborhood,
  PAGE_SIZE,
  pageRead,
  sampleInput,
  sampleRead,
  type Area,
  type Direction,
  type Page,
  type Sample,
  type SampleInput,
  type Statement,
} from './neighborhood.js';
import { exactTerm } from './rdf-values.js';

const texts = {
  en: {
    statements: 'Relationships',
    examples: 'Examples of other kinds',
    examplesNote:
      'A few examples per kind, not all of them. Load more pages for the complete list.',
    out: 'outgoing',
    in: 'incoming',
    loading: 'Loading',
    loadMore: 'Load more',
    retry: 'Retry',
    retryExamples: 'Retry examples',
    moreKinds: 'More kinds exist than examples show',
    from: (pod: string, context: string) => `${pod} · ${context}`,
  },
  de: {
    statements: 'Beziehungen',
    examples: 'Beispiele weiterer Arten',
    examplesNote:
      'Einige Beispiele je Art, nicht alle. Weitere Seiten laden für die vollständige Liste.',
    out: 'ausgehend',
    in: 'eingehend',
    loading: 'Wird geladen',
    loadMore: 'Mehr laden',
    retry: 'Erneut versuchen',
    retryExamples: 'Beispiele erneut laden',
    moreKinds: 'Es gibt mehr Arten, als Beispiele zeigen',
    from: (pod: string, context: string) => `${pod} · ${context}`,
  },
};

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Reading (signed in, or without a token): bindPod never throws for it. */
const reads = ({ reading }: Connection) => reading !== null;

const directions: readonly Direction[] = ['out', 'in'];

type Kind = 'loading' | 'ready' | 'failed';
/** Failed, refused, cancelled or withdrawn: no data from this read. */
const kindOf = (state: LoadState<unknown>): Kind =>
  state.kind === 'loading' || state.kind === 'ready' ? state.kind : 'failed';

interface Report {
  readonly data: Page | Sample | undefined;
  readonly kind: Kind;
}
type Reporter = (id: string, value?: Report) => void;
type Register = (id: string, reload?: () => void) => void;

/** What one direction of one reading connection says beyond its statements. */
export interface SourceStatus {
  readonly connection: string;
  readonly pod: string;
  readonly direction: Direction;
  /** Ordinary pages requested so far. */
  readonly pages: number;
  /** A page has not answered yet. */
  readonly loading: boolean;
  /** A page failed, was refused, cancelled or lost access. */
  readonly failed: boolean;
  /** Every page answered and the last one was cut: `loadMore` reads the next. */
  readonly more: boolean;
  /** `none`: the first page is complete or has not answered. */
  readonly sample: 'none' | Kind;
  /** The sample found more kinds than it shows. */
  readonly moreKinds: boolean;
  readonly loadMore: () => void;
  /** Reads the failed pages of this source again. */
  readonly retry: () => void;
  /** Reads the sample again; the pages stay. */
  readonly retrySample: () => void;
}

export interface NeighborhoodOptions {
  /** Contexts the app hides. An inline array is fine: it is compared by value. */
  readonly hidden?: readonly Area[];
  /** For what the person looks at now, such as the selected resource. */
  readonly priority?: 'current';
}

/**
 * The neighborhood of `root` from every reading connection: per direction,
 * the ordinary pages the app asked for, and a sample when the first page is
 * cut. Render `readers` once; they render nothing. `podReadLimit` on the
 * runtime bounds the requests; the app decides when to load more.
 */
export function useNeighborhood(
  runtime: BrowserRuntime,
  root: string,
  { hidden = [], priority }: NeighborhoodOptions = {},
) {
  // Source order: Pod URL, then connection. Adapt it, for example to put the
  // active Pod first.
  const connections = useConnections()
    .filter(reads)
    .sort((a, b) => compare(a.podUrl, b.podUrl) || compare(a.id, b.id));
  // Pages per source and direction; the first is always read.
  const [counts, setCounts] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  const [reports, setReports] = useState<ReadonlyMap<string, Report>>(
    () => new Map(),
  );
  const report = useCallback<Reporter>((id, value) => {
    setReports((old) => {
      const next = new Map(old);
      if (value) next.set(id, value);
      else next.delete(id);
      return next;
    });
  }, []);
  // Retries are actions, not state: keeping them renders nothing.
  const reloads = useRef(new Map<string, () => void>());
  const register = useCallback<Register>((id, reload) => {
    if (reload) reloads.current.set(id, reload);
    else reloads.current.delete(id);
  }, []);
  // A root that is no IRI is not read: its sources become unavailable.
  const valid = isIri(root);
  const sources = connections.flatMap((connection) =>
    directions.map((direction) => {
      const base = JSON.stringify([connection.id, root, direction]);
      const count = counts.get(base) ?? 1;
      const pages = Array.from({ length: count }, (_, index) => {
        const id = JSON.stringify(['page', base, index]);
        return { id, offset: index * PAGE_SIZE, report: reports.get(id) };
      });
      const first = pages[0]!.report;
      // Only the first page decides the sample: later pages never restart it.
      const input =
        first?.kind === 'ready'
          ? sampleInput(
              root,
              direction,
              first.data as Page,
              hiddenIn(hidden, connection.podUrl),
            )
          : undefined;
      const sampleId = input && JSON.stringify(['sample', base, input]);
      return {
        connection,
        direction,
        base,
        count,
        pages,
        input,
        sampleId,
        sample: sampleId ? reports.get(sampleId) : undefined,
      };
    }),
  );
  // Only current reads count, also before a removed reader's cleanup ran.
  const { statements, examples } = neighborhood(
    sources.map((source) => ({
      pages: source.pages.map(
        ({ report }) =>
          (report?.kind === 'ready' ? report.data : undefined) as
            Page | undefined,
      ),
      sample: (source.sample?.kind === 'ready'
        ? source.sample.data
        : undefined) as Sample | undefined,
    })),
    hidden,
  );
  const status = sources.map(
    ({ connection, direction, base, count, pages, sampleId, sample }) => {
      const kinds = pages.map(({ report }) => report?.kind ?? 'loading');
      const last = pages.at(-1)!.report;
      const more =
        kinds.every((kind) => kind === 'ready') &&
        (last?.data as Page | undefined)?.truncated === true;
      return {
        connection: connection.id,
        pod: connection.podUrl,
        direction,
        pages: count,
        loading: kinds.includes('loading'),
        failed: kinds.includes('failed'),
        more,
        sample: sampleId ? (sample?.kind ?? 'loading') : 'none',
        moreKinds:
          sample?.kind === 'ready' && (sample.data as Sample).moreKinds,
        // Compared with the count it was offered for: a double click reads
        // one page, not two.
        loadMore: () => {
          if (more)
            setCounts((old) =>
              (old.get(base) ?? 1) === count
                ? new Map(old).set(base, count + 1)
                : old,
            );
        },
        retry: () => {
          for (const page of pages)
            if (page.report?.kind === 'failed')
              reloads.current.get(page.id)?.();
        },
        retrySample: () => {
          if (sampleId) reloads.current.get(sampleId)?.();
        },
      } satisfies SourceStatus;
    },
  );
  const readers = sources.flatMap(
    ({ connection, direction, pages, input, sampleId }) => {
      const pod = valid ? runtime.bindPod(connection.id) : null;
      return [
        ...pages.map(({ id, offset }) => (
          <PageReader
            key={id}
            id={id}
            pod={pod}
            root={root}
            direction={direction}
            offset={offset}
            priority={priority}
            report={report}
            register={register}
          />
        )),
        ...(input && sampleId
          ? [
              <SampleReader
                key={sampleId}
                id={sampleId}
                pod={pod}
                input={input}
                priority={priority}
                report={report}
                register={register}
              />,
            ]
          : []),
      ];
    },
  );
  return { statements, examples, sources: status, readers };
}

/** Reports a read's data and state, and its retry, until it unmounts. */
function useReport(
  id: string,
  load: {
    readonly state: LoadState<Page | Sample>;
    readonly data: Page | Sample | undefined;
    readonly reload: () => Promise<unknown>;
  },
  report: Reporter,
  register: Register,
) {
  const kind = kindOf(load.state);
  const { data, reload } = load;
  useEffect(() => report(id, { data, kind }), [id, data, kind, report]);
  // Unmount (root changed, connection gone, new sample input) withdraws it.
  useEffect(() => () => report(id), [id, report]);
  useEffect(() => {
    register(id, () => void reload());
    return () => register(id);
  }, [id, reload, register]);
}

// Memoized: a report from one read re-renders the host, not every read.
const PageReader = memo(function PageReader(props: {
  readonly id: string;
  readonly pod: BoundPod | null;
  readonly root: string;
  readonly direction: Direction;
  readonly offset: number;
  readonly priority: 'current' | undefined;
  readonly report: Reporter;
  readonly register: Register;
}) {
  const { id, pod, root, direction, offset, priority } = props;
  const load = usePodLoad<Page | Sample>(
    pod,
    (target, signal) =>
      pageRead(root, direction, offset, priority)(target, signal),
    { key: id },
  );
  useReport(id, load, props.report, props.register);
  return null;
});

const SampleReader = memo(function SampleReader(props: {
  readonly id: string;
  readonly pod: BoundPod | null;
  readonly input: SampleInput;
  readonly priority: 'current' | undefined;
  readonly report: Reporter;
  readonly register: Register;
}) {
  const { id, pod, input, priority } = props;
  // The id holds the whole input: a new input is a new reader, and the old
  // one's late answer never shows.
  const load = usePodLoad<Page | Sample>(
    pod,
    (target, signal) => sampleRead(input, priority)(target, signal),
    { key: id },
  );
  useReport(id, load, props.report, props.register);
  return null;
});

function StatementView({ statement }: { readonly statement: Statement }) {
  const t = useMessages(texts);
  return (
    <>
      <span>{t[statement.direction]}</span>{' '}
      <code dir="ltr">{`<${statement.predicate}>`}</code>{' '}
      <code dir="ltr" style={{ whiteSpace: 'pre-wrap' }}>
        {exactTerm(statement.other)}
      </code>{' '}
      <small>{t.from(statement.pod, statement.context)}</small>
    </>
  );
}

/**
 * App placeholder: the statements, the examples apart from them, and one row
 * of controls per source and direction. The app's own graph and the place of
 * its load-more controls replace it.
 */
export function NeighborhoodList({
  runtime,
  root,
  hidden,
}: {
  readonly runtime: BrowserRuntime;
  readonly root: string;
  readonly hidden?: readonly Area[];
}) {
  const t = useMessages(texts);
  const { statements, examples, sources, readers } = useNeighborhood(
    runtime,
    root,
    hidden ? { hidden, priority: 'current' } : { priority: 'current' },
  );
  return (
    <>
      {readers}
      <ul aria-label={t.statements}>
        {statements.map((statement) => (
          <li key={statement.key}>
            <StatementView statement={statement} />
          </li>
        ))}
      </ul>
      {examples.length > 0 && (
        <section aria-label={t.examples}>
          <p>{t.examplesNote}</p>
          <ul>
            {examples.map((statement) => (
              <li key={statement.key}>
                <StatementView statement={statement} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {sources.map((source) => (
        <div
          key={`${source.connection} ${source.direction}`}
          role="group"
          aria-label={`${source.pod} ${t[source.direction]}`}
        >
          {source.loading && <span>{t.loading}</span>}
          {source.failed && (
            <button type="button" onClick={source.retry}>
              {t.retry}
            </button>
          )}
          {source.more && (
            <button type="button" onClick={source.loadMore}>
              {t.loadMore}
            </button>
          )}
          {source.sample === 'failed' && (
            <button type="button" onClick={source.retrySample}>
              {t.retryExamples}
            </button>
          )}
          {source.moreKinds && <small>{t.moreKinds}</small>}
        </div>
      ))}
    </>
  );
}
