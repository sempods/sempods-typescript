import { useRef, useState, type ReactNode } from 'react';
import type {
  ResourceEditor as Editor,
  SaveOutcome,
  RemoveOutcome,
} from '@sempods/client-sdk/edit';
import { useStartCount, type MutationOutcome } from './hooks.js';
import { useAppState, useWorkflowAccess } from './app.js';
import { useSdkLocale } from './locale.js';
import { describeFailure, type SdkMessages } from '../locale.js';
import type { SessionFact } from '../runtime/types.js';
import { shownData, type LoadState } from '../authoring/load.js';
import { knownContexts } from './access-presentation.js';
import { SdkStyles } from './styles.js';
import { ConfirmDialog } from './confirm.js';
import { startCount, succeeded } from '../authoring/changes.js';
import { editorTarget } from '../authoring/editor.js';

function Notice({
  children,
  role = 'status',
}: {
  readonly children: ReactNode;
  readonly role?: 'status' | 'alert';
}) {
  return (
    <>
      <SdkStyles />
      <p data-sempods-ui="notice" role={role}>
        {children}
      </p>
    </>
  );
}

export function UpdateNotice({
  outcome,
  onCheck,
  onAcknowledge,
  current,
  unreadable,
  checked: suppliedChecked,
  labels,
  quiet = false,
}: {
  /**
   * Shows nothing for a confirmed success (`saved`, `created`, `removed`),
   * for example when the changed row is the confirmation. Refusals,
   * conflicts, a save beside another change and unconfirmed outcomes still
   * show with their controls.
   */
  readonly quiet?: boolean;
  /** Successfully read domain data, null for observed absence; undefined until compared. */
  readonly current?: unknown;
  /** Compared: the resource is present, but the definition cannot read it. */
  readonly unreadable?: boolean;
  /**
   * Authoritative acknowledgement eligibility, supplied by mutation/creation
   * notices. When omitted, a successful local onCheck enables acknowledgement.
   */
  readonly checked?: boolean;
  /** Field display names for the comparison. */
  readonly labels?: FieldLabels;
  readonly onCheck?: () => Promise<boolean>;
  readonly onAcknowledge?: () => void;
  readonly outcome:
    MutationOutcome<unknown> | SaveOutcome | RemoveOutcome | null | undefined;
}) {
  const m = useSdkLocale().messages.controls;
  const [comparison, setComparison] = useState({
    outcome,
    checked: false,
    checking: false,
  });
  if (comparison.outcome !== outcome)
    setComparison({ outcome, checked: false, checking: false });
  const checked =
    suppliedChecked ?? (comparison.outcome === outcome && comparison.checked);
  const checking = comparison.outcome === outcome && comparison.checking;
  if (!outcome) return null;
  if (
    quiet &&
    (outcome.kind === 'created' ||
      outcome.kind === 'removed' ||
      (outcome.kind === 'saved' &&
        !('alongside' in outcome && outcome.alongside)))
  )
    return null;
  const text =
    outcome.kind === 'saved'
      ? 'alongside' in outcome && outcome.alongside
        ? m.alongside
        : m.saved
      : outcome.kind === 'created'
        ? m.created
        : outcome.kind === 'removed'
          ? m.removed
          : outcome.kind === 'exists'
            ? m.exists
            : outcome.kind === 'unconfirmed'
              ? m.unconfirmed
              : outcome.kind === 'changed-on-pod' || outcome.kind === 'review'
                ? m.changed
                : m.notSaved;
  const uncertain =
    outcome.kind === 'unconfirmed' || outcome.kind === 'changed-on-pod';
  return (
    <section data-sempods-ui="notice">
      <SdkStyles />
      <p role="status">{text}</p>
      {uncertain && (current !== undefined || unreadable) && (
        <section aria-label={m.current}>
          <h3>{m.current}</h3>
          {unreadable ? (
            <p>{m.unreadable}</p>
          ) : current === null ? (
            <p>{m.notPresent}</p>
          ) : (
            <Comparison value={current} labels={labels} />
          )}
        </section>
      )}
      <div className="sp-sdk-actions">
        {uncertain && onCheck && (
          <button
            disabled={checking}
            onClick={async () => {
              const pending = { outcome, checked: false, checking: true };
              setComparison(pending);
              let checked = false;
              try {
                checked = await onCheck();
              } catch {
                // A failed comparison never authorizes acknowledgement.
              }
              // Only this check may settle its state; replaced outcomes/checks
              // keep their own progress and acknowledgement requirement.
              setComparison((current) =>
                current === pending
                  ? { ...pending, checked, checking: false }
                  : current,
              );
            }}
          >
            {m.compare}
          </button>
        )}
        {uncertain && onAcknowledge && (
          <button disabled={!checked || checking} onClick={onAcknowledge}>
            {m.acknowledge}
          </button>
        )}
      </div>
    </section>
  );
}
/**
 * What a read is doing when its data does not say it: loading before any
 * data, a failed refresh (its error, a note when kept data is still shown,
 * and a retry), a cancelled or unavailable read (with a retry) and list
 * entries that cannot be shown. Renders nothing for ready data otherwise.
 * Takes the result of `useList`, `useLoad` or `usePodLoad`:
 * `<LoadNotice {...list} />`.
 */
