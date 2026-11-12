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
    statements: 'Statements',
    examples: 'Examples',
    examplesNote: 'A few statements per predicate, not all of them.',
    out: 'outgoing',
    in: 'incoming',
    loading: 'Loading',
    loadMore: 'Load more',
    retry: 'Retry',
    retryExamples: 'Retry examples',
    morePredicates: 'There are more predicates',
    from: (pod: string, context: string) => `${pod} · ${context}`,
  },
  de: {
    statements: 'Aussagen',
    examples: 'Beispiele',
    examplesNote: 'Einige Aussagen je Prädikat, nicht alle.',
    out: 'ausgehend',
    in: 'eingehend',
    loading: 'Wird geladen',
    loadMore: 'Mehr laden',
    retry: 'Erneut versuchen',
    retryExamples: 'Beispiele erneut laden',
    morePredicates: 'Es gibt weitere Prädikate',
    from: (pod: string, context: string) => `${pod} · ${context}`,
  },
};

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A connection that can read: bindPod never throws for it. */
const reads = ({ reading }: Connection) => reading !== null;

const directions: readonly Direction[] = ['out', 'in'];

/** `failed` also covers refused, cancelled and lost access. */
type ReadState = 'loading' | 'ready' | 'failed';
const stateOf = (state: LoadState<unknown>): ReadState =>
  state.kind === 'loading' || state.kind === 'ready' ? state.kind : 'failed';

interface Report {
  readonly data: Page | Sample | undefined;
  readonly kind: ReadState;
}
type Reporter = (id: string, value?: Report) => void;
type Register = (id: string, reload?: () => void) => void;

/** The state of one direction of one Pod. */
export interface SourceStatus {
  readonly connection: string;
  readonly pod: string;
  readonly direction: Direction;
  /** Pages asked for so far. */
  readonly pages: number;
  readonly loading: boolean;
  /** A page could not be read. */
  readonly failed: boolean;
  /** There is a next page: `loadMore` reads it. */
  readonly more: boolean;
  /** `none`: no sample, because the first page is not full or not read. */
  readonly sample: 'none' | ReadState;
  readonly morePredicates: boolean;
  readonly loadMore: () => void;
  /** Reads the failed pages again. */
  readonly retry: () => void;
  /** Reads the sample again. */
  readonly retrySample: () => void;
}

export interface NeighborhoodOptions {
  /** Contexts to hide. An inline array is fine. */
  readonly hidden?: readonly Area[];
  /** For what the person looks at now. */
  readonly priority?: 'current';
}

/**
 * The statements around `root` in every Pod that can be read: pages per
 * direction, and a sample when the first page is full. Render `readers`
 * once; they render nothing.
 */
export function useNeighborhood(
  runtime: BrowserRuntime,
  root: string,
  { hidden = [], priority }: NeighborhoodOptions = {},
) {
  // Order by Pod URL. Adapt it, for example to put the active Pod first.
  const connections = useConnections()
    .filter(reads)
    .sort((a, b) => compare(a.podUrl, b.podUrl) || compare(a.id, b.id));
  // Pages per Pod and direction; the first is always read.
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
  // Retries are kept outside of state: they never cause a render.
  const reloads = useRef(new Map<string, () => void>());
  const register = useCallback<Register>((id, reload) => {
    if (reload) reloads.current.set(id, reload);
    else reloads.current.delete(id);
  }, []);
  // A root that is no IRI is not read.
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
      // Only the first page decides the sample.
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
  // Only current reads count.
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
      const states = pages.map(({ report }) => report?.kind ?? 'loading');
      const last = pages.at(-1)!.report;
      const more =
        states.every((state) => state === 'ready') &&
        (last?.data as Page | undefined)?.truncated === true;
      return {
        connection: connection.id,
        pod: connection.podUrl,
        direction,
        pages: count,
        loading: states.includes('loading'),
        failed: states.includes('failed'),
        more,
        sample: sampleId ? (sample?.kind ?? 'loading') : 'none',
        morePredicates:
          sample?.kind === 'ready' && (sample.data as Sample).morePredicates,
        // A double click reads one page, not two.
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

/** Reports data, state and retry of one read until it unmounts. */
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
  const kind = stateOf(load.state);
  const { data, reload } = load;
  useEffect(() => report(id, { data, kind }), [id, data, kind, report]);
  useEffect(() => () => report(id), [id, report]);
  useEffect(() => {
    register(id, () => void reload());
    return () => register(id);
  }, [id, reload, register]);
}

// Memoized: one report re-renders the host, not every reader.
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
  // A new input is a new reader: a late answer of the old one never shows.
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
 * App placeholder: statements, examples apart from them, and controls per
 * Pod and direction. Replace it with the app's own view.
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
          {source.morePredicates && <small>{t.morePredicates}</small>}
        </div>
      ))}
    </>
  );
}
