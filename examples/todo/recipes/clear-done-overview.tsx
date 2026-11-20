import { useState } from 'react';
import type { BoundPod, BrowserRuntime } from '@sempods/app-sdk';
import {
  AppAccess,
  LoadNotice,
  RemoveButton,
  SempodsProvider,
  UnresolvedNotices,
  UpdateNotice,
  useAppState,
  useContexts,
  useContextUpdate,
  usePodList,
  useSdkLocale,
} from '@sempods/app-sdk/react';
import { ActionButton, Button, DeleteIcon } from '@sempods/app-ui';
import { taskFields } from '../src/domain.js';
import {
  ConfirmRemoval,
  doneTasks,
  summary,
  useRemoveRows,
  type Remove,
} from './remove-rows.js';

/** One captured row: its command, and what names it in the summary. */
interface Captured {
  readonly remove: Remove;
  readonly title: string;
  readonly context: string;
  readonly area: string;
}
/** What the question shows: the counts by area and the read-only rows kept. */
interface Capture {
  /** The authorization it was read under: its details are shown under it only. */
  readonly pod: BoundPod | null;
  readonly rows: readonly Captured[];
  readonly areas: readonly {
    readonly context: string;
    readonly name: string;
    readonly count: number;
  }[];
  readonly readOnly: number;
}

/**
 * Clearing the done tasks of every readable Context of the Pod, after one
 * confirmation, as `clear-done.tsx` does for one list:
 *
 * - **capture**: when the question opens, the row commands of the done rows
 *   shown in a writable area. Each one deletes the version it showed, in the
 *   Context where it was read, so the same IRI in two areas is two rows. A row
 *   completed later, or reopened, is not deleted by it. A row whose own write
 *   is pending or awaits its recovery is left out; its notice shows.
 * - **confirm**: the total once in the question, the areas below it with
 *   their counts, and how many read-only rows are kept.
 * - **run** and **summary**: shared with the single list (`useRemoveRows`).
 *   The overview shows only done tasks, so a row that stopped the run
 *   (reopened elsewhere, a lost response) can leave it; `UnresolvedNotices`
 *   with the rows shown keeps its recovery reachable.
 * - **scope**: titles and area names are shown only under the authorization
 *   they were read with, and only while their area is still readable. The
 *   question closes when either ends; the summary then keeps its counts but
 *   no longer names the row.
 *
 * The app decides the areas' names, which rows are included and the texts;
 * here `useContexts` names the areas and says which may be written. Place
 * inside a `SempodsProvider`, for example with `contextSelection="on-demand"`.
 */
