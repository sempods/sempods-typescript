import { useState } from 'react';
import type { BrowserRuntime } from '@sempods/app-sdk';
import { fields, flag, text } from '@sempods/client-sdk/edit';
import {
  AppAccess,
  LoadNotice,
  SempodsProvider,
  UnresolvedNotices,
  UpdateNotice,
  useContextUpdate,
  usePodList,
  useSdkLocale,
} from '@sempods/app-sdk/react';

const schema = 'https://schema.org/';
const task = fields(
  {
    title: text(schema + 'name', { language: null }),
    done: flag(schema + 'actionStatus', {
      on: schema + 'CompletedActionStatus',
      off: schema + 'PotentialActionStatus',
    }),
  },
  { type: schema + 'Action' },
);

/**
 * One click ticks a task on an overview row, in the row's own Context, like a
 * row of the TODO list: `usePodList` reads the tasks of every readable Context
 * as snapshots, `useContextUpdate` writes one of them against the version the
 * list read (If-Match). Rows in several Contexts can be ticked at once, the
 * selection stays as it is, and nothing is shown as changed before the Pod
 * confirms it or resent: a conflict or a lost answer shows its notice with
 * its own recovery. Place inside a `SempodsProvider`, for example with
 * `contextSelection="on-demand"`.
 */
export function TasksOverview() {
  const list = usePodList(task);
  const overview = useContextUpdate(task);
  const { messages: m } = useSdkLocale();
  return (
    <section aria-label="Tasks across my Pod">
      <h1>Tasks across my Pod</h1>
      <LoadNotice {...list} />
      <ul>
        {list.data?.items.map((item) => {
          const row = overview.for(item);
          return (
            <li key={`${item.context} ${item.snapshot.iri}`}>
              <label>
                <input
                  type="checkbox"
                  checked={row.data.done}
                  disabled={!row.canMutate}
                  onChange={(event) =>
                    void row.update({ done: event.target.checked })
                  }
                />
                {row.data.title}
              </label>
              {row.problem && (
                <p role="status">{m.contextProblems![row.problem]}</p>
              )}
              <UpdateNotice {...row.notice} />
            </li>
          );
        })}
      </ul>
      {/* A write whose row is gone, for example deleted elsewhere. */}
      <UnresolvedNotices of={overview} shown={list.data?.items} />
    </section>
  );
}

/** The host creates/disposes the stable runtime and serves this on the callback too. */
export function OverviewToggleExample({
  runtime,
}: {
  readonly runtime: BrowserRuntime;
}) {
  const [manage, setManage] = useState(false);
  return (
    <SempodsProvider runtime={runtime} contextSelection="on-demand">
      <OverviewToggleContent manage={manage} onManage={setManage} />
    </SempodsProvider>
  );
}

function OverviewToggleContent({
  manage,
  onManage,
}: {
  readonly manage: boolean;
  readonly onManage: (open: boolean) => void;
}) {
  const { messages: m } = useSdkLocale();
  return (
    <main>
      <button aria-expanded={manage} onClick={() => onManage(!manage)}>
        {m.controls.dataAccess}
      </button>
      <AppAccess appName="Tasks overview" open={manage} />
      <TasksOverview />
    </main>
  );
}
