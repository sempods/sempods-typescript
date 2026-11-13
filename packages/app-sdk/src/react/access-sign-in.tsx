import { useId, useLayoutEffect, useRef, useState } from 'react';
import { useApp, useAppState } from './app.js';
import { useSdkLocale } from './locale.js';
import { endedMessage } from './components.js';
import { distinctName, podName } from './names.js';
import type { ConnectionsProps } from './access.js';

/** Presentation convenience only; canonical/security validation stays in the runtime. */
export function enteredPod(value: string) {
  const text = value.trim().replace(/\/$/, '');
  return /^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`;
}

/** One choice and one action. This component owns no session or target state. */
export function SignInConnections({
  mode = 'multiple',
  podNames,
  podAddress = 'visible',
  surface = 'sign-in',
}: ConnectionsProps) {
  const app = useApp();
  const state = useAppState();
  const { messages: m, error } = useSdkLocale();
  const id = useId();
  const form = useRef<HTMLFormElement>(null);
  const removing = useRef<string | null>(null);
  const changingField = useRef(false);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ cause: unknown } | null>(null);
  const [chosen, setChosen] = useState('');
  const [entering, setEntering] = useState(false);
  const [url, setUrl] = useState('');
  const defaultUrl =
    state.preset?.podUrl ??
    (state.allowedPods?.length === 1 ? state.allowedPods[0] : undefined);
  const connections = state.connections;
  const options = [
    ...connections.map((connection) => ({
      key: connection.id,
      url: connection.podUrl,
      connection,
    })),
    ...(state.allowedPods ?? (defaultUrl ? [defaultUrl] : []))
      .filter((target) => !connections.some((c) => c.podUrl === target))
      .map((target) => ({
        key: `url:${target}`,
        url: target,
        connection: undefined,
      })),
  ];
  const selected =
    options.find((o) => o.key === chosen) ??
    options.find((o) => o.key === state.activeId) ??
    options.find((o) => o.url === defaultUrl) ??
    options[0];
  const c = selected?.connection;
  const free =
    !state.allowedPods &&
    (mode === 'multiple' ||
      !connections.some((entry) => entry.session.kind !== 'signed-out'));
  const field = options.length === 0 || (free && entering);
  const entered = field
    ? (connections.find(
        (entry) =>
          entry.id === state.activeId && entry.podUrl === enteredPod(url),
      ) ?? connections.find((entry) => entry.podUrl === enteredPod(url)))
    : undefined;
  const targetConnection = field ? entered : c;
  const failedRetirement =
    targetConnection?.session.kind === 'ended' &&
    targetConnection.session.saved === false;
  const forgetFailed =
    targetConnection?.session.kind === 'ended' &&
    targetConnection.session.forget === true;
  const hiddenAddress =
    podAddress === 'hidden' &&
    surface === 'sign-in' &&
    state.allowedPods?.length === 1;
  const unavailable =
    busy ||
    state.changing ||
    state.confirmingLeave ||
    !state.startup ||
    (state.startup.storage !== 'durable' && state.signIn !== 'none') ||
    Boolean(state.startupError);
  const restoring = targetConnection?.session.kind === 'restoring';
  const leaving = connections.some(
    (entry) => entry.id === state.activeId && entry.session.kind === 'leaving',
  );
  const readable =
    !field &&
    c?.reading !== null &&
    c !== undefined &&
    c.missingRequiredScopes.length === 0;
  const retry = !field && c?.session.kind === 'ended' && c.session.restorable;
  const label =
    retry || failedRetirement
      ? m.controls.retry
      : readable || state.signIn !== 'required'
        ? (m.controls.open ?? m.controls.signIn)
        : !field &&
            (c?.session.kind === 'active' || c?.session.kind === 'renewing')
          ? m.controls.updateAccess
          : m.controls.signIn;
  const saved = connections.filter(
    (entry) =>
      entry.session.kind === 'signed-out' ||
      entry.session.kind === 'active' ||
      entry.session.kind === 'renewing' ||
      (entry.session.kind === 'ended' && !entry.session.restorable),
  );
  const name = (target: string) =>
    distinctName(
      target,
      options.map((o) => o.url),
      (value) => podName(value, podNames),
    );
  const callbackExplains =
    state.callbackNotice &&
    state.startup?.attemptConnectionId === c?.id &&
    c?.session.kind === 'ended' &&
    c.session.problem === state.startup?.problem;

  useLayoutEffect(() => {
    if (changingField.current) {
      changingField.current = false;
      form.current?.querySelector<HTMLElement>('input, button')?.focus();
    }
    if (
      !busy &&
      removing.current &&
      !connections.some((entry) => entry.id === removing.current)
    ) {
      removing.current = null;
      form.current?.querySelector<HTMLElement>('input, button')?.focus();
    }
  }, [connections, field, busy]);

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
  async function proceed() {
    // A failed retirement remains a retry even when its Pod is not the active
    // connection (and therefore has no blocking gate), or its address is typed.
    if (failedRetirement && targetConnection) {
      if (forgetFailed) await app.forget(targetConnection.id);
      else await app.disconnect(targetConnection.id);
      return;
    }
    if (field) {
      const target = enteredPod(url);
      const existing = entered;
      if (existing?.session.kind === 'restoring') return;
      if (existing) {
        if (state.signIn === 'required') await app.authorize(existing.id);
        else await app.selectConnection(existing.id);
      } else await app.connect(target);
    } else if (c) {
      if (retry) await app.retryRestore(c.id);
      else if (readable) await app.selectConnection(c.id);
      else await app.authorize(c.id);
    } else if (selected) await app.connect(selected.url);
  }

  if (leaving)
    return <p role="status">{m.controls.leaving ?? m.controls.loading}</p>;
  return (
    <div className="sp-sign-in">
      <form
        ref={form}
        onSubmit={(event) => {
          event.preventDefault();
          void act(proceed);
        }}
      >
        {field ? (
          <>
            <label htmlFor={`${id}-address`}>{m.controls.yourPod}</label>
            <input
              id={`${id}-address`}
              type="text"
              inputMode="url"
              autoCapitalize="none"
              spellCheck={false}
              required
              value={url}
              placeholder={m.controls.podPlaceholder}
              aria-describedby={m.controls.podHint ? `${id}-hint` : undefined}
              disabled={unavailable}
              onChange={(event) => setUrl(event.target.value)}
            />
            {m.controls.podHint && (
              <p id={`${id}-hint`} className="sp-access-hint">
                {m.controls.podHint}
              </p>
            )}
          </>
        ) : hiddenAddress &&
          options.length === 1 &&
          !podNames?.[selected?.url ?? '']?.trim() ? null : (
          <fieldset className="sp-sign-in-choices" disabled={unavailable}>
            <legend>
              {options.length > 1
                ? m.controls.choosePod
                : c
                  ? m.controls.savedPod
                  : m.controls.yourPod}
            </legend>
            {options.map((option, index) => (
              <label className="sp-sign-in-choice" key={option.key}>
                {options.length > 1 && (
                  <input
                    type="radio"
                    name={`${id}-pod`}
                    value={option.key}
                    checked={selected?.key === option.key}
                    onChange={() => {
                      setChosen(option.key);
                      setFailure(null);
                    }}
                  />
                )}
                <span>
                  {hiddenAddress
                    ? podNames?.[option.url]?.trim() ||
                      (options.length > 1 ? `${index + 1}` : m.controls.yourPod)
                    : name(option.url)}
                  {!hiddenAddress &&
                    podNames?.[option.url]?.trim() &&
                    name(option.url) === podNames[option.url]?.trim() && (
                      <span className="sp-access-address">{option.url}</span>
                    )}
                  {(!hiddenAddress ||
                    Boolean(podNames?.[option.url]?.trim())) &&
                    options.filter((o) => o.url === option.url).length > 1 &&
                    ` · ${index + 1}`}
                </span>
              </label>
            ))}
          </fieldset>
        )}
        {!field &&
          c?.session.kind === 'signed-out' &&
          c.session.problem &&
          c.session.problem !== 'disconnected' && (
            <p role="status">{m.controls.sessionEnded}</p>
          )}
        {!field &&
          c?.session.kind === 'ended' &&
          !failedRetirement &&
          !callbackExplains && (
            <p role="status">{endedMessage(c.session, m, true)}</p>
          )}
        {failedRetirement && (
          <p role="alert">
            {forgetFailed
              ? m.controls.forgetFailed
              : m.controls.disconnectFailed}
          </p>
        )}
        {restoring && <p role="status">{m.controls.loading}</p>}
        <button
          className="sp-access-primary sp-access-wide"
          disabled={unavailable || restoring || (!field && !selected)}
        >
          {label}
        </button>
      </form>
      {state.signIn === 'required' && m.controls.loginHint && (
        <p className="sp-access-hint">{m.controls.loginHint}</p>
      )}
      {free && options.length > 0 && (
        <button
          type="button"
          className="sp-sign-in-secondary"
          disabled={unavailable}
          onClick={() => {
            changingField.current = true;
            setEntering(!field);
            setFailure(null);
          }}
        >
          {field ? m.controls.useSavedPod : m.controls.useAnotherPod}
        </button>
      )}
      {saved.length > 0 && (
        <details className="sp-sign-in-management">
          <summary>{m.controls.manageSavedPods}</summary>
          <p className="sp-access-hint">{m.controls.forgetHint}</p>
          <ul
            className="sp-access-remembered"
            aria-label={m.controls.rememberedPods}
          >
            {saved.map((entry) => (
              <li key={entry.id}>
                <p id={`${id}-${entry.id}`}>{entry.podUrl}</p>
                {(entry.session.kind === 'signed-out' ||
                  entry.session.kind === 'ended') && (
                  <button
                    disabled={unavailable}
                    aria-describedby={`${id}-${entry.id}`}
                    onClick={() => {
                      removing.current = entry.id;
                      void act(() => app.forget(entry.id));
                    }}
                  >
                    {m.controls.removeSavedPod ?? m.controls.forget}
                  </button>
                )}
                {entry.session.kind !== 'signed-out' &&
                  !(entry.session.kind === 'ended' && entry.session.forget) && (
                    <button
                      disabled={unavailable}
                      aria-describedby={`${id}-${entry.id}`}
                      onClick={() => void act(() => app.disconnect(entry.id))}
                    >
                      {m.controls.disconnect}
                    </button>
                  )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {hiddenAddress && c && saved.length === 0 && selected && (
        <details>
          <summary>{m.controls.addresses}</summary>
          <p>{selected.url}</p>
        </details>
      )}
      {failure && <p role="alert">{error(failure.cause)}</p>}
    </div>
  );
}
