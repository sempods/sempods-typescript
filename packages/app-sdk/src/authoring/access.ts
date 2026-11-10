import type { SdkFailure } from '@sempods/client-sdk';
import type { RuntimeProblem } from '../runtime/errors.js';
import type {
  BrowserRuntime,
  Connection,
  StartupReport,
} from '../runtime/types.js';

/**
 * One access or session outcome that needs attention, derived from runtime
 * facts. `severity` says what the app can still do:
 * - `blocking`: the app cannot work; show a sign-in screen (`AccessGate`).
 * - `action`: something needs a decision; show a dialog or banner.
 * - `info`: nothing needs doing; show a toast that disappears.
 */
export interface AccessPrompt {
  /** Opaque. Stable while its cause lasts; a new cause gets a new id. */
  readonly id: string;
  readonly severity: 'blocking' | 'action' | 'info';
  readonly reason:
    | 'startup-failed'
    | 'other-tab'
    | 'storage'
    | 'no-connection'
    | 'signed-out'
    | 'sign-out-failed'
    | 'unreachable'
    | 'missing-scopes'
    | 'sign-in-failed'
    | 'sign-in-cancelled'
    | 'sharing-unchanged'
    /**
     * The active connection reads without a token (`signIn: 'optional'`):
     * only public data, no writes. An `action` with `sign-in` and `dismiss`,
     * and `forget` once the person signed out (the address is remembered).
     */
    | 'anonymous';
  /** The connection it is about; `null` for startup and callback problems without one. */
  readonly connectionId: string | null;
  /**
   * In the order to offer them; the first is primary. Each maps to an
   * existing call: `sign-in` → `authorize(id)`, or `connect()` without a
   * connection; `retry` → `retryRestore(id)` for `unreachable`, else
   * `disconnect(id)` (which forgets as well when the person asked to);
   * `forget` → `forget(id)`; `dismiss` → `dismiss(id)`; `reload` →
   * `location.reload()`.
   */
  readonly actions: readonly (
    'sign-in' | 'retry' | 'forget' | 'dismiss' | 'reload'
  )[];
  /** Why the session ended, for `signed-out`. */
  readonly problem?: RuntimeProblem;
  readonly failure?: SdkFailure;
}

/** What `AppSnapshot.access` reports. */
export interface AccessState {
  /**
   * Startup has not settled, or the active connection is restoring or leaving
   * for a sign-in. No prompt is derived; show content or a skeleton, never a
   * sign-in screen.
   */
  readonly pending: boolean;
  /**
   * At most one: a startup or no-connection problem, or a blocking problem of
   * the active connection. Show the gate. Never dismissible.
   */
  readonly blocking: AccessPrompt | null;
  /** Action and info prompts, oldest first, without dismissed ones. */
  readonly prompts: readonly AccessPrompt[];
}

type Reason = AccessPrompt['reason'];
type Action = AccessPrompt['actions'][number];
interface Facts {
  readonly signIn: BrowserRuntime['signIn'];
  readonly startup: StartupReport | undefined;
  readonly startupError: unknown;
  readonly callbackNotice: boolean;
  readonly connections: readonly Connection[];
  readonly activeId: string | null;
}
interface Cause {
  readonly key: string;
  readonly severity: AccessPrompt['severity'];
  readonly reason: Reason;
  readonly connectionId: string | null;
  readonly actions: readonly Action[];
  readonly problem?: RuntimeProblem | undefined;
  readonly failure?: SdkFailure | undefined;
}

const pendingState: AccessState = Object.freeze({
  pending: true,
  blocking: null,
  prompts: Object.freeze([]),
});

/**
 * The cause of one connection's prompt, from the first matching rule. Without
 * required sign-in (`signIn: 'optional'`), an ended session asks for a
 * decision instead of blocking: the connection still reads without a token.
 * Under `'none'` nothing offers signing in.
 */
