import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  useApp,
  useAppState,
  useContextDemand,
  useWorkflowAccess,
} from './app.js';
import { useSdkLocale } from './locale.js';
import {
  AccessNotice,
  CallbackNotice,
  endedMessage,
  type ConnectionControlsProps,
} from './components.js';
import { SdkStyles } from './styles.js';
import { contextName, podName, distinctName } from './names.js';

export interface AppAccessProps {
  readonly appName: string;
  /** Heading under a host title; omitted means h1 initially, h2 for management/recovery. */
  readonly headingLevel?: 1 | 2;
  /** Presentation only: single hides adding Pods once connected; allowedPods enforces policy. */
  readonly mode?: 'single' | 'multiple';
  /** App-owned decorative icon, for example <img src="/icon.png" alt="" />. */
  readonly icon?: ReactNode;
  /** Exact Pod URL → friendly name. A name never changes the destination. */
  readonly podNames?: Readonly<Record<string, string>>;
  /** Host-owned management toggle; demands Context discovery in on-demand mode, never login. */
  readonly open?: boolean;
  /** Focus here if a focused access control disappears after successful recovery. */
  readonly focusTarget?: RefObject<HTMLElement | null>;
  readonly components?: {
    readonly Connections?: ComponentType<ConnectionControlsProps>;
  };
  readonly className?: string;
  readonly style?: CSSProperties;
}
const unavailablePod = Object.freeze({
  current: false,
  read: false,
  revision: 0,
});
const noSubscription = () => () => {};

/**
 * Centered login/recovery UI beside, never around, app content. Uses the host's
 * existing runtime facts/actions; hides when a target is readable unless open.
 * With `contextSelection: 'on-demand'` it hides while the Pod reader is usable and
 * offers Context selection only once a Context flow (`TargetScreen`, `open`) asks.
 * While the active connection restores, or its Pod reader is not yet readable,
 * it shows the loading status (plus the active-Pod selector for several saved
 * connections and the sign-in for another configured Pod) until something
 * needs a decision.
 * Read-only targets remain usable. Callback failures remain visible separately
 * until the person selects another connection, disconnects one or signs in again.
 * Keep this outside hidden/inert widget regions and keep TargetScreen/editor
 * children mounted during same-target access loss; this is not a content gate.
 * Inline, scoped defaults use shared --sempods-* CSS variables; no stylesheet
 * import or UI framework is required. A CSP must permit this component's styles.
 */