export function LoadNotice({
  state,
  reload,
}: {
  readonly state: LoadState<unknown>;
  readonly reload?: () => unknown;
}) {
  const { messages: m, error, format } = useSdkLocale();
  const c = m.controls;
  const shown = shownData(state);
  const skipped =
    shown !== null &&
    typeof shown === 'object' &&
    'skipped' in shown &&
    typeof shown.skipped === 'number'
      ? shown.skipped
      : 0;
  if (state.kind === 'loading')
    return shown === undefined ? <Notice>{c.loading}</Notice> : null;
  if (state.kind === 'ready')
    return skipped > 0 ? <Notice>{m.skipped!(skipped, format)}</Notice> : null;
  const text =
    state.kind === 'failed'
      ? `${error(state.error)}${shown === undefined ? '' : ` ${c.stale}`}`
      : state.kind === 'cancelled'
        ? c.loadCancelled
        : c.loadUnavailable;
  return (
    <section data-sempods-ui="notice">
      <SdkStyles />
      <p role={state.kind === 'failed' ? 'alert' : 'status'}>{text}</p>
      {reload && (
        <div className="sp-sdk-actions">
          <button onClick={() => void reload()}>{c.retry}</button>
        </div>
      )}
    </section>
  );
}
/**
 * Why an ended session is unusable. An interrupted sign-in is found at startup,
 * before any draft. Next to a sign-in action, which navigates away, an expired
 * session keeps none either, and the protocol cause is shown when kept.
 */
export function endedMessage(
  session: Extract<SessionFact, { readonly kind: 'ended' }>,
  m: SdkMessages,
  signingIn = false,
) {
  if (session.restorable) return m.controls.unreachable ?? m.controls.readLost;
  if (signingIn && session.failure)
    return describeFailure(m.errors, session.failure);
  return session.problem === 'interrupted' ||
    (signingIn && session.problem === 'expired')
    ? m.controls.signInRequired
    : m.controls.readLost;
}
/**
 * Explains current access limitations. Failed sign-out retry advice belongs
 * beside the action in AppAccess or custom controls. While the page
 * leaves for a sign-in (`leaving`) nothing was lost, so it shows nothing.
 */
