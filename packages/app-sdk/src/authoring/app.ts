import type {
  BrowserRuntime,
  Connection,
  StartupReport,
  PodPreset,
} from '../runtime/types.js';
import { RuntimeError } from '../runtime/errors.js';
import type { BoundPod, BoundView } from '../runtime/view.js';

export interface LeaveGuard {
  /** Target guards survive local row navigation; local guards are left by both. */
  readonly scope?: 'local' | 'target';
  unconfirmed?(): boolean;
  blocked(): boolean;
  dirty(): boolean;
  discard(): void;
}
export interface AppSnapshot {
  readonly preset: PodPreset | undefined;
  /** Immutable runtime policy; undefined means unrestricted. */
  readonly allowedPods?: readonly string[];
  readonly startup: StartupReport | undefined;
  readonly startupError: unknown;
  readonly connections: readonly Connection[];
  readonly activeId: string | null;
  readonly view: BoundView | null;
  /** Reader for the active signed-in Pod; independent of selected Context and catalogue. */
  readonly pod: BoundPod | null;
  readonly confirmingLeave: boolean;
  readonly unconfirmedLeave: boolean;
  /** Hosts must prevent new user input while a guarded action is preparing. */
  readonly changing: boolean;
}
/** Selection/leave policy only. Authentication and request authority remain in the runtime. */
export function createAppController(runtime: BrowserRuntime) {
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
  let activeId: string | null = null;
  let view: BoundView | null = null;
  let pod: BoundPod | null = null;
  let pending:
    | {
        action: () => void | Promise<void>;
        scope: 'local' | 'target';
        resolve: (accepted: boolean) => void;
      }
    | undefined;
  let snapshot: AppSnapshot = {
    preset: runtime.preset,
    ...(runtime.allowedPods ? { allowedPods: runtime.allowedPods } : {}),
    startup,
    startupError,
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
    const connection = connections.find((c) => c.id === activeId);
    pod = null;
    if (
      connection &&
      (connection.session.kind === 'active' ||
        connection.session.kind === 'renewing')
    )
      pod = runtime.bindPod(connection.id);
    if (!connection || !connection.selectedContext) view = null;
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
      preset: runtime.preset,
      ...(runtime.allowedPods ? { allowedPods: runtime.allowedPods } : {}),
      startup,
      startupError,
      connections,
      activeId,
      view,
      pod,
      confirmingLeave: Boolean(pending),
      unconfirmedLeave: Boolean(
        pending && leavingGuards(pending.scope).some((g) => g.unconfirmed?.()),
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
    for (const connection of connections) {
      if (
        connection.session.kind === 'active' &&
        connection.catalogue.kind === 'unknown'
      )
        void runtime.loadContexts(connection.id).catch(() => {});
    }
  }
  function leavingGuards(scope: 'local' | 'target') {
    return [...guards].filter(
      (g) => scope === 'target' || g.scope !== 'target',
    );
  }
  async function guard(
    action: () => void | Promise<void>,
    scope: 'local' | 'target' = 'target',
  ): Promise<boolean> {
    if (changing || pending || [...guards].some((g) => g.blocked()))
      return false;
    if (!leavingGuards(scope).some((g) => g.dirty())) {
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
      pending = { action, resolve, scope };
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
          if (
            !startup &&
            report.interaction === 'completed' &&
            report.connectionId
          )
            activeId = report.connectionId;
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
    /** Local navigation only; remote mutations must use the edit helpers. */
    navigate: (action: () => void | Promise<void>) => guard(action, 'local'),
    async confirmLeave() {
      const intent = pending;
      if (!intent || [...guards].some((g) => g.blocked())) return;
      pending = undefined;
      const leaving = leavingGuards(intent.scope);
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
    cancelLeave() {
      pending?.resolve(false);
      pending = undefined;
      publish();
    },
    selectConnection(id: string) {
      if (id === activeId) return Promise.resolve(true);
      return guard(() => {
        if (!runtime.getSnapshot().some((c) => c.id === id))
          throw new RuntimeError('disconnected');
        activeId = id;
        view = null;
        publish();
      });
    },
    selectContext(iri: string) {
      const id = activeId;
      if (!id) return Promise.resolve(false);
      if (
        snapshot.connections.find((c) => c.id === id)?.selectedContext === iri
      )
        return Promise.resolve(true);
      return guard(() => {
        runtime.selectContext(id, iri);
      });
    },
    connect(url = defaultPodUrl) {
      return guard(async () => {
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
    authorize(id: string) {
      return guard(() => runtime.beginAuthorization(id));
    },
    disconnect(id: string) {
      return guard(async () => {
        await runtime.disconnect(id);
      });
    },
  };
}
export type AppController = ReturnType<typeof createAppController>;