export function AppAccess({
  appName,
  headingLevel,
  mode = 'multiple',
  icon,
  podNames,
  open = false,
  focusTarget,
  components,
  className,
  style,
}: AppAccessProps) {
  const state = useAppState();
  const access = useWorkflowAccess();
  const contextRequired = useContextDemand(open);
  const podAccess = useSyncExternalStore(
    state.pod?.subscribe ?? noSubscription,
    state.pod?.getSnapshot ?? (() => unavailablePod),
    state.pod?.getSnapshot ?? (() => unavailablePod),
  );
  const readable =
    state.contextSelection === 'on-demand' ? podAccess.read : access.read;
  const { messages: m, direction, error } = useSdkLocale();
  const heldFocus = useRef(false);
  const needsAttention =
    !readable ||
    (contextRequired &&
      (!access.read || access.connection?.catalogue.kind === 'failed'));
  const hidden = !needsAttention && !open && !state.callbackNotice;
  // The active connection is still being validated (restoring, or signed in
  // while its Pod reader is not yet readable) and nothing awaits a decision:
  // show the loading status, not the connection view, until it settles.
  const c = access.connection;
  const validating =
    !open &&
    !state.callbackNotice &&
    Boolean(c) &&
    c?.catalogue.kind !== 'failed' &&
    !(contextRequired && c?.catalogue.kind === 'ready') &&
    (c?.session.kind === 'restoring' ||
      ((c?.session.kind === 'active' || c?.session.kind === 'renewing') &&
        c.missingRequiredScopes.length === 0 &&
        !podAccess.read));
  useLayoutEffect(() => {
    // Guarded target changes temporarily make the whole provider inert. Restore
    // focus only after that transition, when the host control can receive it.
    if (
      !needsAttention &&
      !open &&
      !state.changing &&
      !state.confirmingLeave &&
      heldFocus.current
    ) {
      heldFocus.current = false;
      focusTarget?.current?.focus();
    }
  }, [
    needsAttention,
    open,
    focusTarget,
    state.changing,
    state.confirmingLeave,
  ]);
  const Heading =
    (headingLevel ?? (open || state.view ? 2 : 1)) === 2 ? 'h2' : 'h1';
  const Connections = components?.Connections;
  const available = state.startup?.storage === 'durable' && !state.startupError;
  const active =
    access.connection?.session.kind === 'active' ||
    access.connection?.session.kind === 'renewing';
  const missingScopes = Boolean(
    access.connection?.missingRequiredScopes.length,
  );
  const showNotice =
    active &&
    available &&
    (missingScopes ||
      (contextRequired &&
        Boolean(
          access.connection?.selectedContext ||
          access.connection?.catalogue.kind !== 'ready' ||
          state.preset?.contextIri,
        )));
  return (
    <section
      onFocusCapture={() => {
        heldFocus.current = true;
      }}
      onBlurCapture={(event) => {
        if (
          event.relatedTarget &&
          event.relatedTarget !== event.currentTarget.ownerDocument.body &&
          !event.currentTarget.contains(event.relatedTarget)
        )
          heldFocus.current = false;
      }}
      hidden={hidden}
      data-sempods-access=""
      data-sempods-ui="access"
      data-initial={!state.view && !open ? '' : undefined}
      aria-label={m.controls.dataAccess}
      dir={direction}
      className={className}
      style={hidden ? { ...style, display: 'none' } : style}
    >
      <SdkStyles />
      <style href="sempods-access" precedence="sempods">
        {styles}
      </style>
      <div className="sp-access-content">
        {(needsAttention || open) && (
          <header>
            {icon && (
              <div className="sp-access-icon" aria-hidden="true">
                {icon}
              </div>
            )}
            <Heading>
              {open || state.view || headingLevel === 2
                ? m.controls.dataAccess
                : appName}
            </Heading>
          </header>
        )}
        {state.startupError ? (
          <p role="alert">{error(state.startupError)}</p>
        ) : !state.startup ? (
          <p role="status">{m.controls.loading}</p>
        ) : state.startup.storage === 'busy' ? (
          <p role="alert">{m.controls.busy}</p>
        ) : state.startup.storage === 'unavailable' ? (
          <p role="alert">{m.controls.storage}</p>
        ) : (
          <>
            <CallbackNotice />
            {(needsAttention || open) && (
              <>
                {Connections ? (
                  validating ? (
                    <p role="status">{m.controls.loading}</p>
                  ) : (
                    <Connections
                      mode={mode}
                      {...(podNames ? { podNames } : {})}
                    />
                  )
                ) : (
                  <AccessConnections
                    contextRequired={contextRequired}
                    manage={open}
                    mode={mode}
                    validating={validating}
                    {...(podNames ? { podNames } : {})}
                  />
                )}
                {showNotice && !validating && <AccessNotice />}
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/** Presentation-only convenience. Canonical URL/security validation stays in the runtime. */
function enteredPod(value: string) {
  // Only clean up the common pasted-address form. Do not parse/re-serialize the
  // URL: that could silently normalize ambiguous paths, credentials or escapes.
  const text = value.trim().replace(/\/$/, '');
  return /^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`;
}

function AccessConnections({
  manage,
  mode,
  podNames,
  contextRequired,
  validating,
}: {
  readonly manage: boolean;
  readonly mode: 'single' | 'multiple';
  readonly podNames?: Readonly<Record<string, string>>;
  readonly contextRequired: boolean;
  /** Only the loading status (and a switch to another saved Pod) applies. */
  readonly validating: boolean;
}) {
  const app = useApp();
  const state = useAppState();
  const { messages: m, error } = useSdkLocale();
  const id = useId();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [failure, setFailure] = useState<{ cause: unknown } | null>(null);
  const c = state.connections.find((entry) => entry.id === state.activeId);
  const active = c?.session.kind === 'active' || c?.session.kind === 'renewing';
  const defaultUrl =
    state.preset?.podUrl ??
    (state.allowedPods?.length === 1 ? state.allowedPods[0] : undefined);
  const fixedContext =
    state.preset?.podUrl === c?.podUrl ? state.preset?.contextIri : undefined;
  const readable =
    c?.catalogue.kind === 'ready'
      ? c.catalogue.contexts.filter((entry) => entry.readable)
      : [];
  const unavailable =
    busy ||
    state.changing ||
    state.confirmingLeave ||
    !state.startup ||
    state.startup.storage !== 'durable' ||
    Boolean(state.startupError);
  async function act(task: () => Promise<unknown>) {
    if (inFlight.current || unavailable) return;
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
  }
  async function connect(target: string) {
    // Reuse a permitted stored or prepared connection, including after a failed
    // authorization preparation. The controller still guards selection/login.
    const existing =
      state.connections.find(
        (entry) => entry.id === state.activeId && entry.podUrl === target,
      ) ?? state.connections.find((entry) => entry.podUrl === target);
    if (existing) {
      if (existing.session.kind === 'restoring') return;
      // Keep the current target/drafts until preparation succeeds. The completed
      // callback activates this connection; selecting first would discard drafts
      // even if discovery or durable authorization preparation subsequently fails.
      await app.authorize(existing.id);
    } else await app.connect(target);
  }
  const showNew = (manage && mode === 'multiple') || !c;
  const showDefault =
    (mode === 'multiple' || !c) &&
    defaultUrl &&
    c?.podUrl !== defaultUrl &&
    !(manage && !state.allowedPods);
  const choice = url || defaultUrl || '';
  // The callback notice already names why this connection's sign-in ended.
  const shownByNotice =
    state.callbackNotice &&
    state.startup?.attemptConnectionId === c?.id &&
    c?.session.kind === 'ended' &&
    c.session.problem === state.startup?.problem;
  const name = (target: string) =>
    distinctName(
      target,
      state.allowedPods ?? state.connections.map((entry) => entry.podUrl),
      (value) => podName(value, podNames),
    );
  const labels =
    c?.catalogue.kind !== 'unknown' ? c?.catalogue.labels : undefined;
  const contextLabel = (iri: string) =>
    distinctName(
      iri,
      readable.map((entry) => entry.iri),
      (value) => contextName(value, labels),
    );
  // Keyed so that switching between the validating and connection views keeps
  // these controls (and keyboard focus) mounted.
  const defaultSignIn = showDefault && defaultUrl && (
    <div key="default-sign-in">
      <p>{name(defaultUrl)}</p>
      {podNames?.[defaultUrl] && (
        <p className="sp-access-address">{defaultUrl}</p>
      )}
      <button
        className={c ? undefined : 'sp-access-primary'}
        disabled={
          unavailable ||
          state.connections.some(
            (entry) =>
              entry.podUrl === defaultUrl && entry.session.kind === 'restoring',
          )
        }
        onClick={() => void act(() => connect(defaultUrl))}
      >
        {m.controls.signIn}
      </button>
    </div>
  );
  const activePod = state.connections.length > 1 && (
    <label key="active-pod">
      {m.activePod}
      <select
        aria-label={m.activePod}
        value={state.activeId ?? ''}
        disabled={unavailable}
        onChange={(event) =>
          void act(() => app.selectConnection(event.target.value))
        }
      >
        <option value="" disabled>
          {m.controls.choosePod}
        </option>
        {state.connections.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {name(entry.podUrl)}
            {state.connections.filter((other) => other.podUrl === entry.podUrl)
              .length > 1
              ? ` · ${state.connections.indexOf(entry) + 1}`
              : ''}
          </option>
        ))}
      </select>
    </label>
  );
  // A restore that never settles must not hide signing in to the configured
  // Pod or switching to another saved one.
  if (validating)
    return (
      <>
        {defaultSignIn}
        {activePod}
        <p role="status">{m.controls.loading}</p>
        {failure && <p role="alert">{error(failure.cause)}</p>}
      </>
    );
  return (
    <>
      {showNew && state.allowedPods && state.allowedPods.length > 1 ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (choice) void act(() => connect(choice));
          }}
        >
          <label>
            {m.controls.yourPod}
            <select
              aria-label={m.controls.yourPod}
              required
              value={choice}
              disabled={unavailable}
              onChange={(event) => setUrl(event.target.value)}
            >
              <option value="" disabled>
                {m.controls.choosePod}
              </option>
              {state.allowedPods.map((target) => (
                <option key={target} value={target}>
                  {name(target)}
                </option>
              ))}
            </select>
          </label>
          {choice && <p className="sp-access-address">{choice}</p>}
          <button
            className={c ? undefined : 'sp-access-primary'}
            disabled={
              unavailable ||
              !choice ||
              state.connections.some(
                (entry) =>
                  entry.podUrl === choice && entry.session.kind === 'restoring',
              )
            }
          >
            {m.controls.signIn}
          </button>
        </form>
      ) : defaultSignIn ? (
        defaultSignIn
      ) : showNew && !state.allowedPods && (!state.preset || manage) ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void act(() => connect(enteredPod(url)));
          }}
        >
          <label>
            {m.controls.yourPod}
            <input
              type="text"
              inputMode="url"
              autoCapitalize="none"
              spellCheck={false}
              required
              value={url}
              aria-describedby={id}
              placeholder="sempods.org/alice"
              disabled={unavailable}
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>
          <p id={id} className="sp-access-hint">
            {m.controls.podHint}
          </p>
          <button
            className={c ? undefined : 'sp-access-primary'}
            disabled={unavailable}
          >
            {m.controls.signIn}
          </button>
        </form>
      ) : null}
      {!active && !c && (
        <p className="sp-access-hint">{m.controls.loginHint}</p>
      )}
      {activePod}
      {c?.session.kind === 'restoring' && (
        <p role="status">{m.controls.loading}</p>
      )}
      {c && !active && c.session.kind !== 'restoring' && (
        <>
          <p>{name(c.podUrl)}</p>
          {c.session.kind === 'ended' && !shownByNotice && (
            <p role="status">{endedMessage(c.session, m, true)}</p>
          )}
          <button
            className="sp-access-primary"
            disabled={unavailable}
            onClick={() => void act(() => app.authorize(c.id))}
          >
            {m.controls.signIn}
          </button>
        </>
      )}
      {active && contextRequired && !fixedContext && (
        <label>
          {m.dataContext}
          <select
            aria-label={m.dataContext}
            value={c?.selectedContext ?? ''}
            disabled={
              unavailable ||
              c?.catalogue.kind !== 'ready' ||
              readable.length === 0
            }
            onChange={(event) =>
              void act(() => app.selectContext(event.target.value))
            }
          >
            <option value="" disabled>
              {m.chooseContext}
            </option>
            {readable.map((entry) => (
              <option key={entry.iri} value={entry.iri}>
                {contextLabel(entry.iri)}
              </option>
            ))}
          </select>
        </label>
      )}
      {active && contextRequired && fixedContext && (
        <p>
          {m.dataContext}: {contextLabel(fixedContext)}
        </p>
      )}
      {active &&
        contextRequired &&
        !fixedContext &&
        c?.catalogue.kind === 'ready' &&
        readable.length === 0 && <p role="status">{m.noContexts}</p>}
      {c && (
        <details>
          <summary>{m.controls.addresses}</summary>
          <p>{c.podUrl}</p>
          {c.selectedContext &&
            !readable.some((entry) => entry.iri === c.selectedContext) && (
              <p>{c.selectedContext}</p>
            )}
          <dl>
            {readable.map((entry) => (
              <div key={entry.iri}>
                <dt>{contextLabel(entry.iri)}</dt>
                <dd>{entry.iri}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      {c && (
        <div className="sp-access-actions">
          {active && (
            <>
              <button
                disabled={unavailable}
                onClick={() => void act(() => app.authorize(c.id))}
              >
                {m.controls.updateAccess}
              </button>
              {contextRequired && (
                <button
                  disabled={unavailable}
                  onClick={() => void act(() => app.refreshContexts(c.id))}
                >
                  {m.controls.checkAccess}
                </button>
              )}
            </>
          )}
          {(manage || c.session.kind === 'ended') && (
            <button
              disabled={unavailable}
              onClick={() => void act(() => app.disconnect(c.id))}
            >
              {m.controls.disconnect}
            </button>
          )}
        </div>
      )}
      {failure && <p role="alert">{error(failure.cause)}</p>}
    </>
  );
}

const styles = `
[data-sempods-access] { padding:clamp(16px,4vw,32px); text-align:center; }
[data-sempods-access][hidden] { display:none; }
[data-sempods-access][data-initial]:not([hidden]) { min-block-size:32rem; display:grid; align-items:center; }
[data-sempods-access] * { box-sizing:border-box; }
[data-sempods-access] .sp-access-content { width:100%; max-width:22rem; margin-inline:auto; }
[data-sempods-access] header { margin:0 0 28px; }
[data-sempods-access] h1, [data-sempods-access] h2 { font-size:1.75rem; font-weight:500; line-height:1.25; margin:0; }
[data-sempods-access] .sp-access-icon { margin:0 auto 20px; width:56px; height:56px; }
[data-sempods-access] .sp-access-icon > * { width:100%; height:100%; object-fit:contain; }
[data-sempods-access] p { overflow-wrap:anywhere; margin:12px 0; }
[data-sempods-access] label { display:block; text-align:start; margin:18px 0; }
[data-sempods-access] input, [data-sempods-access] select { display:block; width:100%; min-width:0; margin:8px 0; font:inherit; color:inherit; background:var(--sp-bg); border:1px solid var(--sp-line); border-radius:4px; padding:12px; min-height:46px; }
[data-sempods-access] input { border-width:0 0 1px; border-radius:0; padding-inline:0; }
[data-sempods-access] input::placeholder { color:var(--sp-muted); opacity:1; }
[data-sempods-access] button { min-height:44px; font:inherit; font-weight:500; border:0; border-radius:5px; color:var(--sp-accent); background:transparent; padding:10px 14px; cursor:pointer; }
[data-sempods-access] .sp-access-primary { width:100%; margin-top:12px; color:var(--sp-on-accent); background:var(--sp-accent); }
[data-sempods-access] :disabled { opacity:.55; cursor:default; }
[data-sempods-access] :focus-visible { outline:2px solid var(--sp-accent); outline-offset:3px; }
[data-sempods-access] .sp-access-hint, [data-sempods-access] .sp-access-address, [data-sempods-access] details { font-size:.875rem; color:var(--sp-muted); }
[data-sempods-access] .sp-access-actions { display:flex; flex-wrap:wrap; gap:4px; justify-content:center; margin-top:16px; }
[data-sempods-access] details { margin-top:16px; overflow-wrap:anywhere; }
[data-sempods-access] summary { min-height:44px; padding:10px; cursor:pointer; }
`;
