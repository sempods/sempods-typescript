import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import type {
  AccessPrompt as AccessPromptFact,
  AccessState,
} from '../authoring/access.js';
import { runAccessAction, type AppSnapshot } from '../authoring/app.js';
import { describeFailure } from '../locale.js';
import { useAppFacts, useAppState, useController } from './app.js';
import { useSdkLocale } from './locale.js';
import { podName } from './names.js';
import { layered, SdkStyles } from './styles.js';
import { useFirst } from './first.js';
import { useCommitted } from './hooks.js';
import { useFocusHold } from './focus.js';

const selectAccess = (s: AppSnapshot) => s.access;

/**
 * The access prompts of the app snapshot (`AppSnapshot.access`) and
 * `dismiss`. Re-renders only when the prompts change.
 */
export function useAccessPrompts(): AccessState & {
  /** Retires a prompt that offers `dismiss`; `false` for any other. */
  readonly dismiss: (promptId: string) => boolean;
} {
  const app = useController();
  const access = useAppFacts(selectAccess);
  return useMemo(
    () => ({ ...access, dismiss: (id: string) => app.dismiss(id) }),
    [access, app],
  );
}

/** Internal: the localized message of one prompt, or none. */
export function usePromptText(prompt: AccessPromptFact): string | null {
  const state = useAppState();
  const { messages: m, format, error } = useSdkLocale();
  const c = state.connections.find((entry) => entry.id === prompt.connectionId);
  switch (prompt.reason) {
    case 'startup-failed':
      return error(state.startupError);
    case 'other-tab':
      return m.controls.busy;
    case 'storage':
      return m.controls.storage;
    case 'no-connection':
      return null;
    case 'signed-out':
      if (prompt.failure) return describeFailure(m.errors, prompt.failure);
      return prompt.problem && prompt.problem !== 'disconnected'
        ? (m.controls.sessionEnded ?? m.controls.signInRequired)
        : m.controls.signInRequired;
    case 'sign-out-failed':
      return c?.session.kind === 'ended' && c.session.forget
        ? (m.controls.forgetFailed ?? m.controls.failure)
        : (m.controls.disconnectFailed ?? m.controls.failure);
    case 'unreachable':
      return m.controls.unreachable ?? m.controls.readLost;
    case 'missing-scopes':
      return m.missingScopes(c?.missingRequiredScopes ?? [], format);
    case 'sign-in-failed':
      return prompt.failure
        ? describeFailure(m.errors, prompt.failure)
        : m.controls.failure;
    case 'sign-in-cancelled':
      return m.controls.signInCancelled;
    case 'sharing-unchanged':
      return m.controls.sharingUnchanged ?? m.controls.signInCancelled;
    case 'anonymous':
      return m.controls.anonymous ?? m.controls.signInRequired;
  }
}

/** Internal: a prompt's action buttons, run through the controller's guards. */
export function PromptActions({
  prompt,
  primary = true,
}: {
  readonly prompt: AccessPromptFact;
  /** Whether the first action is the surface's main one. */
  readonly primary?: boolean;
}) {
  const app = useController();
  const { changing, confirmingLeave, fixed } = useAppFacts(
    (s) => ({
      changing: s.changing,
      confirmingLeave: s.confirmingLeave,
      fixed: Boolean(s.preset?.podUrl ?? s.allowedPods?.length === 1),
    }),
    (a, b) =>
      a.changing === b.changing &&
      a.confirmingLeave === b.confirmingLeave &&
      a.fixed === b.fixed,
  );
  const { messages: m, error } = useSdkLocale();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ readonly cause: unknown } | null>(
    null,
  );
  const label = (action: AccessPromptFact['actions'][number]) =>
    action === 'sign-in'
      ? prompt.reason === 'missing-scopes'
        ? m.controls.updateAccess
        : m.controls.signIn
      : action === 'retry'
        ? m.controls.retry
        : action === 'forget'
          ? m.controls.forget
          : action === 'reload'
            ? (m.controls.reload ?? m.controls.retry)
            : (m.controls.dismiss ?? m.controls.close ?? 'OK');
  // A sign-in without a known address needs the gate's address field.
  const actions = prompt.actions.filter(
    (action) => action !== 'sign-in' || prompt.connectionId !== null || fixed,
  );
  if (actions.length === 0) return null;
  return (
    <>
      <div className="sp-sdk-actions">
        {actions.map((action, index) => (
          <button
            key={action}
            type="button"
            className={primary && index === 0 ? 'sp-sdk-primary' : undefined}
            disabled={busy || changing || confirmingLeave}
            onClick={() => {
              setBusy(true);
              setFailure(null);
              void runAccessAction(app, prompt, action)
                .catch((cause: unknown) => setFailure({ cause }))
                .finally(() => setBusy(false));
            }}
          >
            {label(action)}
          </button>
        ))}
      </div>
      {failure && <p role="alert">{error(failure.cause)}</p>}
    </>
  );
}

/** What `AccessPrompt` receives. */
export interface AccessPromptProps {
  readonly prompt: AccessPromptFact;
  /**
   * Focus after this prompt goes while it holds focus, as `focusTarget` of
   * `AppAccess`; without it, focus returns to where it came from.
   */
  readonly focusTarget?: RefObject<HTMLElement | null> | undefined;
}
/** What `AccessPrompts` receives. */
export interface AccessPromptsProps {
  /** Passed on to each prompt (see `AccessPromptProps`). */
  readonly focusTarget?: RefObject<HTMLElement | null> | undefined;
}

/**
 * One prompt: its localized message and action buttons, unstyled and
 * unpositioned, for the app's own toast, banner or dialog. A prompt about a
 * connection other than the active one names its Pod. Escape dismisses a
 * prompt that offers `dismiss`. When it goes while it holds focus, focus
 * returns to `focusTarget`, otherwise to where it came from.
 */
