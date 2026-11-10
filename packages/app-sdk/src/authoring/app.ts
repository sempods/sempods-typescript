import type {
  BrowserRuntime,
  Connection,
  StartupReport,
  PodPreset,
} from '../runtime/types.js';
import { RuntimeError } from '../runtime/errors.js';
import type { BoundPod, BoundView } from '../runtime/view.js';
import {
  createAccessTracker,
  type AccessPrompt,
  type AccessState,
} from './access.js';

export interface LeaveGuard {
  /**
   * Which guarded changes leave this guard, so ask about and discard it:
   * - `local` (also when omitted): every change: `navigate`, `selectContext`
   *   and the connection actions (`selectConnection`, `connect`, `authorize`,
   *   `disconnect`, `forget`).
   * - `target`: survives `navigate` (row navigation); left by the others.
   * - `connection`: survives `selectContext`, for a draft bound to an explicit
   *   Context rather than the selection; left by the others.
   * - `explicit`: survives `navigate` and `selectContext`, for a creation in an
   *   explicit Context that row navigation does not touch; left by connection
   *   actions.
   *
   * A pending write (`blocked()`) blocks every change, except that a
   * `connection` or `explicit` guard does not block `selectContext`, which
   * leaves it alone.
   */
  readonly scope?: 'local' | 'target' | 'connection' | 'explicit';
  unconfirmed?(): boolean;
  blocked(): boolean;
  dirty(): boolean;
  discard(): void;
  /**
   * Tells the controller that `dirty()` or `blocked()` may have changed, so
   * the browser's leave prompt follows them (see
   * `AppControllerOptions.unloadPrompt`). Without it, a guard is read again
   * only when the controller itself changes or another guard reports.
   */
  subscribe?(listener: () => void): () => void;
}
/** A readable Context of one connection: what `selectTarget` selects. */
export interface ContextTarget {
  readonly connectionId: string;
  readonly contextIri: string;
}
/**
 * What `selectTarget` did:
 * - `selected`: that connection is active with that Context, also when it
 *   already was.
 * - `declined`: the person stayed, or the prompt was cancelled.
 * - `blocked`: a pending write, or another change preparing or asking.
 * - `unavailable`: the target cannot be selected, before asking or because it
 *   disappeared while the person was asked: no such `connection`, its
 *   `session` neither reads (`Connection.reading`) nor holds the required
 *   access, its `catalogue` is
 *   not loaded, the Context is `unlisted` as readable, or the `preset` names
 *   another Context of that Pod.
 */
export type TargetSelection =
  | { readonly kind: 'selected' }
  | { readonly kind: 'declined' }
  | { readonly kind: 'blocked' }
  | {
      readonly kind: 'unavailable';
      readonly reason:
        'connection' | 'session' | 'catalogue' | 'unlisted' | 'preset';
    };
type Unavailable = Extract<TargetSelection, { kind: 'unavailable' }>['reason'];
type Availability = 'yes' | 'later' | 'gone';

/** Why a target cannot be selected now, from the runtime's own facts. */
export function targetProblem(
  connections: readonly Connection[],
  preset: PodPreset | undefined,
  target: ContextTarget,
): Unavailable | null {
  const connection = connections.find((c) => c.id === target.connectionId);
  if (!connection) return 'connection';
  // Signed in, or reading without a token (`signIn: 'optional'` or `'none'`).
  if (
    connection.reading === null ||
    connection.missingRequiredScopes.length > 0
  )
    return 'session';
  if (
    connection.podUrl === preset?.podUrl &&
    preset.contextIri !== undefined &&
    target.contextIri !== preset.contextIri
  )
    return 'preset';
  if (connection.catalogue.kind !== 'ready') return 'catalogue';
  if (
    !connection.catalogue.contexts.some(
      (c) => c.iri === target.contextIri && c.readable,
    )
  )
    return 'unlisted';
  return null;
}

