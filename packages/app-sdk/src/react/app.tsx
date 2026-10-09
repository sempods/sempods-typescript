import {
  createContext,
  Fragment,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  useState,
  useRef,
  useCallback,
  type ReactNode,
} from 'react';
import {
  createAppController,
  type AppController,
  type AppSnapshot,
  type BrowserRuntime,
  type LocaleOptions,
} from '../index.js';
import { SdkLocaleProvider, useSdkLocale } from './locale.js';
const Context = createContext<{
  readonly controller: AppController;
  readonly actions: AppActions;
  readonly contextDemand: boolean;
  readonly retainContext: () => () => void;
} | null>(null);
/**
 * Guarded user actions for custom screens and replacement controls. Each
 * guarded action (all except `refreshContexts`) resolves `false`, discarding
 * nothing, if the connection that was active when the person was asked stops
 * being active outside a guarded action.
 */
export interface AppActions {
  /** Switch the active Pod connection; asks before leaving drafts or unconfirmed writes. */
  selectConnection(id: string): Promise<boolean>;
  /** Select one readable context of the active connection; guarded the same way. */
  selectContext(iri: string): Promise<boolean>;
  /** Sign in to a Pod; omit the URL to reuse/connect the preset or sole allowed Pod. */
  connect(url?: string): Promise<boolean>;
  /** Sign in again for an existing connection. */
  authorize(id: string): Promise<boolean>;
  /** Forget a connection locally; does not revoke grants or delete Pod data. */
  disconnect(id: string): Promise<boolean>;
  /** Reload a connection's context catalogue (access facts). */
  refreshContexts(id: string): Promise<unknown>;
  /** Run local row/page navigation under the same leave policy. */
  navigate(action: () => void | Promise<void>): Promise<boolean>;
}
/** Internal: the full controller for SDK hooks and components. */
export function useController(): AppController {
  const value = useContext(Context);
  if (!value) throw new Error('SempodsProvider is required.');
  return value.controller;
}
/** Guarded actions only; read state through `useAppState`, `useConnections` and `useView`. */
export function useApp(): AppActions {
  const value = useContext(Context);
  if (!value) throw new Error('SempodsProvider is required.');
  return value.actions;
}
export function useAppState() {
  const app = useController();
  return useSyncExternalStore(app.subscribe, app.getSnapshot, app.getSnapshot);
}
/** Equal facts of one selector: the same fields, `Object.is`-equal. */
export function shallowEqual<T extends object>(a: T, b: T) {
  return (Object.keys(a) as (keyof T)[]).every((k) => Object.is(a[k], b[k]));
}
/**
 * Internal: the facts `select` derives from the app snapshot. The component
 * re-renders only when they change by `equal`, not on every publish.
 */
