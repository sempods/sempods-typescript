import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { useApp, useAppState, useWorkflowAccess } from './app.js';
import { useSdkLocale } from './locale.js';
import {
  AccessNotice,
  CallbackNotice,
  type ConnectionControlsProps,
} from './components.js';
import { describeFailure } from '../locale.js';

export interface AppAccessProps {
  readonly appName: string;
  /** App-owned decorative icon, for example <img src="/icon.png" alt="" />. */
  readonly icon?: ReactNode;
  /** Exact Pod URL → friendly name. A name never changes the destination. */
  readonly podNames?: Readonly<Record<string, string>>;
  /** Explicit host-owned management toggle; never opens a dialog or starts login. */
  readonly open?: boolean;
  /** Focus here if a focused access control disappears after successful recovery. */
  readonly focusTarget?: RefObject<HTMLElement | null>;
  readonly components?: {
    readonly Connections?: ComponentType<ConnectionControlsProps>;
  };
  readonly className?: string;
  readonly style?: CSSProperties;
}

/**
 * Centered login/recovery UI beside, never around, app content. Uses the host's
 * existing runtime facts/actions; hides when a target is readable unless open.
 * Read-only targets remain usable. Callback failures remain visible separately.
 * Keep this outside hidden/inert widget regions and keep TargetScreen/editor
 * children mounted during same-target access loss; this is not a content gate.
 * Inline, scoped defaults use --sempods-access-* CSS variables; no stylesheet
 * import or UI framework is required. A CSP must permit this component's styles.
 */