/** Whether controller startup has settled: `startup` or `startupError` is set. */
export function startupSettled(
  snapshot: Pick<AppSnapshot, 'startup' | 'startupError'>,
) {
  return snapshot.startup !== undefined || snapshot.startupError !== undefined;
}
/** A guarded change: row navigation, a Context selection, or a connection action. */
type Change = 'navigate' | 'context' | 'connection';
/** Whether a guarded change leaves a guard (see `LeaveGuard.scope`). */
function leaves(change: Change, guard: LeaveGuard) {
  if (change === 'navigate')
    return guard.scope !== 'target' && guard.scope !== 'explicit';
  if (change === 'context')
    return guard.scope !== 'connection' && guard.scope !== 'explicit';
  return true;
}
export interface AppSnapshot {
  /** Compatibility default is required; on-demand leaves discovery to scoped flows. */
  readonly contextSelection: 'required' | 'on-demand';
  /** The runtime's `signIn` mode: whether the app offers signing in at all. */
  readonly signIn: BrowserRuntime['signIn'];
  readonly preset: PodPreset | undefined;
  /** Immutable runtime policy; undefined means unrestricted. */
  readonly allowedPods?: readonly string[];
  readonly startup: StartupReport | undefined;
  readonly startupError: unknown;
  /**
   * Whether the startup's failed or cancelled callback still needs presenting.
   * Cleared once the person selects another connection, disconnects or
   * forgets one, starts a sign-in or dismisses the callback's prompt;
   * `startup` itself stays unchanged.
   * @deprecated Read `access` instead; kept until 1.0.
   */
  readonly callbackNotice: boolean;
  /**
   * Access and session outcomes that need attention, derived from the facts
   * above: a blocking one for a sign-in screen, and action and info prompts
   * for the app's own dialogs, banners and toasts. See `AccessState`.
   */
  readonly access: AccessState;
  readonly connections: readonly Connection[];
  /**
   * The connection the app works with. Without an earlier choice it is the
   * preset's Pod, else the first connection that is not merely remembered
   * (`signed-out`), else the first remembered one.
   */
  readonly activeId: string | null;
  /**
   * The selected Context's view of the active connection. `null` until startup
   * settles (`startup` or `startupError` set): while a returning sign-in
   * completes, saved sessions may already restore, and a draft started in that
   * window would be lost when the returning connection becomes active.
   */
  readonly view: BoundView | null;
  /** Reader for the active signed-in Pod; independent of selected Context and catalogue. */
  readonly pod: BoundPod | null;
  /**
   * A leave prompt is pending. It ends with `confirmLeave()` or `cancelLeave()`,
   * or by itself when the connection that was active when it asked stops being
   * active outside a guarded action (a returning sign-in, or that connection
   * removed): the controller then cancels it. Close a custom prompt whenever
   * this turns false.
   */
  readonly confirmingLeave: boolean;
  readonly unconfirmedLeave: boolean;
  /** Hosts must prevent new user input while a guarded action is preparing. */
  readonly changing: boolean;
}
export interface AppControllerOptions {
  /** Required preserves automatic catalogues; on-demand uses explicit discovery/Context flows. */
  readonly contextSelection?: 'required' | 'on-demand';
  /**
   * While started and a registered guard is dirty or blocked (a draft, a
   * pending or unconfirmed write), the controller adds one `beforeunload`
   * listener to `window`, so reloading, closing the tab, typing an address
   * or going back past the app asks with the browser's own prompt. It
   * removes the listener once nothing is left, so a clean page keeps its
   * back/forward cache. `false` never adds it, for an app that keeps its
   * drafts across reloads itself. Default `true`.
   */
  readonly unloadPrompt?: boolean;
}

type Navigation = (
  action: () => void | Promise<void>,
  retained: ReadonlySet<LeaveGuard>,
) => Promise<boolean>;
const retainedNavigation = new WeakMap<object, Navigation>();
/**
 * Internal: reopening retained work does not leave its guards. Other guards,
 * pending writes and an existing transition still apply. No public bypass API.
 */
export function navigateRetaining(
  app: AppController,
  action: () => void | Promise<void>,
  retained: ReadonlySet<LeaveGuard>,
): Promise<boolean> {
  return (
    retainedNavigation.get(app)?.(action, retained) ?? app.navigate(action)
  );
}
/**
 * Selection/leave policy, the active Pod reader and the Context-discovery policy
 * (`contextSelection`). Authentication and request authority remain in the runtime.
 */
