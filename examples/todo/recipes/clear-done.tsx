import { useState } from 'react';
import type { BrowserRuntime } from '@sempods/app-sdk';
import {
  AppAccess,
  LoadNotice,
  RemoveButton,
  SempodsProvider,
  TargetScreen,
  UnresolvedNotices,
  UpdateNotice,
  useFieldUpdate,
  useList,
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

/**
 * One person's decision applied to a captured set of rows.
 *
 * - **capture**: the done rows shown now, with their row commands. A row that
 *   appears later, or one that is open, is not part of it.
 * - **confirm**: the scope and the number, before anything is sent; Cancel
 *   sends nothing.
 * - **run** (`useRemoveRows`): one row command after the other, stopping at
 *   the first answer other than `removed`; nothing is retried.
 * - **summary**: how many were removed, why the run stopped and how many
 *   were not sent. The stopped row keeps its SDK recovery through
 *   `UnresolvedNotices`, also when it leaves this filtered view. The summary
 *   belongs to this screen: after another Context is chosen, the screen shows
 *   that list, and the old one keeps its unsent rows untouched.
 *
 * A single row is deleted with a plain `RemoveButton`; the bulk action shows
 * the same `DeleteIcon`. Each button's name says what it deletes.
 *
 * A switch is blocked while a removal is pending, as for any row write; the
 * leave policy decides between two removals, and the next command then
 * sends nothing.
 */
export function ClearDone() {
  const list = useList(taskFields);
  // One hook for the rows: each removal uses its row's own write lane.
  const mutate = useFieldUpdate(taskFields);
  const { removal, running, run, result } = useRemoveRows();
  // The commands captured when the question opened.
  const [asking, setAsking] = useState<readonly Remove[] | null>(null);
  const items = list.data?.items ?? [];
  const rows = items.map((item) => ({ item, row: mutate.for(item) }));
  const done = rows.filter(({ row }) => row.data.done && row.canMutate);

  return (
    <section aria-label="Tasks">
      <LoadNotice {...list} />
      <ul>
        {rows.map(({ item, row }) => (
          <li key={item.iri} className="flex min-h-11 items-center gap-2">
            <span className="min-w-0 flex-1 wrap-anywhere">
              {row.data.done ? '✓ ' : ''}
              {row.data.title}
            </span>
            <RemoveButton
              label={`Delete: ${row.data.title}`}
              disabled={!row.canMutate}
              onRemove={row.remove}
            />
            <UpdateNotice {...row.notice} quiet />
          </li>
        ))}
      </ul>
      {/* The stopped row keeps its recovery, also once it is not shown. */}
      <UnresolvedNotices of={mutate} shown={items} />
      <ActionButton
        variant="secondary"
        isDisabled={done.length === 0 && !running}
        // Pending keeps the focus the closed question returned to it; once
        // nothing is left, the summary takes it.
        isPending={running}
        // Captured now: later rows are not part of this decision.
        onPress={() => setAsking(done.map(({ row }) => row.remove))}
      >
        <DeleteIcon />
        Clear done tasks
      </ActionButton>
      {asking && (
        <ConfirmRemoval
          question={`Delete ${doneTasks(asking.length)} from this list?`}
          onClose={() => setAsking(null)}
          onDelete={() => void run(asking)}
        />
      )}
      {removal && (
        <p
          ref={result}
          tabIndex={-1}
          role={removal.phase === 'stopped' ? 'alert' : 'status'}
        >
          {summary(removal)}
        </p>
      )}
    </section>
  );
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
      <Button
        variant="ghost"
        className="min-h-11 px-3"
        aria-expanded={manage}
        onPress={() => setManage(!manage)}
      >
        {m.controls.dataAccess}
      </Button>
      <AppAccess appName="Clear done tasks" open={manage} />
      <TargetScreen>
        <ClearDone />
      </TargetScreen>
    </main>
  );
}
