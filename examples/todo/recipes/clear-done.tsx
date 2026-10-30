import { useRef, useState } from 'react';
import type { BrowserRuntime } from '@sempods/app-sdk';
import {
  AppAccess,
  LoadNotice,
  SempodsProvider,
  TargetScreen,
  UnresolvedNotices,
  UpdateNotice,
  useFieldUpdate,
  useList,
  useSdkLocale,
  type FieldUpdateRow,
} from '@sempods/app-sdk/react';
import { taskFields, type Task } from '../src/domain.js';

/** A captured row command: it keeps its snapshot and target. */
type Remove = FieldUpdateRow<Task>['remove'];
/** Why a run stopped: the first answer other than `removed`. */
type Stop = Exclude<Awaited<ReturnType<Remove>>, { readonly kind: 'removed' }>;

/**
 * One person's decision applied to a captured set of rows.
 *
 * - **capture**: the done rows shown now, with their row commands. A row that
 *   appears later, or one that is open, is not part of it.
 * - **confirm**: the scope and the number, before anything is sent; Cancel
 *   sends nothing.
 * - **run**: one conditional DELETE after the other, each of the version its
 *   row showed, in the row's own target. The first answer other than
 *   `removed` stops the run: a row changed or reopened elsewhere
 *   (`changed-on-pod`), an unconfirmed answer, a refusal, or a command that
 *   sends nothing because the Context, the Pod or access changed (`not-sent`).
 *   Nothing is retried and the rest stays unsent.
 * - **summary**: how many were removed, which one stopped the run and how
 *   many were not sent. The stopped row keeps its SDK recovery through
 *   `UnresolvedNotices`, also when it leaves this filtered view. The summary
 *   belongs to this screen: after another Context is chosen, the screen shows
 *   that list, and the old one keeps its unsent rows untouched.
 *
 * A switch is blocked while a removal is pending, as for any row write; the
 * leave policy decides between two removals, and the next command then
 * sends nothing.
 */
type Batch =
  | { readonly phase: 'confirm'; readonly removes: readonly Remove[] }
  | {
      readonly phase: 'running' | 'stopped' | 'done';
      readonly total: number;
      readonly removed: number;
      readonly stop?: Stop;
    };

const tasks = (n: number) => (n === 1 ? '1 done task' : `${n} done tasks`);

export function ClearDone() {
  const list = useList(taskFields);
  // One hook for the rows: each removal uses its row's own write lane.
  const mutate = useFieldUpdate(taskFields);
  const [batch, setBatch] = useState<Batch | null>(null);
  const confirm = useRef<HTMLDivElement>(null);
  const items = list.data?.items ?? [];
  const rows = items.map((item) => ({ item, row: mutate.for(item) }));
  const done = rows.filter(({ row }) => row.data.done && row.canMutate);
  const running = batch?.phase === 'running';

  const run = async (removes: readonly Remove[]) => {
    let removed = 0;
    setBatch({ phase: 'running', total: removes.length, removed });
    for (const remove of removes) {
      const outcome = await remove();
      if (outcome.kind !== 'removed') {
        setBatch({
          phase: 'stopped',
          total: removes.length,
          removed,
          stop: outcome,
        });
        return;
      }
      removed++;
      setBatch({ phase: 'running', total: removes.length, removed });
    }
    setBatch({ phase: 'done', total: removes.length, removed });
  };

  return (
    <section aria-label="Tasks">
      <LoadNotice {...list} />
      <ul>
        {rows.map(({ item, row }) => (
          <li key={item.iri}>
            {row.data.done ? '✓ ' : ''}
            {row.data.title}
            <UpdateNotice {...row.notice} quiet />
          </li>
        ))}
      </ul>
      {/* The stopped row keeps its recovery, also once it is not shown. */}
      <UnresolvedNotices of={mutate} shown={items} />
      <button
        disabled={done.length === 0 || running || batch?.phase === 'confirm'}
        onClick={() => {
          // Captured now: later rows are not part of this decision.
          setBatch({
            phase: 'confirm',
            removes: done.map(({ row }) => row.remove),
          });
          queueMicrotask(() => confirm.current?.focus());
        }}
      >
        Clear done tasks
      </button>
      {batch?.phase === 'confirm' && (
        <div
          ref={confirm}
          tabIndex={-1}
          role="alertdialog"
          aria-labelledby="clear-done-question"
        >
          <p id="clear-done-question">
            Delete {tasks(batch.removes.length)} from this list?
          </p>
          <button onClick={() => setBatch(null)}>Cancel</button>
          <button onClick={() => void run(batch.removes)}>Delete</button>
        </div>
      )}
      {batch && batch.phase !== 'confirm' && (
        <p role={batch.phase === 'stopped' ? 'alert' : 'status'}>
          {summary(batch)}
        </p>
      )}
    </section>
  );
}

function summary(batch: Exclude<Batch, { readonly phase: 'confirm' }>) {
  const count = (n: number, one: string, many: string) =>
    n === 1 ? `1 ${one}` : `${n} ${many}`;
  if (batch.phase === 'running')
    return `Deleting… ${batch.removed} of ${batch.total}.`;
  const removed = count(batch.removed, 'task deleted', 'tasks deleted') + '.';
  if (batch.phase === 'done') return removed;
  // The stopping row was sent unless its command sent nothing.
  const sent = batch.stop?.kind === 'not-sent' ? 0 : 1;
  const unsent = batch.total - batch.removed - sent;
  const why = sent
    ? ' One task needs your attention; see its notice.'
    : ' The list or its access changed.';
  const rest = unsent
    ? ' ' + count(unsent, 'task was', 'tasks were') + ' not sent.'
    : '';
  return removed + why + rest;
}

/** The host creates/disposes the stable runtime and serves this on the callback too. */
export function ClearDoneExample({
  runtime,
}: {
  readonly runtime: BrowserRuntime;
}) {
  return (
    <SempodsProvider runtime={runtime}>
      <ClearDoneContent />
    </SempodsProvider>
  );
}

function ClearDoneContent() {
  const [manage, setManage] = useState(false);
  const { messages: m } = useSdkLocale();
  return (
    <main>
      <button aria-expanded={manage} onClick={() => setManage(!manage)}>
        {m.controls.dataAccess}
      </button>
      <AppAccess appName="Clear done tasks" open={manage} />
      <TargetScreen>
        <ClearDone />
      </TargetScreen>
    </main>
  );
}