export function useAppFacts<T>(
  select: (snapshot: AppSnapshot) => T,
  equal: (a: T, b: T) => boolean = Object.is,
): T {
  const app = useController();
  const last = useRef<{ readonly value: T } | null>(null);
  const read = () => {
    const next = select(app.getSnapshot());
    // Equal facts keep their identity, so useSyncExternalStore skips the render.
    if (last.current && equal(last.current.value, next))
      return last.current.value;
    last.current = { value: next };
    return next;
  };
  return useSyncExternalStore(app.subscribe, read, read);
}
/** Pass one runtime created outside render. The provider consumes its single initializer. */
export function SempodsProvider({
  runtime,
  children,
  contextSelection = 'required',
  ...locale
}: LocaleOptions & {
  readonly runtime: BrowserRuntime;
  readonly children: ReactNode;
  /**
   * Required preserves automatic catalogues and Context-based access UI.
   * On-demand leaves Pod startup/reads catalogue-free; mounted TargetScreens
   * and explicitly opened AppAccess management demand active Context discovery.
   * Preset/remembered Contexts still require fresh readable catalogue evidence.
   * Keep fixed for the provider's lifetime: changing it replaces the controller
   * and cancels a pending leave confirmation; it is not a guarded mode switch.
   */
  readonly contextSelection?: 'required' | 'on-demand';
}) {
  const owner = useMemo(() => {
    const controller = createAppController(runtime, { contextSelection });
    const actions: AppActions = Object.freeze({
      selectConnection: (id: string) => controller.selectConnection(id),
      selectContext: (iri: string) => controller.selectContext(iri),
      connect: (url?: string) => controller.connect(url),
      authorize: (id: string) => controller.authorize(id),
      disconnect: (id: string) => controller.disconnect(id),
      refreshContexts: (id: string) => runtime.loadContexts(id),
      navigate: (action: () => void | Promise<void>) =>
        controller.navigate(action),
    });
    return { controller, actions };
  }, [runtime, contextSelection]);
  const [demands, setDemands] = useState(0);
  const retainContext = useCallback(() => {
    setDemands((count) => count + 1);
    let current = true;
    return () => {
      if (!current) return;
      current = false;
      setDemands((count) => count - 1);
    };
  }, []);
  // Only whether any demand exists reaches consumers: another retain or
  // release does not re-render every SDK hook.
  const contextDemand = demands > 0;
  const value = useMemo(
    () => ({ ...owner, contextDemand, retainContext }),
    [owner, contextDemand, retainContext],
  );
  const app = owner.controller;
  useEffect(() => {
    app.start();
    return () => app.stop();
  }, [app]);
  return (
    <SdkLocaleProvider {...locale}>
      <Context.Provider value={value}>
        <GuardedContent>{children}</GuardedContent>
        <LeaveConfirmation />
      </Context.Provider>
    </SdkLocaleProvider>
  );
}
function GuardedContent({ children }: { readonly children: ReactNode }) {
  const { changing, confirmingLeave } = useAppState();
  return (
    <div inert={changing || confirmingLeave} style={{ display: 'contents' }}>
      {children}
    </div>
  );
}
export function useConnections() {
  return useAppState().connections;
}
const selectView = (s: AppSnapshot) => s.view;
/** The selected Context's view; re-renders only when the view changes. */
export function useView() {
  return useAppFacts(selectView);
}
const none = Object.freeze({
  current: false,
  read: false,
  write: false,
  catalogue: 'unknown' as const,
  revision: 0,
});
const noSubscription = () => () => {};
/** Internal Context demand, independent of whether a BoundView already exists. */
export function useContextDemand(active: boolean) {
  const value = useContext(Context);
  if (!value) throw new Error('SempodsProvider is required.');
  // Only the facts used here: a token renewal or another connection's
  // catalogue does not re-render the host.
  const { mode, id, undiscovered } = useAppFacts((s) => {
    const connection = s.connections.find((c) => c.id === s.activeId);
    return {
      mode: s.contextSelection,
      id: s.activeId,
      // Signed in (also while renewing) with no catalogue requested yet.
      undiscovered:
        (connection?.session.kind === 'active' ||
          connection?.session.kind === 'renewing') &&
        connection.catalogue.kind === 'unknown',
    };
  }, shallowEqual);
  const { retainContext } = value;
  useEffect(
    () => (active ? retainContext() : undefined),
    [active, retainContext],
  );
  useEffect(() => {
    if (active && mode === 'on-demand' && id && undiscovered)
      void value.actions.refreshContexts(id).catch(() => {});
  }, [active, mode, id, undiscovered, value.actions]);
  return mode === 'required' || active || value.contextDemand;
}
/** Context-view access for the active connection, in both modes; Pod readers have their own snapshot. */
export function useWorkflowAccess() {
  const { view, connections, activeId } = useAppState();
  const access = useSyncExternalStore(
    view?.subscribe ?? noSubscription,
    view?.getSnapshot ?? (() => none),
    view?.getSnapshot ?? (() => none),
  );
  const connection = connections.find((c) => c.id === activeId);
  return {
    ...access,
    connection,
    features:
      connection?.requestedScopes.map((scope) => ({
        scope,
        grant:
          connection.session.kind === 'active' ||
          connection.session.kind === 'renewing'
            ? connection.grantedScopes.includes(scope)
              ? ('granted' as const)
              : ('missing' as const)
            : ('unknown' as const),
        required: connection.requiredScopes.includes(scope),
      })) ?? [],
  };
}
function LeaveConfirmation() {
  const app = useController();
  const { confirmingLeave, unconfirmedLeave } = useAppState();
  const m = useSdkLocale().messages.controls;
  const stay = useRef<HTMLButtonElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (confirmingLeave) {
      setFailed(false);
      const previous = document.activeElement as HTMLElement | null;
      stay.current?.focus();
      return () => previous?.focus();
    }
  }, [confirmingLeave]);
  if (!confirmingLeave) return failed ? <p role="alert">{m.failure}</p> : null;
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="sempods-leave-title"
      style={{
        position: 'fixed',
        inset: 0,
        background: '#0009',
        display: 'grid',
        placeItems: 'center',
        zIndex: 1000,
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') app.cancelLeave();
        if (e.key === 'Tab') {
          e.preventDefault();
          const buttons = e.currentTarget.querySelectorAll('button');
          const target = e.target === buttons[0] ? buttons[1] : buttons[0];
          target?.focus();
        }
      }}
    >
      <section
        style={{
          background: 'white',
          color: '#172b32',
          padding: 24,
          maxWidth: 420,
          margin: 16,
          borderRadius: 12,
        }}
      >
        <h2 id="sempods-leave-title">{m.leaveTitle}</h2>
        <p>{unconfirmedLeave ? m.leaveUnconfirmed : m.leaveBody}</p>
        {failed && <p role="alert">{m.failure}</p>}
        <button ref={stay} onClick={() => app.cancelLeave()}>
          {m.stay}
        </button>{' '}
        <button
          onClick={() => {
            void app.confirmLeave().catch(() => setFailed(true));
          }}
        >
          {m.leave}
        </button>
      </section>
    </div>
  );
}

/**
 * Demand discovery before a view exists, then retain the screen through
 * same-target recovery. Renders nothing until the controller exposes a view,
 * which it does only once startup settles.
 */
export function TargetScreen({ children }: { readonly children: ReactNode }) {
  useContextDemand(true);
  const view = useView();
  return view ? <Fragment key={view.key}>{children}</Fragment> : null;
}

/** Row selection cooperates with the editor's leave guard and resets on target changes. */
export function useSelection<T = string>() {
  const app = useController();
  const view = useView();
  const [state, setState] = useState({ view, selected: null as T | null });
  if (state.view !== view) setState({ view, selected: null });
  return {
    selected: state.view === view ? state.selected : null,
    select: (selected: T | null) => {
      if (!view || app.getSnapshot().view !== view)
        return Promise.resolve(false);
      if (state.view === view && Object.is(state.selected, selected))
        return Promise.resolve(true);
      return app.navigate(() => {
        if (app.getSnapshot().view === view) setState({ view, selected });
      });
    },
  };
}