export function createAppController(
  runtime: BrowserRuntime,
  options: AppControllerOptions = {},
) {
  const contextSelection = options.contextSelection ?? 'required';
  const defaultPodUrl =
    runtime.preset?.podUrl ??
    (runtime.allowedPods?.length === 1 ? runtime.allowedPods[0] : undefined);
  const listeners = new Set<() => void>();
  const guards = new Set<LeaveGuard>();
  const unloadPrompt = options.unloadPrompt ?? true;
  let unsubscribe: (() => void) | undefined;
  /** The guards a confirmed change leaves while its action runs. */
  let discarding: ReadonlySet<LeaveGuard> | undefined;
  let prompting = false;
  // The browser's own prompt, whose text cannot be chosen. One function per
  // controller, so another controller's removal leaves this one in place.
  const askBeforeUnload = (event: BeforeUnloadEvent) => {
    event.preventDefault();
    // Older browsers prompt only for a set `returnValue`.
    event.returnValue = '';
  };
  let changing = false;
  let startVersion = 0;
  let startup: StartupReport | undefined;
  let startupError: unknown;
  let callbackNotice = false;
  let activeId: string | null = null;
  /** The active connection at the last publish (snapshots are immutable), to notice a sign-out. */
  let previous: Connection | undefined;
  const tracker = createAccessTracker();
  let view: BoundView | null = null;
  let pod: BoundPod | null = null;
  let pending:
    | {
        action: () => void | Promise<void>;
        change: Change;
        resolve: (accepted: boolean) => void;
        /** The connection that was active when the person was asked. */
        activeId: string | null;
        retained?: ReadonlySet<LeaveGuard>;
        /**
         * Whether the action's target can be selected: `gone` withdraws the
         * prompt; `later` (a catalogue being read) keeps it, but confirming
         * then runs nothing.
         */
        available?: () => Availability;
      }
    | undefined;
  let snapshot: AppSnapshot = {
    contextSelection,
    signIn: runtime.signIn,
    preset: runtime.preset,
    ...(runtime.allowedPods ? { allowedPods: runtime.allowedPods } : {}),
    startup,
    startupError,
    callbackNotice,
    access: tracker.derive({
      signIn: runtime.signIn,
      startup,
      startupError,
      callbackNotice,
      connections: runtime.getSnapshot(),
      activeId,
    }),
    connections: runtime.getSnapshot(),
    activeId,
    view,
    pod,
    confirmingLeave: false,
    unconfirmedLeave: false,
    changing,
  };
  /** The connections to work with without a choice: the preset's Pod's, else all. */
  function candidates(connections: readonly Connection[], except?: string) {
    return connections.filter(
      (c) =>
        c.id !== except &&
        (!runtime.preset || c.podUrl === runtime.preset.podUrl),
    );
  }
  /** One with a session (signed in, restoring or ended), not merely remembered. */
  const inSession = (c: Connection) => c.session.kind !== 'signed-out';
  function publish() {
    const connections = runtime.getSnapshot();
    let connection = connections.find((c) => c.id === activeId);
    // The active connection was just signed out (a remembered Pod stays
    // listed): like a removed one, it gives way to one with a session.
    const signedOut =
      previous !== undefined &&
      previous.id === connection?.id &&
      inSession(previous) &&
      !inSession(connection);
    if (signedOut) {
      const next = candidates(connections, activeId!).find(inSession);
      if (next) {
        connection = next;
        view = null;
      }
    }
    if (!connection) {
      const options = candidates(connections);
      connection = options.find(inSession) ?? options[0];
    }
    activeId = connection?.id ?? null;
    previous = connection;
    // Before the prompt check below: a leave prompt for a prompt's action is
    // withdrawn once that prompt is no longer current.
    const access = tracker.derive({
      signIn: runtime.signIn,
      startup,
      startupError,
      callbackNotice,
      connections,
      activeId,
    });
    // A prompt is about the connection it was asked for. That connection
    // stopping being active without a guarded action (a returning sign-in, a
    // removed or signed-out connection) cancels it: nothing runs and no guard
    // is discarded. A prompt asked without any active connection is not about
    // one.
    if (
      pending &&
      ((pending.activeId !== null &&
        (pending.activeId !== activeId || signedOut)) ||
        pending.available?.() === 'gone')
    ) {
      pending.resolve(false);
      pending = undefined;
    }
    pod = null;
    if (connection && connection.reading !== null)
      pod = runtime.bindPod(connection.id);
    // No Context-bound screen before startup settles, so no draft can start on
    // a connection that a returning sign-in is about to replace (#80).
    const settled = startupSettled({ startup, startupError });
    if (!settled || !connection || !connection.selectedContext) view = null;
    else {
      try {
        view = runtime.bind(connection.id);
      } catch {
        // Same-target recovery must keep its editor mounted; the old view is now ineligible.
        if (
          view?.contextIri !== connection.selectedContext ||
          view?.podUrl !== connection.podUrl
        )
          view = null;
      }
    }
    snapshot = Object.freeze({
      contextSelection,
      signIn: runtime.signIn,
      preset: runtime.preset,
      ...(runtime.allowedPods ? { allowedPods: runtime.allowedPods } : {}),
      startup,
      startupError,
      callbackNotice,
      access,
      connections,
      activeId,
      view,
      pod,
      confirmingLeave: Boolean(pending),
      unconfirmedLeave: Boolean(
        pending &&
        leavingGuards(pending.change, pending.retained).some((g) =>
          g.unconfirmed?.(),
        ),
      ),
      changing,
    });
    followUnload();
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
    // Load each accepted connection independently; failed checks await an explicit retry.
    for (const connection of contextSelection === 'required'
      ? connections
      : []) {
      if (
        (connection.session.kind === 'active' ||
          connection.reading === 'anonymous') &&
        connection.catalogue.kind === 'unknown'
      )
        void runtime.loadContexts(connection.id).catch(() => {});
    }
  }
  /**
   * One `beforeunload` listener while started and a guard holds unsaved work,
   * none otherwise: a registered one can keep the page out of the back/forward
   * cache. A confirmed change's own navigation (a sign-in) does not ask again
   * about the guards it is discarding.
   */
  function followUnload() {
    const ask =
      unloadPrompt &&
      unsubscribe !== undefined &&
      typeof window !== 'undefined' &&
      [...guards].some(
        (g) => !discarding?.has(g) && (g.dirty() || g.blocked()),
      );
    if (ask === prompting) return;
    prompting = ask;
    if (ask) window.addEventListener('beforeunload', askBeforeUnload);
    else window.removeEventListener('beforeunload', askBeforeUnload);
  }
  /** The guards a change leaves: asked about first, discarded once it ran. */
  function leavingGuards(change: Change, retained?: ReadonlySet<LeaveGuard>) {
    return [...guards].filter((g) => !retained?.has(g) && leaves(change, g));
  }
  /** Whether a pending write blocks a change: always, unless it ignores the guard. */
  function blocked(change: Change) {
    return [...guards].some(
      (g) =>
        (change !== 'context' ||
          (g.scope !== 'connection' && g.scope !== 'explicit')) &&
        g.blocked(),
    );
  }
  async function guard(
    action: () => void | Promise<void>,
    change: Change = 'connection',
    retained?: ReadonlySet<LeaveGuard>,
    available?: () => Availability,
  ): Promise<boolean> {
    if (changing || pending || blocked(change)) return false;
    if (!leavingGuards(change, retained).some((g) => g.dirty())) {
      changing = true;
      publish();
      try {
        await action();
        return true;
      } finally {
        changing = false;
        publish();
      }
    }
    return new Promise<boolean>((resolve) => {
      pending = {
        action,
        resolve,
        change,
        activeId,
        ...(retained ? { retained } : {}),
        ...(available ? { available } : {}),
      };
      publish();
    });
  }
  const controller = {
    runtime,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start() {
      const version = ++startVersion;
      unsubscribe ??= runtime.subscribe(publish);
      publish();
      void runtime.initialize().then(
        (report) => {
          if (version !== startVersion) return;
          if (!startup) {
            // The returning sign-in's connection becomes active, also when it
            // failed, so its cause and recovery are shown next to it. A later
            // controller over the same runtime gets the same report: a
            // connection retired since then (signed out with a reason) is
            // not reactivated.
            const returned = runtime
              .getSnapshot()
              .find(
                (c) =>
                  c.id === (report.connectionId ?? report.attemptConnectionId),
              );
            if (
              returned &&
              !(
                returned.session.kind === 'signed-out' &&
                returned.session.problem !== undefined
              )
            )
              activeId = returned.id;
            callbackNotice =
              report.interaction === 'failed' ||
              report.interaction === 'cancelled';
          }
          startup = report;
          publish();
        },
        (error) => {
          if (version !== startVersion) return;
          startupError = error;
          publish();
        },
      );
    },
    /** Provider cleanup does not dispose a caller-owned runtime (including StrictMode probes). */
    stop() {
      startVersion++;
      unsubscribe?.();
      unsubscribe = undefined;
      pending?.resolve(false);
      pending = undefined;
      followUnload();
    },
    register(guard: LeaveGuard) {
      guards.add(guard);
      // Its own callback: guards sharing one subscription source (the lanes
      // of a group) must not unsubscribe each other.
      const stop = guard.subscribe?.(() => followUnload());
      followUnload();
      return () => {
        guards.delete(guard);
        stop?.();
        followUnload();
      };
    },
    /**
     * Local navigation only; remote mutations must use the edit helpers.
     * Guarded like the actions below.
     */
    navigate: (action: () => void | Promise<void>) => guard(action, 'navigate'),
    /** Runs the pending prompt's action, then discards the guards it leaves. */
    async confirmLeave() {
      const intent = pending;
      if (!intent || blocked(intent.change)) return;
      pending = undefined;
      // A target gone meanwhile: nothing runs and no guard is discarded.
      if (intent.available && intent.available() !== 'yes') {
        intent.resolve(false);
        publish();
        return;
      }
      const leaving = leavingGuards(intent.change, intent.retained);
      discarding = new Set(leaving);
      changing = true;
      publish();
      try {
        await intent.action();
        // The navigation happened: every guard is discarded, and one throwing
        // host discard neither stops the others nor reports a failed leave.
        for (const g of leaving) {
          try {
            g.discard();
          } catch (error) {
            queueMicrotask(() => {
              throw error;
            });
          }
        }
        intent.resolve(true);
      } catch (error) {
        intent.resolve(false);
        throw error;
      } finally {
        discarding = undefined;
        changing = false;
        publish();
      }
    },
    /** Declines the pending prompt; its action resolves `false`. */
    cancelLeave() {
      pending?.resolve(false);
      pending = undefined;
      publish();
    },
    /**
     * Guarded actions: each asks first while a guard is dirty and resolves
     * `false`, discarding nothing, when a guard is blocked, the person declines,
     * or the prompt is cancelled (see `AppSnapshot.confirmingLeave`).
     */
    selectConnection(id: string) {
      if (id === activeId) return Promise.resolve(true);
      return guard(() => {
        if (!runtime.getSnapshot().some((c) => c.id === id))
          throw new RuntimeError('disconnected');
        activeId = id;
        view = null;
        callbackNotice = false;
        publish();
      });
    },
    /** Guarded like `selectConnection`. */
    selectContext(iri: string) {
      const id = activeId;
      if (!id) return Promise.resolve(false);
      if (
        snapshot.connections.find((c) => c.id === id)?.selectedContext === iri
      )
        return Promise.resolve(true);
      return guard(() => {
        runtime.selectContext(id, iri);
      }, 'context');
    },
    /**
     * One guarded switch to a readable Context of any signed-in connection,
     * with at most one leave prompt. A change of Pod leaves guards as
     * `selectConnection` does, the same Pod as `selectContext`. The Context
     * is selected on the target connection before it becomes active, so no
     * snapshot shows that Pod with its previous Context. A target that
     * disappears while the person is asked (its connection, its sign-in or
     * its listing) withdraws the prompt; a catalogue reload does not, but
     * confirming before it is read again selects nothing (`unavailable`).
     */
    async selectTarget(target: ContextTarget): Promise<TargetSelection> {
      const problem = () =>
        targetProblem(runtime.getSnapshot(), runtime.preset, target);
      const before = problem();
      if (before) return { kind: 'unavailable', reason: before };
      const { connectionId: id, contextIri: iri } = target;
      const same = id === activeId;
      if (
        same &&
        runtime.getSnapshot().find((c) => c.id === id)?.selectedContext === iri
      )
        return { kind: 'selected' };
      const change: Change = same ? 'context' : 'connection';
      if (changing || pending || blocked(change)) return { kind: 'blocked' };
      let accepted: boolean;
      try {
        accepted = await guard(
          () => {
            const gone = problem();
            if (gone) throw new RuntimeError('configuration');
            runtime.selectContext(id, iri);
            if (id !== activeId) {
              activeId = id;
              view = null;
              callbackNotice = false;
              publish();
            }
          },
          change,
          undefined,
          () => {
            const now = problem();
            return now === null
              ? 'yes'
              : now === 'catalogue'
                ? 'later'
                : 'gone';
          },
        );
      } catch (error) {
        // The target went away between the check and the switch.
        const gone = problem();
        if (error instanceof RuntimeError && gone)
          return { kind: 'unavailable', reason: gone };
        throw error;
      }
      if (accepted) return { kind: 'selected' };
      const after = problem();
      return after
        ? { kind: 'unavailable', reason: after }
        : { kind: 'declined' };
    },
    /**
     * Adds a Pod (or reuses the default Pod's connection) and makes it
     * active. Under `signIn: 'required'` it then starts signing in; under
     * `'optional'` and `'none'` the connection reads without a token, and
     * `authorize(id)` signs in. Guarded like `selectConnection`.
     */
    connect(url = defaultPodUrl) {
      return guard(connecting(url));
    },
    /** Guarded like `selectConnection`. */
    authorize(id: string) {
      return guard(authorizing(id));
    },
    /**
     * Guarded like `selectConnection`. `true` means the action ran, not that
     * sign-out was saved. On failure the connection's ended session retains
     * `saved: false`; offer a retry. A signed-out active connection gives way
     * to another one with a session, as a removed one does.
     */
    disconnect(id: string) {
      return guard(disconnecting(id));
    },
    /** Signs out if needed and forgets the Pod; guarded and reported like `disconnect`. */
    forget(id: string) {
      return guard(forgetting(id));
    },
    /**
     * Retires a prompt of `access.prompts` that offers `dismiss`, for this
     * controller's lifetime; nothing is persisted. Dismissing a sign-in
     * callback's prompt also clears `callbackNotice`. Returns `false` and does
     * nothing for any other prompt.
     */
    dismiss(promptId: string) {
      const prompt = tracker.dismiss(promptId);
      if (!prompt) return false;
      if (callbackReasons.has(prompt.reason)) callbackNotice = false;
      publish();
      return true;
    },
  };
  function connecting(url: string | undefined) {
    return async () => {
      callbackNotice = false;
      const connection =
        (url === defaultPodUrl
          ? runtime
              .getSnapshot()
              .find((c) => c.id === activeId && c.podUrl === url)
          : undefined) ?? (await runtime.connect(url));
      if (connection.session.kind === 'restoring')
        throw new RuntimeError('configuration');
      if (runtime.signIn === 'required')
        await runtime.beginAuthorization(connection.id);
      activeId = connection.id;
      publish();
    };
  }
  function authorizing(id: string) {
    return () => {
      callbackNotice = false;
      return runtime.beginAuthorization(id);
    };
  }
  function disconnecting(id: string) {
    return async () => {
      if ((await runtime.disconnect(id)).kind === 'disconnected')
        callbackNotice = false;
    };
  }
  function forgetting(id: string) {
    return async () => {
      if ((await runtime.forget(id)).kind === 'disconnected')
        callbackNotice = false;
    };
  }
  /**
   * Runs one offered prompt action. The prompt must still be current with
   * that action, before it runs and, through the guard's availability check,
   * again after a leave confirmation: a stale one runs and discards nothing.
   */
  async function runAccess(
    prompt: AccessPrompt,
    action: AccessPrompt['actions'][number],
  ): Promise<boolean> {
    const available = (): Availability =>
      tracker.current(prompt, action) ? 'yes' : 'gone';
    if (available() !== 'yes') return false;
    const id = prompt.connectionId;
    const guarded = (run: () => void | Promise<void>) =>
      guard(run, 'connection', undefined, available);
    switch (action) {
      case 'dismiss':
        return controller.dismiss(prompt.id);
      case 'reload':
        if (typeof location === 'undefined') return false;
        location.reload();
        return true;
      case 'retry':
        if (!id) return false;
        if (prompt.reason !== 'unreachable') return guarded(disconnecting(id));
        await runtime.retryRestore(id);
        return true;
      case 'forget':
        return id ? guarded(forgetting(id)) : false;
      case 'sign-in':
        if (id) return guarded(authorizing(id));
        // Without a fixed address the app asks for one (`connect(url)`).
        return defaultPodUrl === undefined
          ? false
          : guarded(connecting(defaultPodUrl));
    }
  }
  retainedNavigation.set(controller, (action, retained) =>
    guard(action, 'navigate', retained),
  );
  accessActions.set(controller, runAccess);
  return controller;
}
const callbackReasons = new Set<AccessPrompt['reason']>([
  'sign-in-failed',
  'sign-in-cancelled',
  'sharing-unchanged',
]);
type AccessAction = (
  prompt: AccessPrompt,
  action: AccessPrompt['actions'][number],
) => Promise<boolean>;
const accessActions = new WeakMap<object, AccessAction>();
/**
 * Internal, for the SDK components: runs an offered action of a prompt
 * through the controller's guarded actions; `false` when it is stale, the
 * person declined or a guard blocked it. No public executor.
 */
export function runAccessAction(
  app: AppController,
  prompt: AccessPrompt,
  action: AccessPrompt['actions'][number],
): Promise<boolean> {
  return accessActions.get(app)?.(prompt, action) ?? Promise.resolve(false);
}
export type AppController = ReturnType<typeof createAppController>;