function connectionCause(
  c: Connection,
  active: boolean,
  signIn: BrowserRuntime['signIn'],
): Cause | undefined {
  const s = c.session;
  const cause = (
    reason: Reason,
    severity: AccessPrompt['severity'],
    actions: readonly Action[],
    extra: Partial<Cause> = {},
  ): Cause => ({
    key: `${c.id}\n${reason}`,
    reason,
    severity,
    connectionId: c.id,
    actions,
    ...extra,
  });
  // Only the active connection blocks; another one asks for a decision. A
  // connection that still reads without a token never blocks.
  const severe = (reason: Reason, actions: readonly Action[], extra = {}) =>
    active && c.reading !== 'anonymous'
      ? cause(reason, 'blocking', actions, extra)
      : cause(reason, 'action', [...actions, 'dismiss'], extra);
  if (signIn === 'none') return undefined;
  if (s.kind === 'ended') {
    // A sign-out or forget in progress.
    if (s.problem === 'disconnected' && s.saved !== false) return undefined;
    if (s.saved === false)
      return severe('sign-out-failed', ['retry'], {
        failure: s.failure,
      });
    if (s.restorable)
      return cause(
        'unreachable',
        'action',
        active ? ['retry'] : ['retry', 'dismiss'],
        { problem: s.problem, failure: s.failure },
      );
    return severe('signed-out', ['sign-in', 'forget'], {
      problem: s.problem,
      failure: s.failure,
    });
  }
  if (s.kind === 'signed-out') {
    // A sign-out the person chose needs no prompt beside another Pod.
    const chosen = s.problem === undefined || s.problem === 'disconnected';
    if (!active && chosen) return undefined;
    // Read without a token: signing in is offered, not demanded.
    // Read without a token: signing in is offered, not demanded; an address
    // the person signed out of stays on this device until forgotten.
    if (chosen && c.reading === 'anonymous')
      return cause(
        'anonymous',
        'action',
        s.problem === 'disconnected'
          ? ['sign-in', 'forget', 'dismiss']
          : ['sign-in', 'dismiss'],
      );
    return severe('signed-out', ['sign-in', 'forget'], { problem: s.problem });
  }
  if (
    (s.kind === 'active' || s.kind === 'renewing') &&
    c.missingRequiredScopes.length > 0
  )
    return severe('missing-scopes', ['sign-in']);
  return undefined;
}

function samePrompt(a: AccessPrompt | null, b: AccessPrompt | null) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.id === b.id &&
    a.severity === b.severity &&
    a.reason === b.reason &&
    a.connectionId === b.connectionId &&
    a.actions.join() === b.actions.join() &&
    a.problem === b.problem &&
    a.failure === b.failure
  );
}

/**
 * Internal: derives `AppSnapshot.access` from the controller's facts and keeps
 * prompt identity and dismissals for the controller's lifetime (nothing is
 * persisted). An id lasts while its cause is present in consecutive
 * derivations; a retry of `unreachable` keeps it while the connection restores.
 */
