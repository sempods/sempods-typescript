import { useRef, useState, type ReactNode } from 'react';
import { useSdkLocale, type FieldUpdateRow } from '@sempods/app-sdk/react';
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@sempods/app-ui';

/**
 * The part both clear-done recipes share: one person's decision applied to
 * row commands captured when the confirmation opened (`clear-done.tsx` for
 * one list, `clear-done-overview.tsx` across the Contexts of a Pod).
 */

/** A captured row command: it keeps its snapshot and target. */
export type Remove = FieldUpdateRow<unknown>['remove'];
/** Why a run stopped: the first answer other than `removed`. */
export type Stop = Exclude<
  Awaited<ReturnType<Remove>>,
  { readonly kind: 'removed' }
>;

export interface Removal {
  readonly phase: 'running' | 'stopped' | 'done';
  readonly total: number;
  readonly removed: number;
  /** The first answer other than `removed`, and the index of its command. */
  readonly stop?: { readonly outcome: Stop; readonly at: number };
}

/**
 * One conditional DELETE after the other, each of the version its row
 * showed, in the row's own target. The first answer other than `removed`
 * stops the run: a row changed or reopened elsewhere (`changed-on-pod`), an
 * unconfirmed answer such as a lost response, a refusal, or a command that
 * sends nothing (`not-sent`): the Context, the Pod or access changed, or the
 * row's own delete or change started meanwhile has no answer yet.
 * Nothing is retried and the rest stays unsent. The stopped row keeps its
 * SDK recovery: render `UnresolvedNotices` with the rows the screen shows.
 * Render the summary with `ref={result}` and `tabIndex={-1}`: when the run
 * ends with the focus lost, for example on the bulk action that has nothing
 * left to delete, it moves there.
 */
export function useRemoveRows() {
  const [removal, setRemoval] = useState<Removal | null>(null);
  const result = useRef<HTMLParagraphElement>(null);
  const settle = () =>
    requestAnimationFrame(() => {
      const focused = document.activeElement;
      if (
        !focused ||
        focused === document.body ||
        focused.matches(':disabled') ||
        !focused.isConnected
      )
        result.current?.focus();
    });
  const run = async (removes: readonly Remove[]) => {
    const total = removes.length;
    let removed = 0;
    setRemoval({ phase: 'running', total, removed });
    for (const [at, remove] of removes.entries()) {
      const outcome = await remove();
      if (outcome.kind !== 'removed') {
        setRemoval({ phase: 'stopped', total, removed, stop: { outcome, at } });
        settle();
        return;
      }
      removed++;
      setRemoval({ phase: 'running', total, removed });
    }
    setRemoval({ phase: 'done', total, removed });
    settle();
  };
  return { removal, running: removal?.phase === 'running', run, result };
}

const count = (n: number, one: string, many: string) =>
  n === 1 ? `1 ${one}` : `${n} ${many}`;

/** "1 done task", "3 done tasks": the question's number. */
export const doneTasks = (n: number) => count(n, 'done task', 'done tasks');

/**
 * Progress, then the confirmed count, why it stopped and the unsent rest.
 * It names no row: the stopped row's notice does, while the row may be read.
 * `ended` says what changed when a command sent nothing because the list, the
 * Pod or access changed.
 */
export function summary(
  removal: Removal,
  { ended = 'The list or its access changed.' } = {},
) {
  if (removal.phase === 'running')
    return `Deleting… ${removal.removed} of ${removal.total}.`;
  const removed = count(removal.removed, 'task deleted', 'tasks deleted') + '.';
  if (removal.phase === 'done' || !removal.stop) return removed;
  const { outcome } = removal.stop;
  // The stopping row was sent unless its command sent nothing.
  const sent = outcome.kind === 'not-sent' ? 0 : 1;
  const unsent = removal.total - removal.removed - sent;
  const rest = unsent
    ? ' ' + count(unsent, 'task was', 'tasks were') + ' not sent.'
    : '';
  return `${removed} ${why(outcome, ended)}${rest}`;
}

/** Why the run stopped at a row: its answer, or why its command sent nothing. */
function why(outcome: Stop, ended: string) {
  const row = 'One task';
  if (outcome.kind !== 'not-sent')
    return `${row} needs your attention; see its notice.`;
  switch (outcome.reason) {
    // Its own delete or change, started meanwhile, had no answer yet.
    case 'busy':
      return `${row} had another change in progress.`;
    case 'unresolved':
      return `${row} needs your attention; see its notice.`;
    // Changed by this app after the question: it shows a newer version.
    case 'stale':
      return `${row} changed after the question.`;
    default:
      return ended;
  }
}

/**
 * The compact confirmation: the question with the total once, what the app
 * adds about the scope below it, and the SDK's Cancel and Delete. Escape and a
 * press beside it cancel; Delete closes it and calls `onDelete`.
 */
export function ConfirmRemoval(props: {
  readonly question: string;
  readonly children?: ReactNode;
  readonly onClose: () => void;
  readonly onDelete: () => void;
}) {
  const { messages: m } = useSdkLocale();
  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      showCloseButton={false}
    >
      <DialogHeader>
        <DialogTitle>{props.question}</DialogTitle>
      </DialogHeader>
      {props.children}
      <DialogFooter>
        <DialogClose>{m.controls.cancel}</DialogClose>
        <DialogClose variant="destructive" onPress={props.onDelete}>
          {m.controls.remove}
        </DialogClose>
      </DialogFooter>
    </Dialog>
  );
}