export function AccessNotice() {
  const access = useWorkflowAccess();
  const { preset } = useAppState();
  const { messages: m, format } = useSdkLocale();
  const c = access.connection;
  if (!c) return <Notice>{m.controls.noTarget}</Notice>;
  if (c.session.kind === 'leaving') return null;
  if (c.session.kind !== 'active' && c.session.kind !== 'renewing')
    return (
      <Notice>
        {c.session.kind === 'ended'
          ? endedMessage(c.session, m)
          : m.controls.readLost}
      </Notice>
    );
  if (c.missingRequiredScopes.length)
    return <Notice>{m.missingScopes(c.missingRequiredScopes, format)}</Notice>;
  if (c.catalogue.kind === 'failed') return <Notice>{m.catalogueError}</Notice>;
  // A reload that still has the earlier Contexts is not unknown access.
  if (!knownContexts(c.catalogue)) return <Notice>{m.cataloguePending}</Notice>;
  if (!c.selectedContext)
    return (
      <Notice>
        {preset?.podUrl === c.podUrl && preset.contextIri
          ? m.controls.presetContextUnavailable
          : m.controls.noTarget}
      </Notice>
    );
  if (!access.read) return <Notice>{m.controls.readLost}</Notice>;
  if (!access.write) return <Notice>{m.controls.readOnly}</Notice>;
  return null;
}
/**
 * The outcome of a returning sign-in that failed or was cancelled, with its
 * protocol cause when the runtime kept one. AppAccess renders it; custom
 * layouts place it themselves. It clears once the person selects another
 * connection, disconnects one or starts a sign-in (`callbackNotice`).
 * Renders nothing otherwise.
 */
export function CallbackNotice() {
  const state = useAppState();
  const { messages } = useSdkLocale();
  const interaction = state.startup?.interaction;
  if (!state.callbackNotice) return null;
  // A declined re-authorization changed nothing: a status, not an error.
  if (interaction === 'cancelled' && state.startup?.resumed)
    return (
      <Notice>
        {messages.controls.sharingUnchanged ??
          messages.controls.signInCancelled}
      </Notice>
    );
  return (
    <Notice role="alert">
      {interaction === 'cancelled'
        ? messages.controls.signInCancelled
        : state.startup?.failure
          ? describeFailure(messages.errors, state.startup.failure)
          : messages.controls.failure}
    </Notice>
  );
}
/**
 * A comparison must never make two different values look equal: show every
 * digit of the shortest exact form (as `String` does), with the locale's
 * separators. Exponent forms and non-finite values stay as `String` shows them.
 */
function exactNumber(value: number, locale: string): string {
  const plain = String(value);
  if (!Number.isFinite(value) || /e/i.test(plain)) return plain;
  const digits = plain.split('.')[1]?.length ?? 0;
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}
/** Display names for draft fields; a missing name shows the field key. */
export type FieldLabels = { readonly [field: string]: string | undefined };
function Comparison({
  value,
  labels,
}: {
  readonly value: unknown;
  readonly labels?: FieldLabels | undefined;
}) {
  const { messages, locale } = useSdkLocale();
  const m = messages.controls;
  if (value === undefined) return <span>—</span>;
  if (value === null) return <p>{m.notPresent}</p>;
  const shown = (v: unknown) =>
    typeof v === 'boolean'
      ? v
        ? m.yes
        : m.no
      : typeof v === 'number'
        ? exactNumber(v, locale)
        : v === null || v === undefined || v === ''
          ? '—'
          : String(v);
  return (
    <dl>
      {Object.entries(value as Record<string, unknown>).map(([key, v]) => (
        <div key={key}>
          <dt>{labels?.[key] ?? key}</dt>
          <dd>{shown(v)}</dd>
        </div>
      ))}
    </dl>
  );
}
/** Default save/delete/review UI; children supply only domain fields.
 * Delete asks first in a modal dialog, like the leave confirmation: only its
 * Delete sends one conditional DELETE of the version shown. Any later editor state (an edit, a read, another
 * subject) withdraws the question; cancel or Escape keeps draft and target.
 * Success feedback retires with any later editor state and, for an editor from
 * `useResourceEditor`, when another write on the same target starts.
 * Inline scoped --sempods-* styles cover controls and comparisons without changing
 * draft/review lifetime. Host app content outside this editor is not styled.
 */