export function createAccessTracker() {
  /** Cause key → id and its order of appearance. */
  let ids = new Map<string, { readonly id: string; readonly order: number }>();
  let next = 0;
  const dismissed = new Set<string>();
  let state: AccessState = pendingState;

  function idOf(key: string, kept: typeof ids) {
    const known = ids.get(key);
    const entry = known ?? { id: `access-${++next}`, order: next };
    kept.set(key, entry);
    return entry;
  }

  function derive(f: Facts): AccessState {
    const settled = f.startup !== undefined || f.startupError !== undefined;
    const active = f.connections.find((c) => c.id === f.activeId);
    if (
      !settled ||
      active?.session.kind === 'restoring' ||
      active?.session.kind === 'leaving'
    )
      // Identity and dismissals wait; nothing is derived meanwhile.
      return (state = pendingState);
    const causes: Cause[] = [];
    const global = (reason: Reason, actions: readonly Action[]) =>
      causes.push({
        key: `startup\n${reason}`,
        reason,
        severity: 'blocking',
        connectionId: null,
        actions,
      });
    if (f.startupError !== undefined) global('startup-failed', ['reload']);
    else if (f.startup?.storage === 'busy') global('other-tab', ['reload']);
    // Without sign-in, nothing is stored on purpose.
    else if (f.startup?.storage === 'unavailable' && f.signIn !== 'none')
      global('storage', []);
    else {
      if (!active) global('no-connection', ['sign-in']);
      for (const c of f.connections) {
        const cause = connectionCause(c, c === active, f.signIn);
        if (cause) causes.push(cause);
      }
      const startup = f.startup;
      if (
        f.callbackNotice &&
        startup &&
        (startup.interaction === 'failed' ||
          startup.interaction === 'cancelled')
      ) {
        const attempt = f.connections.some(
          (c) => c.id === startup.attemptConnectionId,
        )
          ? startup.attemptConnectionId!
          : null;
        const owner = causes.findIndex(
          (c) => attempt !== null && c.connectionId === attempt,
        );
        const session = f.connections.find((c) => c.id === attempt)?.session;
        // Signing out or forgetting that connection answers the callback.
        const leaving =
          session?.kind === 'ended' && session.problem === 'disconnected';
        if (owner >= 0) {
          // The connection's prompt explains it; it takes over the failure.
          const existing = causes[owner]!;
          if (!existing.failure && startup.failure)
            causes[owner] = { ...existing, failure: startup.failure };
        } else if (leaving) {
          // Nothing to add while that connection signs out.
        } else if (startup.interaction === 'failed')
          causes.push({
            key: 'callback\nsign-in-failed',
            reason: 'sign-in-failed',
            severity: 'action',
            connectionId: attempt,
            // Without a known target, a new sign-in goes through the gate or
            // management, never by authorizing another connection.
            actions: attempt ? ['sign-in', 'dismiss'] : ['dismiss'],
            failure: startup.failure,
          });
        else {
          const reason = startup.resumed
            ? 'sharing-unchanged'
            : 'sign-in-cancelled';
          causes.push({
            key: `callback\n${reason}`,
            reason,
            severity: 'info',
            connectionId: attempt,
            actions: ['dismiss'],
          });
        }
      }
    }
    const kept: typeof ids = new Map();
    for (const c of f.connections) {
      // A retry of an unreachable Pod keeps its prompt's identity while it restores.
      const key = `${c.id}\nunreachable`;
      const entry = ids.get(key);
      if (entry && c.session.kind === 'restoring') kept.set(key, entry);
      // Reading without a token lasts while another Pod is active: its
      // prompt keeps its identity, and a dismissal, until the person signs in.
      const anonymous = `${c.id}\nanonymous`;
      const prompt = ids.get(anonymous);
      if (prompt && c.reading === 'anonymous') kept.set(anonymous, prompt);
    }
    let blocking: AccessPrompt | null = null;
    const prompts: { prompt: AccessPrompt; order: number }[] = [];
    for (const cause of causes) {
      const { id, order } = idOf(cause.key, kept);
      const prompt: AccessPrompt = Object.freeze({
        id,
        severity: cause.severity,
        reason: cause.reason,
        connectionId: cause.connectionId,
        actions: Object.freeze([...cause.actions]),
        ...(cause.problem ? { problem: cause.problem } : {}),
        ...(cause.failure ? { failure: cause.failure } : {}),
      });
      if (prompt.severity === 'blocking') blocking ??= prompt;
      // Dismissal never hides a prompt that does not offer it.
      else if (!(dismissed.has(id) && prompt.actions.includes('dismiss')))
        prompts.push({ prompt, order });
    }
    ids = kept;
    const live = new Set([...kept.values()].map((e) => e.id));
    for (const id of dismissed) if (!live.has(id)) dismissed.delete(id);
    prompts.sort((a, b) => a.order - b.order);
    const list = prompts.map((p) => p.prompt);
    // Equal facts keep their identity, so subscribers can skip a render.
    if (
      !state.pending &&
      samePrompt(state.blocking, blocking) &&
      state.prompts.length === list.length &&
      state.prompts.every((p, i) => samePrompt(p, list[i]!))
    )
      return state;
    return (state = Object.freeze({
      pending: false,
      blocking,
      prompts: Object.freeze(list),
    }));
  }

  return {
    derive,
    /** Whether a prompt is still listed with that action. */
    current(prompt: AccessPrompt, action: Action) {
      const now =
        state.blocking?.id === prompt.id
          ? state.blocking
          : state.prompts.find((p) => p.id === prompt.id);
      return now &&
        now.connectionId === prompt.connectionId &&
        now.actions.includes(action)
        ? now
        : undefined;
    },
    /** Retires a listed prompt that offers `dismiss`; returns it, else nothing. */
    dismiss(id: string) {
      const prompt = state.prompts.find((p) => p.id === id);
      if (!prompt || !prompt.actions.includes('dismiss')) return undefined;
      dismissed.add(id);
      return prompt;
    },
  };
}
