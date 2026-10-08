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
   *
   * A pending write (`blocked()`) blocks every change, except that a
   * `connection` guard does not block `selectContext`, which leaves it alone.
   */
  readonly scope?: 'local' | 'target' | 'connection';
  unconfirmed?(): boolean;
  blocked(): boolean;
  dirty(): boolean;
  discard(): void;
}
/** A guarded change: row navigation, a Context selection, or a connection action. */
type Change = 'navigate' | 'context' | 'connection';
/** Whether a guarded change leaves a guard (see `LeaveGuard.scope`). */
function leaves(change: Change, guard: LeaveGuard) {
  if (change === 'navigate') return guard.scope !== 'target';
  if (change === 'context') return guard.scope !== 'connection';
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
  let unsubscribe: (() => void) | undefined;
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
    if (pending && pending.activeId !== null && pending.activeId !== activeId) {
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
    const settled = startup !== undefined || startupError !== undefined;
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
        pending && leavingGuards(pending.change).some((g) => g.unconfirmed?.()),
      ),
      changing,
    });
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
  /** The guards a change leaves: asked about first, discarded once it ran. */
  function leavingGuards(change: Change) {
    return [...guards].filter((g) => leaves(change, g));
  }
  /** Whether a pending write blocks a change: always, unless it ignores the guard. */
  function blocked(change: Change) {
    return [...guards].some(
      (g) => (change !== 'context' || g.scope !== 'connection') && g.blocked(),
    );
  }
  async function guard(
    action: () => void | Promise<void>,
    change: Change = 'connection',
  ): Promise<boolean> {
    if (changing || pending || blocked(change)) return false;
    if (!leavingGuards(change).some((g) => g.dirty())) {
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
      pending = { action, resolve, change, activeId };
      publish();
    });
  }
  return {
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
    },
    register(guard: LeaveGuard) {
      guards.add(guard);
      return () => {
        guards.delete(guard);
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
      const leaving = leavingGuards(intent.change);
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
    /** Guarded like `selectConnection`. */
    disconnect(id: string) {
      return guard(async () => {
        if ((await runtime.disconnect(id)).kind === 'disconnected')
          callbackNotice = false;
      });
    },
  };
}
export type AppController = ReturnType<typeof createAppController>;
