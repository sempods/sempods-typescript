import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
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
import { SdkStyles } from './styles.js';
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
  if (c.catalogue.kind !== 'ready')
    return <Notice>{m.cataloguePending}</Notice>;
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
 * Delete asks in place first: only the confirmation sends one conditional
 * DELETE of the version shown. Any later editor state (an edit, a read, another
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
}: {
  /** As for `UpdateNotice`: no message for a confirmed save or delete. */
  readonly quiet?: boolean;
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
  const question = useId();
  const removeButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const view = editor ? editorTarget(editor) : undefined;
  const starts = useStartCount(view);
  const asking =
    confirming !== null && confirming === editor?.state && confirming.canRemove;
  useEffect(() => {
    if (asking) cancelButton.current?.focus();
    else if (returnFocus.current) {
      returnFocus.current = false;
      removeButton.current?.focus();
    }
  }, [asking]);
  if (!editor || editor.state.phase === 'loading')
    return <Notice>{m.loading}</Notice>;
  const state = editor.state;
  const keep = () => {
    returnFocus.current = true;
    setConfirming(null);
  };
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
  };
  return (
    <section data-sempods-ui="editor">
      <SdkStyles />
      {state.draft !== null && state.phase !== 'deleted' && (
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
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
      {asking ? (
        <div
          role="group"
          aria-labelledby={question}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            keep();
          }}
        >
          <p id={question}>{m.confirmRemove ?? m.remove}</p>
          <div className="sp-sdk-actions">
            <button
              onClick={() => {
                // Withdrawn first: a second press cannot send another DELETE.
                setConfirming(null);
                if (editor.state === confirming)
                  void act(() => editor.remove());
              }}
            >
              {m.remove}
            </button>
            <button ref={cancelButton} onClick={keep}>
              {m.cancel}
            </button>
          </div>
        </div>
      ) : (
        <div className="sp-sdk-actions">
          <button
            disabled={!state.canSave}
            onClick={() => void act(() => editor.save())}
          >
            {m.save}
          </button>
          <button
            ref={removeButton}
            disabled={!state.canRemove}
            onClick={() => setConfirming(state)}
          >
            {m.remove}
          </button>
          <button disabled={!state.canDiscard} onClick={() => editor.discard()}>
            {m.discard}
          </button>
          {state.phase === 'blocked' && (
            <button onClick={() => void editor.refresh()}>{m.refresh}</button>
          )}
        </div>
      )}
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
