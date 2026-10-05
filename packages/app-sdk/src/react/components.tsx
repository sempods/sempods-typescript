import { useRef, useState, type ComponentType, type ReactNode } from 'react';
import type {
  ResourceEditor as Editor,
  SaveOutcome,
  RemoveOutcome,
} from '@sempods/client-sdk/edit';
import type { MutationOutcome } from './hooks.js';
import { useApp, useAppState, useWorkflowAccess } from './app.js';
import { useSdkLocale } from './locale.js';
import { describeFailure } from '../locale.js';

export function UpdateNotice({
  outcome,
  onCheck,
  onAcknowledge,
  current,
  labels,
}: {
  /** Successfully read domain data, null for observed absence; undefined until compared. */
  readonly current?: unknown;
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
  const checked = comparison.outcome === outcome && comparison.checked;
  const checking = comparison.outcome === outcome && comparison.checking;
  if (!outcome) return null;
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
    <>
      <p role="status">{text}</p>
      {uncertain && current !== undefined && (
        <section aria-label={m.current}>
          <h3>{m.current}</h3>
          {current === null ? (
            <p>{m.notPresent}</p>
          ) : (
            <Comparison value={current} labels={labels} />
          )}
        </section>
      )}
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
    </>
  );
}
export function AccessNotice() {
  const access = useWorkflowAccess();
  const { preset } = useAppState();
  const { messages: m, format } = useSdkLocale();
  const c = access.connection;
  if (!c) return <p role="status">{m.controls.noTarget}</p>;
  if (c.session.kind !== 'active' && c.session.kind !== 'renewing')
    return <p role="status">{m.controls.readLost}</p>;
  if (c.missingRequiredScopes.length)
    return (
      <p role="status">{m.missingScopes(c.missingRequiredScopes, format)}</p>
    );
  if (c.catalogue.kind === 'failed')
    return <p role="status">{m.catalogueError}</p>;
  if (c.catalogue.kind !== 'ready')
    return <p role="status">{m.cataloguePending}</p>;
  if (!c.selectedContext)
    return (
      <p role="status">
        {preset?.podUrl === c.podUrl && preset.contextIri
          ? m.controls.presetContextUnavailable
          : m.controls.noTarget}
      </p>
    );
  if (!access.read) return <p role="status">{m.controls.readLost}</p>;
  if (!access.write) return <p role="status">{m.controls.readOnly}</p>;
  return null;
}
export interface ConnectionControlsProps {
  readonly mode?: 'single' | 'multiple';
}
/** All selectors and connection actions use the same leave policy as custom composition. */
export function ConnectionControls({
  mode = 'multiple',
}: ConnectionControlsProps) {
  const app = useApp();
  const state = useAppState();
  const { messages: m, error } = useSdkLocale();
  const controls = m.controls;
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  // The cause decides the message: an invalid URL, discovery, a denied login.
  const [failure, setFailure] = useState<{ readonly cause: unknown } | null>(
    null,
  );
  const connection = state.connections.find((c) => c.id === state.activeId);
  const action = async (task: () => Promise<unknown>) => {
    if (inFlight.current || state.changing || state.confirmingLeave) return;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    try {
      await task();
    } catch (cause) {
      setFailure({ cause });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const active =
    connection?.session.kind === 'active' ||
    connection?.session.kind === 'renewing';
  const fixedContext =
    state.preset?.podUrl === connection?.podUrl
      ? state.preset?.contextIri
      : undefined;
  const unavailable =
    busy ||
    !state.startup ||
    state.startup.storage !== 'durable' ||
    Boolean(state.startupError) ||
    state.changing ||
    state.confirmingLeave;
  // Only readable contexts can be selected; none at all is its own message.
  const readable =
    connection?.catalogue.kind === 'ready'
      ? connection.catalogue.contexts.filter((c) => c.readable)
      : [];
  return (
    <section aria-label={controls.choosePod}>
      {state.preset && connection?.podUrl !== state.preset.podUrl && (
        <div>
          <span style={{ overflowWrap: 'anywhere' }}>
            {state.preset.podUrl}
          </span>{' '}
          <button
            disabled={unavailable}
            onClick={() => void action(() => app.connect())}
          >
            {controls.signIn}
          </button>
        </div>
      )}
      {!state.preset &&
        (mode === 'multiple' || state.connections.length === 0) && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action(() => app.connect(url));
            }}
            style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}
          >
            <label>
              {controls.podUrl}
              <input
                type="url"
                required
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://pod.example/alice"
              />
            </label>
            <button disabled={unavailable}>{controls.connect}</button>
          </form>
        )}
      {state.connections.length > 0 && (
        <div
          style={{
            display: 'flex',
            gap: 12,
            flexWrap: 'wrap',
            alignItems: 'end',
          }}
        >
          <label>
            {m.activePod}
            <select
              value={state.activeId ?? ''}
              disabled={busy}
              onChange={(e) =>
                void action(() => app.selectConnection(e.target.value))
              }
            >
              <option value="" disabled>
                {controls.choosePod}
              </option>
              {state.connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.podUrl}
                </option>
              ))}
            </select>
          </label>
          {active && !fixedContext && (
            <label>
              {m.dataContext}
              <select
                value={connection?.selectedContext ?? ''}
                disabled={
                  busy ||
                  connection?.catalogue.kind !== 'ready' ||
                  readable.length === 0
                }
                onChange={(e) =>
                  void action(() => app.selectContext(e.target.value))
                }
              >
                <option value="" disabled>
                  {m.chooseContext}
                </option>
                {readable.map((c) => (
                  <option key={c.iri} value={c.iri}>
                    {c.iri}
                  </option>
                ))}
              </select>
            </label>
          )}
          {active && fixedContext && (
            <p style={{ overflowWrap: 'anywhere' }}>
              {m.dataContext}: {fixedContext}
            </p>
          )}
          {active &&
            !fixedContext &&
            connection?.catalogue.kind === 'ready' &&
            readable.length === 0 && <p role="status">{m.noContexts}</p>}
          {connection && (
            <>
              <button
                disabled={
                  unavailable || connection.session.kind === 'restoring'
                }
                onClick={() => void action(() => app.authorize(connection.id))}
              >
                {active ? controls.updateAccess : controls.signIn}
              </button>
              {active && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void action(() => app.refreshContexts(connection.id))
                  }
                >
                  {controls.refresh}
                </button>
              )}
              <button
                disabled={busy}
                onClick={() => void action(() => app.disconnect(connection.id))}
              >
                {controls.disconnect}
              </button>
            </>
          )}
        </div>
      )}
      {failure && <p role="alert">{error(failure.cause)}</p>}
    </section>
  );
}
/**
 * The outcome of a returning sign-in that failed or was cancelled, with its
 * protocol cause when the runtime kept one. AppShell renders it; custom
 * layouts place it themselves. Renders nothing otherwise.
 */