export function ResourceEditor<D, U = D>({
  editor,
  children,
  onChanged,
  labels,
  quiet = false,
  onClose,
}: {
  /** As for `UpdateNotice`: no message for a confirmed save or delete. */
  readonly quiet?: boolean;
  /**
   * An editor that opens in place, for example in a list row: Cancel (or
   * Escape) discards and closes, and a confirmed save or delete closes it, as
   * the changed row is the confirmation. Refusals, conflicts and unconfirmed
   * answers keep it open. Pass the guarded selection reset,
   * `() => select(null)`.
   */
  readonly onClose?: () => unknown;
  readonly editor: Editor<D, U> | null;
  readonly children: (draft: D, change: (draft: U) => void) => ReactNode;
  readonly onChanged?: () => void;
  /** Field display names for the review comparison. */
  readonly labels?: { readonly [K in keyof D]?: string };
}) {
  const m = useSdkLocale().messages.controls;
  const [feedback, setFeedback] = useState<{
    editor: Editor<D, U>;
    state: Editor<D>['state'];
    outcome: SaveOutcome | RemoveOutcome;
    /** The target's start count at this operation's own start. */
    start: number;
  } | null>(null);
  // The editor state the person was asked about; any newer state withdraws it.
  const [confirming, setConfirming] = useState<Editor<D>['state'] | null>(null);
  const removeButton = useRef<HTMLButtonElement>(null);
  const view = editor ? editorTarget(editor) : undefined;
  const starts = useStartCount(view);
  const asking =
    confirming !== null && confirming === editor?.state && confirming.canRemove;
  if (!editor || editor.state.phase === 'loading')
    return <Notice>{m.loading}</Notice>;
  const state = editor.state;
  const act = async (action: () => Promise<SaveOutcome | RemoveOutcome>) => {
    // A bound editor counts its own start synchronously in `action()`.
    const pending = action();
    const start = view ? startCount(view) : 0;
    const result = await pending;
    // Review owns its own feedback. Success must not describe edits made
    // while saving; any later editor state also retires this feedback.
    setFeedback(
      result.kind === 'review' ||
        (result.kind === 'saved' && editor.state.dirty)
        ? null
        : { editor, state: editor.state, outcome: result, start },
    );
    if (succeeded(result)) onChanged?.();
    // Edits made while saving stay open (closing would ask about them).
    if (
      result.kind === 'removed' ||
      (result.kind === 'saved' && !editor.state.dirty)
    )
      onClose?.();
  };
  const save = () => {
    if (editor.state.canSave) void act(() => editor.save());
  };
  // An explicit Cancel is the decision to discard; switching rows still asks.
  const cancel = () => {
    if (editor.state.canDiscard) editor.discard();
    void onClose?.();
  };
  return (
    <section
      data-sempods-ui="editor"
      // In place (a list row): a quiet card, see SdkStyles.
      data-inline={onClose ? '' : undefined}
    >
      <SdkStyles />
      {state.draft !== null && state.phase !== 'deleted' && (
        <fieldset
          style={{ border: 0, padding: 0, margin: 0 }}
          onKeyDown={(event) => {
            // Enter in a text field saves; Escape cancels an editor in place.
            // Both belong to an active IME composition first.
            if (event.nativeEvent.isComposing) return;
            const field = event.target as HTMLElement;
            if (
              event.key === 'Enter' &&
              field instanceof HTMLInputElement &&
              !['checkbox', 'radio', 'button', 'submit'].includes(field.type)
            ) {
              event.preventDefault();
              save();
            } else if (event.key === 'Escape' && onClose) {
              event.preventDefault();
              cancel();
            }
          }}
        >
          {children(state.draft, editor.change)}
        </fieldset>
      )}
      {state.problem && (
        <p role="status">
          {state.problem.kind === 'refused' ||
          state.problem.kind === 'unavailable'
            ? m.readLost
            : m.failure}
        </p>
      )}
      {state.review && (
        <section aria-label={m.changed}>
          <p role="alert">
            {state.review.kind === 'unconfirmed' ? m.unconfirmed : m.changed}
          </p>
          <h3>{m.mine}</h3>
          <Comparison value={state.draft} labels={labels} />
          <h3>{m.current}</h3>
          <Comparison value={state.review.current} labels={labels} />
          <button
            disabled={state.phase === 'saving'}
            onClick={() => void editor.refresh()}
          >
            {m.compare}
          </button>{' '}
          <button
            disabled={
              state.phase === 'saving' || state.review.current === undefined
            }
            onClick={() => editor.continueFromCurrent()}
          >
            {state.review.current === null ? m.acknowledge : m.continueMine}
          </button>
        </section>
      )}
      <div className="sp-sdk-actions">
        <button
          className="sp-sdk-primary"
          disabled={!state.canSave}
          onClick={save}
        >
          {m.save}
        </button>
        {onClose ? (
          <button onClick={cancel}>{m.cancel}</button>
        ) : (
          <button disabled={!state.canDiscard} onClick={() => editor.discard()}>
            {m.discard}
          </button>
        )}
        {state.phase === 'blocked' && (
          <button onClick={() => void editor.refresh()}>{m.refresh}</button>
        )}
        <button
          ref={removeButton}
          className="sp-sdk-end"
          disabled={!state.canRemove}
          onClick={() => setConfirming(state)}
        >
          {m.remove}
        </button>
      </div>
      {/* Only the dialog's Delete sends one conditional DELETE. */}
      <ConfirmDialog
        open={asking}
        ui="remove"
        returnFocus={removeButton}
        cancel={m.cancel}
        confirm={m.remove}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          // Withdrawn first: a second press cannot send another DELETE.
          setConfirming(null);
          if (editor.state === confirming) void act(() => editor.remove());
        }}
      >
        <p>{m.confirmRemove ?? m.remove}</p>
      </ConfirmDialog>
      {!state.review && (
        <UpdateNotice
          quiet={quiet}
          outcome={
            feedback?.editor === editor &&
            feedback.state === state &&
            // Another write started on the target since this one retires it.
            !(succeeded(feedback.outcome) && feedback.start !== starts)
              ? feedback.outcome
              : null
          }
        />
      )}
    </section>
  );
}