export function ClearDoneOverview() {
  const list = usePodList(taskFields);
  const overview = useContextUpdate(taskFields);
  const { contexts } = useContexts();
  // The active authorization: a sign-out or another sign-in replaces it.
  const { pod } = useAppState();
  const { messages: m, format } = useSdkLocale();
  const { removal, running, run, result } = useRemoveRows();
  const [asking, setAsking] = useState<Capture | null>(null);
  // The capture the last run sent, to name the row that stopped it.
  const [sent, setSent] = useState<Capture | null>(null);
  const areas = new Map(contexts.map((c) => [c.iri, c]));
  const name = (context: string) => areas.get(context)?.name ?? context;
  // Like a Completed view: only done rows are shown.
  const shown = (list.data?.items ?? []).filter(
    (item) => overview.for(item).data.done,
  );
  const writable = shown.filter(
    (item) => areas.get(item.context)?.writable === true,
  );
  const deletable = writable.filter((item) => overview.for(item).canMutate);

  const capture = (): Capture => {
    const counts = new Map<string, number>();
    for (const item of deletable)
      counts.set(item.context, (counts.get(item.context) ?? 0) + 1);
    return {
      pod,
      rows: deletable.map((item) => {
        const row = overview.for(item);
        return {
          remove: row.remove,
          title: row.data.title,
          context: item.context,
          area: name(item.context),
        };
      }),
      areas: [...counts].map(([context, count]) => ({
        context,
        name: name(context),
        count,
      })),
      readOnly: shown.length - writable.length,
    };
  };
  // Read under this authorization, from an area still readable.
  const readable = (capture: Capture, context: string) =>
    capture.pod === pod && areas.has(context);
  // The question goes once what it names may no longer be read.
  if (asking && !asking.areas.every((area) => readable(asking, area.context)))
    setAsking(null);
  const at = removal?.stop?.at;
  const stopped = at === undefined ? undefined : sent?.rows[at];
  const named = stopped && sent && readable(sent, stopped.context);

  return (
    <section aria-label="Done tasks across my Pod">
      <h1>Done tasks across my Pod</h1>
      <LoadNotice {...list} />
      <ul>
        {shown.map((item) => {
          const row = overview.for(item);
          return (
            <li key={`${item.context} ${item.snapshot.iri}`}>
              <div className="flex min-h-11 items-center gap-2">
                <span className="min-w-0 flex-1 wrap-anywhere">
                  {row.data.title} · {name(item.context)}
                </span>
                {/* The same task can be in two areas: the name says which. */}
                <RemoveButton
                  label={`Delete: ${row.data.title} in ${name(item.context)}`}
                  question={`Delete “${row.data.title}” from ${name(item.context)}? This cannot be undone.`}
                  disabled={!row.canMutate}
                  onRemove={row.remove}
                />
              </div>
              {row.problem && (
                <p role="status">{m.contextProblems![row.problem]}</p>
              )}
              <UpdateNotice {...row.notice} />
            </li>
          );
        })}
      </ul>
      {/* A row that left the overview, reopened or deleted elsewhere. */}
      <UnresolvedNotices of={overview} shown={shown} />
      <ActionButton
        variant="secondary"
        isDisabled={deletable.length === 0 && !running}
        isPending={running}
        onPress={() => setAsking(capture())}
      >
        <DeleteIcon />
        Clear done tasks
      </ActionButton>
      {asking && (
        <ConfirmRemoval
          question={`Delete ${doneTasks(asking.rows.length)} from the Pod?`}
          onClose={() => setAsking(null)}
          onDelete={() => {
            setSent(asking);
            void run(asking.rows.map((row) => row.remove));
          }}
        >
          {/* Many areas scroll here, so Cancel and Delete stay on screen. */}
          <dl
            className="m-0 grid max-h-[40dvh] gap-1 overflow-y-auto rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            tabIndex={0}
          >
            {asking.areas.map((area) => (
              <div
                key={area.context}
                className="flex items-baseline justify-between gap-4"
              >
                <dt className="min-w-0 wrap-anywhere">{area.name}</dt>
                <dd className="m-0 shrink-0 tabular-nums">
                  {format.number(area.count)}
                </dd>
              </div>
            ))}
          </dl>
          {asking.readOnly > 0 && (
            <p className="m-0 text-muted-foreground">
              {asking.readOnly === 1
                ? '1 read-only task is kept.'
                : `${asking.readOnly} read-only tasks are kept.`}
            </p>
          )}
        </ConfirmRemoval>
      )}
      {removal && (
        <p
          ref={result}
          tabIndex={-1}
          role={removal.phase === 'stopped' ? 'alert' : 'status'}
        >
          {summary(removal, {
            ...(named && {
              stopped: `“${stopped.title}” in ${stopped.area}`,
            }),
            ended: 'An area or its access changed.',
          })}
        </p>
      )}
    </section>
  );
}

/** The host creates/disposes the stable runtime and serves this on the callback too. */
export function ClearDoneOverviewExample({
  runtime,
}: {
  readonly runtime: BrowserRuntime;
}) {
  return (
    <SempodsProvider runtime={runtime} contextSelection="on-demand">
      <ClearDoneOverviewContent />
    </SempodsProvider>
  );
}

function ClearDoneOverviewContent() {
  const [manage, setManage] = useState(false);
  const { messages: m } = useSdkLocale();
  return (
    <main>
      <Button
        variant="ghost"
        className="min-h-11 px-3"
        aria-expanded={manage}
        onPress={() => setManage(!manage)}
      >
        {m.controls.dataAccess}
      </Button>
      <AppAccess appName="Done tasks overview" open={manage} />
      <ClearDoneOverview />
    </main>
  );
}