export function CallbackNotice() {
  const state = useAppState();
  const { messages } = useSdkLocale();
  const interaction = state.startup?.interaction;
  if (interaction !== 'failed' && interaction !== 'cancelled') return null;
  return (
    <p role="alert">
      {state.startup?.failure
        ? describeFailure(messages.errors, state.startup.failure)
        : messages.controls.failure}
    </p>
  );
}
export function AppShell({
  children,
  title = 'sempods',
  mode = 'multiple',
  components = {},
  style,
}: {
  readonly children: ReactNode;
  readonly title?: string;
  readonly mode?: 'single' | 'multiple';
  readonly components?: {
    readonly Connections?: ComponentType<ConnectionControlsProps>;
  };
  readonly style?: React.CSSProperties;
}) {
  const state = useAppState();
  const { messages, direction, error } = useSdkLocale();
  const Connections = components.Connections ?? ConnectionControls;
  return (
    <main
      dir={direction}
      style={{
        maxWidth: 900,
        margin: 'auto',
        padding: 'clamp(12px,4vw,32px)',
        fontFamily: 'system-ui,sans-serif',
        lineHeight: 1.5,
        color: '#173740',
        ...style,
      }}
    >
      <header>
        <h1>{title}</h1>
      </header>
      {!state.startup && !state.startupError ? (
        <p role="status">{messages.controls.loading}</p>
      ) : state.startup?.storage === 'busy' ? (
        <p role="alert">{messages.controls.busy}</p>
      ) : state.startup?.storage === 'unavailable' ? (
        <p role="alert">{messages.controls.storage}</p>
      ) : state.startupError ? (
        <p role="alert">{error(state.startupError)}</p>
      ) : (
        <>
          <CallbackNotice />
          <Connections mode={mode} />
          <AccessNotice />
          {children}
        </>
      )}
    </main>
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
/** Default save/delete/review UI; children supply only domain fields. */
export function ResourceEditor<D, U = D>({
  editor,
  children,
  onChanged,
  labels,
}: {
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
  } | null>(null);
  if (!editor || editor.state.phase === 'loading')
    return <p role="status">{m.loading}</p>;
  const state = editor.state;
  const act = async (action: () => Promise<SaveOutcome | RemoveOutcome>) => {
    const result = await action();
    // Review owns its own feedback. Success must not describe edits made
    // while saving; any later editor state also retires this feedback.
    setFeedback(
      result.kind === 'review' ||
        (result.kind === 'saved' && editor.state.dirty)
        ? null
        : { editor, state: editor.state, outcome: result },
    );
    if (result.kind === 'saved' || result.kind === 'removed') onChanged?.();
  };
  return (
    <section>
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
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          disabled={!state.canSave}
          onClick={() => void act(() => editor.save())}
        >
          {m.save}
        </button>
        <button
          disabled={!state.canRemove}
          onClick={() => void act(() => editor.remove())}
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
      {!state.review && (
        <UpdateNotice
          outcome={
            feedback?.editor === editor && feedback.state === state
              ? feedback.outcome
              : null
          }
        />
      )}
    </section>
  );
}
