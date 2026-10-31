import type {
  BrowserRuntime,
  Connection,
  StartupReport,
  PodPreset,
} from '../runtime/types.js';
import { RuntimeError } from '../runtime/errors.js';
import type { BoundPod, BoundView } from '../runtime/view.js';

export interface LeaveGuard {
  /**
   * Which guarded changes leave this guard, so ask about and discard it:
   * - `local` (also when omitted): every change: `navigate`, `selectContext`
   *   and the connection actions (`selectConnection`, `connect`, `authorize`,
   *   `disconnect`).
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
 *   `session` is not signed in with the required access, its `catalogue` is
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
  if (
    (connection.session.kind !== 'active' &&
      connection.session.kind !== 'renewing') ||
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
  readonly preset: PodPreset | undefined;
  /** Immutable runtime policy; undefined means unrestricted. */
  readonly allowedPods?: readonly string[];
  readonly startup: StartupReport | undefined;
  readonly startupError: unknown;
  /**
   * Whether the startup's failed or cancelled callback still needs presenting.
   * Cleared once the person selects another connection, disconnects one or
   * starts a sign-in; `startup` itself stays unchanged.
   */
  readonly callbackNotice: boolean;
  readonly connections: readonly Connection[];
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
    preset: runtime.preset,
    ...(runtime.allowedPods ? { allowedPods: runtime.allowedPods } : {}),
    startup,
    startupError,
    callbackNotice,
    connections: runtime.getSnapshot(),
    activeId,
    view,
    pod,
    confirmingLeave: false,
    unconfirmedLeave: false,
    changing,
  };
  function publish() {
    const connections = runtime.getSnapshot();
    if (!activeId || !connections.some((c) => c.id === activeId))
      activeId =
        (runtime.preset
          ? connections.find((c) => c.podUrl === runtime.preset!.podUrl)
          : connections[0]
        )?.id ?? null;
    // A prompt is about the connection it was asked for. That connection
    // stopping being active without a guarded action (a returning sign-in, a
    // removed connection) cancels it: nothing runs and no guard is discarded.
    // A prompt asked without any active connection is not about one.
    if (
      pending &&
      ((pending.activeId !== null && pending.activeId !== activeId) ||
        pending.available?.() === 'gone')
    ) {
      pending.resolve(false);
      pending = undefined;
    }
    const connection = connections.find((c) => c.id === activeId);
    pod = null;
    if (
      connection &&
      (connection.session.kind === 'active' ||
        connection.session.kind === 'renewing')
    )
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
      preset: runtime.preset,
      ...(runtime.allowedPods ? { allowedPods: runtime.allowedPods } : {}),
      startup,
      startupError,
      callbackNotice,
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
        connection.session.kind === 'active' &&
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
            // failed, so its cause and recovery are shown next to it.
            const returned = report.connectionId ?? report.attemptConnectionId;
            if (returned) activeId = returned;
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
    /** Guarded like `selectConnection`. */
    connect(url = defaultPodUrl) {
      return guard(async () => {
        callbackNotice = false;
        const connection =
          (url === defaultPodUrl
            ? runtime
                .getSnapshot()
                .find((c) => c.id === activeId && c.podUrl === url)
            : undefined) ?? (await runtime.connect(url));
        if (connection.session.kind === 'restoring')
          throw new RuntimeError('configuration');
        await runtime.beginAuthorization(connection.id);
        activeId = connection.id;
        publish();
      });
    },
    /** Guarded like `selectConnection`. */
    authorize(id: string) {
      return guard(() => {
        callbackNotice = false;
        return runtime.beginAuthorization(id);
      });
    },
    /**
     * Guarded like `selectConnection`. `true` means the action ran, not that
     * sign-out was saved. On failure the connection's ended session retains
     * `saved: false`; a successful retry removes the connection.
     */
    disconnect(id: string) {
      return guard(async () => {
        if ((await runtime.disconnect(id)).kind === 'disconnected')
          callbackNotice = false;
      });
    },
  };
  retainedNavigation.set(controller, (action, retained) =>
    guard(action, 'navigate', retained),
  );
  return controller;
}
export type AppController = ReturnType<typeof createAppController>;