/**
 * A delete button that asks first, with the dialog and texts of
 * `ResourceEditor`'s Delete: only the dialog's Delete calls `onRemove`, once,
 * as it was when the question opened. A row read again meanwhile does not
 * change what is removed, so a conditional delete of the version shown reports
 * a newer one as a conflict.
 * Pass the hook's check and command, for example
 * `disabled={!row.canMutate}` and `onRemove={row.remove}` for `row = mutate.for(item)`;
 * the outcome shows where the hook's notice is. A button that becomes disabled
 * while asking withdraws the question. Without children it is a quiet trash
 * icon with a 44px target, named Delete or `label`; `className` overrides its
 * look.
 */
export function RemoveButton({
  onRemove,
  disabled = false,
  label,
  className,
  children,
}: {
  readonly onRemove: () => unknown;
  readonly disabled?: boolean;
  /** Accessible name and tooltip, for example `Delete: ${title}`; the icon defaults to Delete. */
  readonly label?: string;
  readonly className?: string;
  /** The button's content instead of the trash icon, for example a text. */
  readonly children?: ReactNode;
}) {
  const m = useSdkLocale().messages.controls;
  // The action asked about, captured when the question opens.
  const [asking, setAsking] = useState<{
    readonly remove: () => unknown;
  } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  // Withdrawn for good: enabled again later, it does not reopen.
  if (asking && disabled) setAsking(null);
  // The icon shows for absent content (`undefined` or `null`), and then needs a name.
  const content = children ?? null;
  const name = label ?? (content === null ? m.remove : undefined);
  return (
    <>
      <SdkStyles />
      <button
        ref={button}
        type="button"
        data-sempods-ui="remove-button"
        className={className}
        aria-label={name}
        title={name}
        disabled={disabled}
        onClick={() => setAsking({ remove: onRemove })}
      >
        {content ?? trash}
      </button>
      <ConfirmDialog
        open={asking !== null}
        ui="remove"
        returnFocus={button}
        cancel={m.cancel}
        confirm={m.remove}
        onCancel={() => setAsking(null)}
        onConfirm={() => {
          // Withdrawn first: a second press cannot remove again.
          setAsking(null);
          if (asking) void asking.remove();
        }}
      >
        <p>{m.confirmRemove ?? m.remove}</p>
      </ConfirmDialog>
    </>
  );
}

const trash = (
  <svg
    viewBox="0 0 24 24"
    aria-hidden="true"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4h6v3" />
  </svg>
);