export function AppAccess({
  appName,
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
  const { messages: m, direction, error } = useSdkLocale();
  const heldFocus = useRef(false);
  const callbackFailed =
    state.startup?.interaction === 'failed' ||
    state.startup?.interaction === 'cancelled';
  const needsAttention =
    !access.read || access.connection?.catalogue.kind === 'failed';
  const hidden = !needsAttention && !open && !callbackFailed;
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
  const Connections = components?.Connections;
  const available = state.startup?.storage === 'durable' && !state.startupError;
  const active =
    access.connection?.session.kind === 'active' ||
    access.connection?.session.kind === 'renewing';
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
      data-initial={!state.view && !open ? '' : undefined}
      aria-label={m.controls.dataAccess}
      dir={direction}
      className={className}
      style={style}
    >
      <style>{styles}</style>
      <div className="sp-access-content">
        {(needsAttention || open) && (
          <header>
            {icon && (
              <div className="sp-access-icon" aria-hidden="true">
                {icon}
              </div>
            )}
            <h1>{open || state.view ? m.controls.dataAccess : appName}</h1>
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
                  <Connections
                    mode="multiple"
                    {...(podNames ? { podNames } : {})}
                  />
                ) : (
                  <AccessConnections
                    manage={open}
                    {...(podNames ? { podNames } : {})}
                  />
                )}
                {active &&
                  available &&
                  (access.connection?.selectedContext ||
                    access.connection?.missingRequiredScopes.length ||
                    access.connection?.catalogue.kind !== 'ready' ||
                    state.preset?.contextIri) && <AccessNotice />}
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}

// CatalogueContext currently exposes no label. Use the safe final path segment;
// keep full identities available, and disambiguate duplicate names in selectors.
function contextName(iri: string) {
  const segment = iri.slice(iri.lastIndexOf('/') + 1);
  try {
    return (
      decodeURIComponent(segment).replace(
        // Strip control/bidi characters from display only; IRI identity stays exact.
        // eslint-disable-next-line no-control-regex
        /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
        '',
      ) || iri
    );
  } catch {
    return segment || iri;
  }
}
function podName(url: string, names?: Readonly<Record<string, string>>) {
  return names?.[url]?.trim() || url.replace(/^https?:\/\//, '');
}
/** Presentation-only convenience. Canonical URL/security validation stays in the runtime. */
function enteredPod(value: string) {
  const text = value.trim();
  return /^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`;
}

function AccessConnections({
  manage,
  podNames,
}: {
  readonly manage: boolean;
  readonly podNames?: Readonly<Record<string, string>>;
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
      if (await app.selectConnection(existing.id))
        await app.authorize(existing.id);
    } else await app.connect(target);
  }
  const showNew = manage || !c;
  const showDefault =
    defaultUrl && c?.podUrl !== defaultUrl && !(manage && !state.allowedPods);
  const choice = url || defaultUrl || '';
  const name = (target: string) => {
    const label = podName(target, podNames);
    const duplicates = (
      state.allowedPods ?? state.connections.map((entry) => entry.podUrl)
    ).some((other) => other !== target && podName(other, podNames) === label);
    return duplicates ? `${label} · ${target}` : label;
  };
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
            className="sp-access-primary"
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
      ) : showDefault ? (
        <div>
          <p>{name(defaultUrl)}</p>
          {podNames?.[defaultUrl] && (
            <p className="sp-access-address">{defaultUrl}</p>
          )}
          <button
            className="sp-access-primary"
            disabled={
              unavailable ||
              state.connections.some(
                (entry) =>
                  entry.podUrl === defaultUrl &&
                  entry.session.kind === 'restoring',
              )
            }
            onClick={() => void act(() => connect(defaultUrl))}
          >
            {m.controls.signIn}
          </button>
        </div>
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
          <button className="sp-access-primary" disabled={unavailable}>
            {m.controls.signIn}
          </button>
        </form>
      ) : null}
      {!active && !c && (
        <p className="sp-access-hint">{m.controls.loginHint}</p>
      )}
      {state.connections.length > 1 && (
        <label>
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
                {state.connections.filter(
                  (other) => other.podUrl === entry.podUrl,
                ).length > 1
                  ? ` · ${state.connections.indexOf(entry) + 1}`
                  : ''}
              </option>
            ))}
          </select>
        </label>
      )}
      {c?.session.kind === 'restoring' && (
        <p role="status">{m.controls.loading}</p>
      )}
      {c && !active && c.session.kind !== 'restoring' && (
        <>
          <p>{name(c.podUrl)}</p>
          {c.session.kind === 'ended' && (
            <p role="status">
              {c.session.failure
                ? describeFailure(m.errors, c.session.failure)
                : m.controls.readLost}
            </p>
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
      {active && !fixedContext && (
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
            {readable.map((entry) => {
              const label = contextName(entry.iri);
              return (
                <option key={entry.iri} value={entry.iri}>
                  {readable.some(
                    (other) =>
                      other.iri !== entry.iri &&
                      contextName(other.iri) === label,
                  )
                    ? `${label} · ${entry.iri}`
                    : label}
                </option>
              );
            })}
          </select>
        </label>
      )}
      {active && fixedContext && (
        <p>
          {m.dataContext}: {contextName(fixedContext)}
        </p>
      )}
      {active &&
        !fixedContext &&
        c?.catalogue.kind === 'ready' &&
        readable.length === 0 && <p role="status">{m.noContexts}</p>}
      {c && (
        <details>
          <summary>{m.controls.addresses}</summary>
          <p>{c.podUrl}</p>
          {c.selectedContext && <p>{c.selectedContext}</p>}
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
              <button
                disabled={unavailable}
                onClick={() => void act(() => app.refreshContexts(c.id))}
              >
                {m.controls.checkAccess}
              </button>
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
[data-sempods-access] { --sempods-access-bg:light-dark(#fff,#191b1a); --sempods-access-text:light-dark(#202923,#e8eee9); --sempods-access-muted:light-dark(#606c64,#acb9b0); --sempods-access-line:light-dark(#dce3dd,#39453d); --sempods-access-accent:light-dark(#226044,#8acda6); --sempods-access-on-accent:light-dark(#fff,#14251b); color-scheme:light dark; color:var(--sempods-access-text); background:var(--sempods-access-bg); font:400 1rem/1.5 system-ui,sans-serif; padding:clamp(16px,4vw,32px); text-align:center; }
[data-sempods-access][hidden] { display:none; }
[data-sempods-access][data-initial]:not([hidden]) { min-block-size:32rem; display:grid; align-items:center; }
[data-sempods-access] * { box-sizing:border-box; }
[data-sempods-access] .sp-access-content { width:100%; max-width:22rem; margin-inline:auto; }
[data-sempods-access] header { margin:0 0 28px; }
[data-sempods-access] h1 { font-size:1.75rem; font-weight:500; line-height:1.25; margin:0; }
[data-sempods-access] .sp-access-icon { margin:0 auto 20px; width:56px; height:56px; }
[data-sempods-access] .sp-access-icon > * { width:100%; height:100%; object-fit:contain; }
[data-sempods-access] p { overflow-wrap:anywhere; margin:12px 0; }
[data-sempods-access] label { display:block; text-align:start; margin:18px 0; }
[data-sempods-access] input, [data-sempods-access] select { display:block; width:100%; min-width:0; margin:8px 0; font:inherit; color:inherit; background:var(--sempods-access-bg); border:1px solid var(--sempods-access-line); border-radius:4px; padding:12px; min-height:46px; }
[data-sempods-access] input { border-width:0 0 1px; border-radius:0; padding-inline:0; }
[data-sempods-access] input::placeholder { color:var(--sempods-access-muted); opacity:1; }
[data-sempods-access] button { min-height:44px; font:inherit; font-weight:500; border:0; border-radius:5px; color:var(--sempods-access-accent); background:transparent; padding:10px 14px; cursor:pointer; }
[data-sempods-access] .sp-access-primary { width:100%; margin-top:12px; color:var(--sempods-access-on-accent); background:var(--sempods-access-accent); }
[data-sempods-access] :disabled { opacity:.55; cursor:default; }
[data-sempods-access] :focus-visible { outline:2px solid var(--sempods-access-accent); outline-offset:3px; }
[data-sempods-access] .sp-access-hint, [data-sempods-access] .sp-access-address, [data-sempods-access] details { font-size:.875rem; color:var(--sempods-access-muted); }
[data-sempods-access] .sp-access-actions { display:flex; flex-wrap:wrap; gap:4px; justify-content:center; margin-top:16px; }
[data-sempods-access] details { margin-top:16px; overflow-wrap:anywhere; }
[data-sempods-access] summary { min-height:44px; padding:10px; cursor:pointer; }
`;