export function AccessPrompt({ prompt, focusTarget }: AccessPromptProps) {
  const app = useController();
  const element = useRef<HTMLDivElement>(null);
  const focus = useFocusHold();
  // Where focus came from, if no focusTarget is given.
  const previous = useRef<HTMLElement | null>(null);
  const target = useCommitted(focusTarget);
  useLayoutEffect(() => {
    // Read at unmount: only a held focus returns; focus elsewhere stays.
    const returnTo = () =>
      focus.held.current ? (target.current?.current ?? previous.current) : null;
    return () => {
      const next = returnTo();
      if (next?.isConnected) next.focus();
    };
  }, [focus.held, target]);
  const { connections, activeId } = useAppFacts(
    (s) => ({ connections: s.connections, activeId: s.activeId }),
    (a, b) => a.connections === b.connections && a.activeId === b.activeId,
  );
  const { direction } = useSdkLocale();
  const text = usePromptText(prompt);
  const c = connections.find((entry) => entry.id === prompt.connectionId);
  const other = c && c.id !== activeId ? podName(c.podUrl) : null;
  return (
    <div
      ref={element}
      data-sempods-ui="prompt"
      data-severity={prompt.severity}
      data-reason={prompt.reason}
      role={prompt.severity === 'info' ? 'status' : 'alert'}
      dir={direction}
      onFocusCapture={(event) => {
        const from = event.relatedTarget;
        if (from instanceof HTMLElement && !event.currentTarget.contains(from))
          previous.current = from;
        focus.onFocusCapture();
      }}
      onBlurCapture={focus.onBlurCapture}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && prompt.actions.includes('dismiss')) {
          event.stopPropagation();
          app.dismiss(prompt.id);
        }
      }}
    >
      <SdkStyles />
      {other && <p className="sp-prompt-pod">{other}</p>}
      {text && <p>{text}</p>}
      <PromptActions prompt={prompt} primary={prompt.severity !== 'info'} />
    </div>
  );
}

/** About 6 seconds, then an info prompt hides, unless focused or hovered. */
const infoTimeout = 6000;

function TimedPrompt({
  prompt,
  children,
}: {
  readonly prompt: AccessPromptFact;
  readonly children: ReactNode;
}) {
  const app = useController();
  const [held, setHeld] = useState({ hover: false, focus: false });
  const timed = prompt.severity === 'info' && !held.hover && !held.focus;
  const id = prompt.id;
  useEffect(() => {
    if (!timed) return;
    // Hiding dismisses it, so a remount or a second presenter does not replay it.
    const timer = setTimeout(() => app.dismiss(id), infoTimeout);
    return () => clearTimeout(timer);
  }, [timed, app, id]);
  const element = useRef<HTMLLIElement>(null);
  const blur = useCallback(
    (next: EventTarget | null) =>
      !(next instanceof Node && element.current?.contains(next)),
    [],
  );
  return (
    <li
      ref={element}
      onPointerEnter={() => setHeld((h) => ({ ...h, hover: true }))}
      onPointerLeave={() => setHeld((h) => ({ ...h, hover: false }))}
      onFocus={() => setHeld((h) => ({ ...h, focus: true }))}
      onBlur={(event) => {
        if (blur(event.relatedTarget)) setHeld((h) => ({ ...h, focus: false }));
      }}
    >
      {children}
    </li>
  );
}

/**
 * A default stack of all action and info prompts at the bottom of the
 * viewport, for apps without their own toast host; a polite live region.
 * Info prompts hide after about 6 seconds unless focused or hovered, which
 * dismisses them; action prompts stay until dismissed or resolved. Each
 * prompt gets `focusTarget` (see `AccessPrompt`). Shows nothing while a
 * blocking prompt holds the gate or the app still starts.
 */
export function AccessPrompts({ focusTarget }: AccessPromptsProps) {
  const { blocking, prompts } = useAccessPrompts();
  const { direction } = useSdkLocale();
  // One stack per provider, also with several AppAccess instances.
  const first = useFirst('prompts');
  // Prompts about other Pods wait for the startup screen to end.
  const starting = useAppFacts((s) => s.starting);
  const shown = blocking || !first || starting ? [] : prompts;
  return (
    <div
      data-sempods-ui="prompts"
      aria-live="polite"
      dir={direction}
      hidden={shown.length === 0}
    >
      <SdkStyles />
      <style href="sempods-prompts" precedence="sempods">
        {layered(styles)}
      </style>
      <ul>
        {shown.map((prompt) => (
          <TimedPrompt key={prompt.id} prompt={prompt}>
            <AccessPrompt prompt={prompt} focusTarget={focusTarget} />
          </TimedPrompt>
        ))}
      </ul>
    </div>
  );
}

const styles = `
[data-sempods-ui="prompts"] { position:fixed; inset-inline:16px; inset-block-end:16px; z-index:1000; pointer-events:none; }
[data-sempods-ui="prompts"][hidden] { display:none; }
[data-sempods-ui="prompts"] ul { list-style:none; margin:0 auto; padding:0; display:grid; gap:8px; max-width:28rem; }
[data-sempods-ui="prompts"] li { pointer-events:auto; background:var(--sp-bg); border:1px solid var(--sp-line); border-radius:calc(var(--sp-radius) * 1.5); padding:4px 16px 12px; box-shadow:0 8px 24px rgb(0 0 0 / .16); }
[data-sempods-ui="prompts"] .sp-prompt-pod { font-size:.875rem; color:var(--sp-muted); margin-block:8px 0; }
[data-sempods-ui="prompts"] .sp-sdk-actions { justify-content:flex-end; }
`;
