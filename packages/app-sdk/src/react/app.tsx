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
  type ContextTarget,
  type LocaleOptions,
  type TargetSelection,
} from '../index.js';
import { targetProblem } from '../authoring/app.js';
import type { CatalogueContext } from '@sempods/client-sdk';
import type { CatalogueFact } from '../runtime/types.js';
import { SdkLocaleProvider, useSdkLocale } from './locale.js';
import { ConfirmDialog } from './confirm.js';
import { useCommands } from './commands.js';
import { knownContexts } from './access-presentation.js';
import { contextName, distinctName, podName } from './names.js';
import { editorsOf } from '../authoring/editors.js';
const Context = createContext<{
  readonly controller: AppController;
  readonly actions: AppActions;
  readonly retainContext: () => () => void;
  /** Catalogue discovery for an explicit target; asks for no selection. */
  readonly retainDiscovery: () => () => void;
  /** An app-owned Context switch (`useContexts`) selects instead of AppAccess. */
  readonly retainSwitch: () => () => void;
} | null>(null);
/**
 * Whether any Context demand exists, apart from the stable owner above: a
 * demand change re-renders only the hooks that read it, not every editor host.
 */
const Demand = createContext({
  selection: false,
  discovery: false,
  switching: false,
});
/**
 * Guarded user actions for custom screens and replacement controls. Each
 * guarded action (all except `refreshContexts`, `loadContextLabels` and `retryRestore`) resolves `false`, discarding
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
  /**
   * Forget a connection locally; does not revoke grants or delete Pod data.
   * `true` means the guarded action ran. If durable sign-out failed, the
   * connection retains an ended session with `saved: false`; offer a retry.
   */
  disconnect(id: string): Promise<boolean>;
  /** Reload a connection's context catalogue (access facts). */
  refreshContexts(id: string): Promise<unknown>;
  /**
   * Read the labels of at most 20 explicitly named readable Contexts into
   * `catalogue.labels`, for example for a list menu; see
   * `BrowserRuntime.loadContextLabels`. Display text only; not guarded.
   */
  loadContextLabels(id: string, iris: readonly string[]): Promise<void>;
  /**
   * Restore a saved session again after its Pod was unreachable
   * (`session.restorable`); see `BrowserRuntime.retryRestore`. Not guarded.
   */
  retryRestore(id: string): Promise<void>;
  /** Run local row/page navigation under the same leave policy. */
  navigate(action: () => void | Promise<void>): Promise<boolean>;
  /**
   * Select a readable Context of any signed-in connection in one guarded
   * step, with at most one leave prompt; see `TargetSelection`.
   */
  selectTarget(target: ContextTarget): Promise<TargetSelection>;
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
/**
 * Internal: whether no guarded change or its prompt holds writes back, as a
 * subscribed value: lanes read it from the snapshot while rendering, so a
 * hook using them renders again once a change ends.
 */
export function useWriteGate() {
  return useAppFacts((s) => !s.changing && !s.confirmingLeave);
}
/** Internal: the active connection, while signed in, and its catalogue. */
export function activeCatalogue(s: AppSnapshot) {
  const connection = s.connections.find((c) => c.id === s.activeId);
  const active =
    connection?.session.kind === 'active' ||
    connection?.session.kind === 'renewing';
  return {
    activeId: active ? connection.id : null,
    catalogue: active ? connection.catalogue : undefined,
  };
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
      loadContextLabels: (id: string, iris: readonly string[]) =>
        runtime.loadContextLabels(id, iris),
      retryRestore: (id: string) => runtime.retryRestore(id),
      navigate: (action: () => void | Promise<void>) =>
        controller.navigate(action),
      selectTarget: (target: ContextTarget) => controller.selectTarget(target),
    });
    return { controller, actions };
  }, [runtime, contextSelection]);
  const [demands, setDemands] = useState(0);
  const retainContext = useRetain(setDemands);
  const [discoveries, setDiscoveries] = useState(0);
  const retainDiscovery = useRetain(setDiscoveries);
  const [switches, setSwitches] = useState(0);
  const retainSwitch = useRetain(setSwitches);
  // Only whether any demand exists reaches consumers: another retain or
  // release does not re-render every SDK hook.
  const selection = demands > 0;
  const discovery = discoveries > 0;
  const switching = switches > 0;
  const value = useMemo(
    () => ({ ...owner, retainContext, retainDiscovery, retainSwitch }),
    [owner, retainContext, retainDiscovery, retainSwitch],
  );
  const demand = useMemo(
    () => ({ selection, discovery, switching }),
    [selection, discovery, switching],
  );
  const app = owner.controller;
  useEffect(() => {
    app.start();
    return () => app.stop();
  }, [app]);
  return (
    <SdkLocaleProvider {...locale}>
      <Context.Provider value={value}>
        <Demand.Provider value={demand}>
          <GuardedContent>{children}</GuardedContent>
          <LeaveConfirmation />
        </Demand.Provider>
      </Context.Provider>
    </SdkLocaleProvider>
  );
}
function GuardedContent({ children }: { readonly children: ReactNode }) {
  const { changing, confirmingLeave, leaving } = useAppFacts(
    (s) => ({
      changing: s.changing,
      confirmingLeave: s.confirmingLeave,
      // The page is navigating to a sign-in: the content stays as it was, but
      // its earlier session no longer dispatches.
      leaving:
        s.connections.find((c) => c.id === s.activeId)?.session.kind ===
        'leaving',
    }),
    shallowEqual,
  );
  return (
    <div
      inert={changing || confirmingLeave || leaving}
      style={{ display: 'contents' }}
    >
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
/** A counted demand: retaining returns its own idempotent release. */
function useRetain(set: (change: (count: number) => number) => void) {
  return useCallback(() => {
    set((count) => count + 1);
    let current = true;
    return () => {
      if (!current) return;
      current = false;
      set((count) => count - 1);
    };
  }, [set]);
}
/**
 * Internal Context demand, independent of whether a BoundView already exists.
 * TargetScreen asks AppAccess for a selected Context; open management only
 * for discovery (`useContextDiscovery`).
 */
export function useContextDemand(active: boolean) {
  const value = useDemand(active, 'selection');
  const demand = useContext(Demand);
  return value.mode === 'required' || active || demand.selection;
}
/**
 * Internal catalogue discovery for an explicit target (`useContextEditor`):
 * it asks for no selected Context, so AppAccess offers no chooser for it, yet
 * still shows a failed catalogue with its retry.
 */
export function useContextDiscovery(active: boolean) {
  useDemand(active, 'discovery');
}
/** Internal: whether an explicit target currently demands catalogue discovery. */
export function useDiscoveryDemand() {
  return useContext(Demand).discovery;
}
/** Internal: whether the app renders its own Context switch (`useContexts`). */
export function useSwitchDemand() {
  return useContext(Demand).switching;
}

/** A readable Context as an app's switch shows it. */
export interface ContextChoice {
  readonly iri: string;
  /** Its label, else a readable last path segment; duplicates add the IRI. */
  readonly name: string;
  /** Whether this app may change data there, not only read it. */
  readonly writable: boolean;
}
/**
 * The readable Contexts of the active connection for an app-owned switch, such
 * as a list switch in the header. It loads the catalogue in both modes, reads
 * the labels of up to 20 Contexts once, and keeps known Contexts during a
 * reload. Without a remembered or preset Context it selects one itself, the
 * first writable, else the first readable, so `AppAccess` offers no chooser of
 * its own; management then names only the selected Context. `select` runs
 * under the leave policy and resolves `false` when refused or not selectable.
 */
export function useContexts() {
  const value = useContext(Context);
  if (!value) throw new Error('SempodsProvider is required.');
  useDemand(true, 'discovery');
  const { retainSwitch, actions } = value;
  useEffect(() => retainSwitch(), [retainSwitch]);
  const { connection, preset } = useAppFacts(
    (s) => ({
      connection: s.connections.find((c) => c.id === s.activeId),
      preset: s.preset,
    }),
    shallowEqual,
  );
  const active =
    connection?.session.kind === 'active' ||
    connection?.session.kind === 'renewing';
  const catalogue = active ? connection.catalogue : undefined;
  // An exact preset keeps the app in its one Context.
  const fixed =
    preset?.podUrl === connection?.podUrl ? preset?.contextIri : undefined;
  const contexts = useMemo(
    () => contextChoices(knownContexts(catalogue), catalogue, fixed),
    [catalogue, fixed],
  );
  const id = active ? connection.id : null;
  const selectedIri = active ? connection.selectedContext : null;
  // Labels for the names, once per set of Contexts (display text only).
  const labelled =
    catalogue?.kind === 'ready'
      ? contexts
          .slice(0, 20)
          .map((entry) => entry.iri)
          .join(' ')
      : '';
  useEffect(() => {
    if (id && labelled)
      void actions.loadContextLabels(id, labelled.split(' ')).catch(() => {});
  }, [actions, id, labelled]);
  // The runtime already chose a remembered or preset Context when it could.
  const fallback =
    catalogue?.kind === 'ready' && !selectedIri
      ? (contexts.find((entry) => entry.writable) ?? contexts[0])?.iri
      : undefined;
  useEffect(() => {
    if (fallback) void actions.selectContext(fallback).catch(() => {});
  }, [actions, fallback]);
  const select = useCallback(
    async (iri: string) => {
      if (iri === selectedIri) return true;
      try {
        return await actions.selectContext(iri);
      } catch {
        return false;
      }
    },
    [actions, selectedIri],
  );
  const retry = useCallback(async () => {
    if (id) await actions.refreshContexts(id).catch(() => {});
  }, [actions, id]);
  const { error } = useSdkLocale();
  // A failure before the Pod's consent page, kept for its connection only.
  const [shareFailure, setShareFailure] = useState<{
    readonly id: string;
    readonly cause: unknown;
  } | null>(null);
  const share = useCallback(async () => {
    if (!id) return false;
    setShareFailure(null);
    try {
      return await actions.authorize(id);
    } catch (cause) {
      setShareFailure({ id, cause });
      return false;
    }
  }, [actions, id]);
  return {
    contexts,
    selected: contexts.find((entry) => entry.iri === selectedIri) ?? null,
    select,
    /** Signed in, but no Contexts known yet. */
    loading:
      active && !knownContexts(catalogue) && catalogue?.kind !== 'failed',
    /** The catalogue failed; known Contexts may still show. */
    failed: catalogue?.kind === 'failed',
    retry,
    /** Whether `share` can ask the Pod now (a signed-in connection). */
    canShare: id !== null,
    /**
     * Asks the Pod to share more Contexts with this app: its consent page
     * opens, and the catalogue reloads on return. Runs under the leave policy.
     */
    share,
    /** Why the last `share` failed before reaching the Pod, in the UI language. */
    shareProblem:
      shareFailure && shareFailure.id === id ? error(shareFailure.cause) : null,
  };
}
/** What `useContexts` returns. */
export type ContextList = ReturnType<typeof useContexts>;

/** The readable Contexts of one catalogue as a switch names them. */
function contextChoices(
  known: readonly CatalogueContext[] | undefined,
  catalogue: CatalogueFact | undefined,
  fixed: string | undefined,
): ContextChoice[] {
  const readable = (known ?? []).filter(
    (entry) => entry.readable && (!fixed || entry.iri === fixed),
  );
  const labels = catalogue?.kind !== 'unknown' ? catalogue?.labels : undefined;
  const iris = readable.map((entry) => entry.iri);
  const label = (iri: string) => contextName(iri, labels);
  // Equal labels add the short name ("Tasks · work"); names that are still
  // equal after that, whatever made them so, add the IRI.
  const candidate = new Map(
    iris.map((iri) => {
      const plain = contextName(iri, undefined);
      const shared = iris.some(
        (other) => other !== iri && label(other) === label(iri),
      );
      return [
        iri,
        shared && label(iri) !== plain
          ? `${label(iri)} · ${plain}`
          : label(iri),
      ];
    }),
  );
  return readable.map((entry) => ({
    iri: entry.iri,
    name: distinctName(entry.iri, iris, (iri) => candidate.get(iri)!),
    writable: entry.writable,
  }));
}

/**
 * A readable Context of one connection in `usePodContexts`; as a
 * `ContextTarget` it can be passed to `select` itself.
 */
export interface PodContextChoice extends ContextChoice, ContextTarget {
  readonly connectionId: string;
  /** The same as `iri`. */
  readonly contextIri: string;
  /** Stable across renders, for React keys: connection and Context. */
  readonly key: string;
  /**
   * Whether `select` can choose it now: signed in with the required access,
   * a loaded catalogue lists it as readable, and an exact preset allows it.
   * Entries kept during a reload or after a failed one are not selectable.
   */
  readonly selectable: boolean;
}
/** One connection in `usePodContexts`, with its own state and retry. */
export interface PodContextGroup {
  readonly connectionId: string;
  readonly podUrl: string;
  /** `podNames[podUrl]`, else the address without its scheme. */
  readonly name: string;
  /**
   * The session when it is not signed in (`signed-out`, `restoring`,
   * `leaving`, `ended`), else its catalogue (`unknown`, `loading`, `ready`,
   * `failed`); a renewing session reports its catalogue. An ended or
   * restoring connection is not an empty one.
   */
  readonly status:
    | 'signed-out'
    | 'restoring'
    | 'leaving'
    | 'ended'
    | 'unknown'
    | 'loading'
    | 'ready'
    | 'failed';
  /** Its saved session can be restored again (`retry`). */
  readonly restorable?: true;
  /** Readable Contexts, also those kept while reloading or after a failure. */
  readonly choices: readonly PodContextChoice[];
  /** Restores a restorable session, else reloads the catalogue. Not guarded. */
  retry(): Promise<void>;
}
/** What `usePodContexts` returns. */
export interface PodContextList {
  readonly pods: readonly PodContextGroup[];
  /** Every group's choices, in connection order. */
  readonly choices: readonly PodContextChoice[];
  /** The active connection's selected Context, when it is listed. */
  readonly selected: PodContextChoice | null;
  /** `useApp().selectTarget`: one guarded switch, at most one prompt. */
  select(target: ContextTarget): Promise<TargetSelection>;
}

/**
 * The readable Contexts of every connection for one app-owned chooser, such
 * as "Shopping · alice" and "Shopping · bob". It discovers each signed-in
 * connection's catalogue in both modes, reads the labels of up to 20
 * Contexts per Pod once (not again on token renewal), keeps known entries
 * during a reload and after a failure, and names equal names across Pods by
 * their Pod. Unlike `useContexts` it never selects a Context by itself; a
 * remembered or preset one is restored by the runtime. `AppAccess` offers no
 * chooser of its own while this is mounted.
 */
export function usePodContexts(
  options: { readonly podNames?: Readonly<Record<string, string>> } = {},
): PodContextList {
  const value = useContext(Context);
  if (!value) throw new Error('SempodsProvider is required.');
  useDemand(true, 'discovery');
  const { retainSwitch, actions } = value;
  useEffect(() => retainSwitch(), [retainSwitch]);
  const { connections, activeId, preset } = useAppFacts(
    (s) => ({
      connections: s.connections,
      activeId: s.activeId,
      preset: s.preset,
    }),
    shallowEqual,
  );
  const { podNames } = options;
  const names = podNames ? JSON.stringify(podNames) : '';
  const pods = useMemo(() => {
    const groups = connections.map((connection) => {
      const signedIn =
        connection.session.kind === 'active' ||
        connection.session.kind === 'renewing';
      const catalogue = signedIn ? connection.catalogue : undefined;
      const fixed =
        preset?.podUrl === connection.podUrl ? preset.contextIri : undefined;
      // A failed reload keeps what was known, as a reload does.
      const known =
        catalogue && catalogue.kind !== 'unknown'
          ? catalogue.contexts
          : undefined;
      return {
        connection,
        status: signedIn
          ? connection.catalogue.kind
          : (connection.session.kind as PodContextGroup['status']),
        name: podName(connection.podUrl, podNames),
        choices: contextChoices(known, catalogue, fixed),
      };
    });
    // Names still equal across Pods add the Pod's name.
    const all = groups.flatMap((g) => g.choices.map((c) => c.name));
    return groups.map(({ connection, status, name, choices }) => ({
      connectionId: connection.id,
      podUrl: connection.podUrl,
      name,
      status,
      ...('restorable' in connection.session && connection.session.restorable
        ? { restorable: true as const }
        : {}),
      choices: choices.map((choice): PodContextChoice => ({
        ...choice,
        name:
          all.filter((n) => n === choice.name).length > 1
            ? `${choice.name} · ${name}`
            : choice.name,
        connectionId: connection.id,
        contextIri: choice.iri,
        key: `${connection.id}\n${choice.iri}`,
        selectable:
          targetProblem(connections, preset, {
            connectionId: connection.id,
            contextIri: choice.iri,
          }) === null,
      })),
      retry: async () => {
        try {
          if (
            'restorable' in connection.session &&
            connection.session.restorable
          )
            await actions.retryRestore(connection.id);
          else await actions.refreshContexts(connection.id);
        } catch {
          // The group's status shows the outcome.
        }
      },
    }));
    // `names` stands for `podNames`, which callers often pass inline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connections, preset, names, actions]);
  // Discover every signed-in connection without a catalogue yet.
  const undiscovered = pods
    .filter((g) => g.status === 'unknown')
    .map((g) => g.connectionId)
    .join(' ');
  useEffect(() => {
    for (const id of undiscovered ? undiscovered.split(' ') : [])
      void actions.refreshContexts(id).catch(() => {});
  }, [actions, undiscovered]);
  // Labels once per Pod and set of Contexts, never keyed by the session's
  // renewal: the runtime's cache decides what an identity change refreshes.
  const labelled = pods
    .filter((g) => g.status === 'ready' && g.choices.length > 0)
    .map(
      (g) =>
        g.connectionId +
        '\t' +
        g.choices
          .slice(0, 20)
          .map((c) => c.iri)
          .join(' '),
    )
    .join('\n');
  useEffect(() => {
    for (const line of labelled ? labelled.split('\n') : []) {
      const [id, iris] = line.split('\t') as [string, string];
      void actions.loadContextLabels(id, iris.split(' ')).catch(() => {});
    }
  }, [actions, labelled]);
  const choices = useMemo(() => pods.flatMap((g) => g.choices), [pods]);
  const active = connections.find((c) => c.id === activeId);
  const selected =
    choices.find(
      (c) => c.connectionId === activeId && c.iri === active?.selectedContext,
    ) ?? null;
  return { pods, choices, selected, select: actions.selectTarget };
}
function useDemand(active: boolean, kind: 'selection' | 'discovery') {
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
  const retain =
    kind === 'selection' ? value.retainContext : value.retainDiscovery;
  useEffect(() => (active ? retain() : undefined), [active, retain]);
  useEffect(() => {
    if (active && mode === 'on-demand' && id && undiscovered)
      void value.actions.refreshContexts(id).catch(() => {});
  }, [active, mode, id, undiscovered, value.actions]);
  return { mode };
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
/** Asks before a guarded transition discards a draft or unresolved write. */
function LeaveConfirmation() {
  const app = useController();
  const { confirmingLeave, unconfirmedLeave } = useAppState();
  const m = useSdkLocale().messages.controls;
  const [failed, setFailed] = useState(false);
  const [asked, setAsked] = useState(confirmingLeave);
  if (asked !== confirmingLeave) {
    setAsked(confirmingLeave);
    if (confirmingLeave) setFailed(false);
  }
  if (!confirmingLeave) return failed ? <p role="alert">{m.failure}</p> : null;
  return (
    <ConfirmDialog
      open
      ui="leave"
      title={m.leaveTitle}
      cancel={m.stay}
      confirm={m.leave}
      onCancel={() => app.cancelLeave()}
      onConfirm={() => {
        void app.confirmLeave().catch(() => setFailed(true));
      }}
    >
      <p>{unconfirmedLeave ? m.leaveUnconfirmed : m.leaveBody}</p>
      {failed && <p role="alert">{m.failure}</p>}
    </ConfirmDialog>
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

/**
 * Row selection is local and resets on target changes or remount. Selecting the
 * same resource after a remount reclaims its controller-retained editor without
 * discarding that draft or review. Other leave guards and pending writes still
 * apply; selecting another resource or closing remains guarded.
 */
export function useSelection<T = string>() {
  const app = useController();
  const view = useView();
  const [state, setState] = useState({ view, selected: null as T | null });
  if (state.view !== view) setState({ view, selected: null });
  const { select } = useCommands([app, view], {
    select: (selected: T | null) => {
      if (!view || app.getSnapshot().view !== view)
        return Promise.resolve(false);
      if (state.view === view && Object.is(state.selected, selected))
        return Promise.resolve(true);
      const choose = () => {
        if (app.getSnapshot().view === view) setState({ view, selected });
      };
      return state.selected === null && typeof selected === 'string'
        ? editorsOf(app).reopen(view, selected, choose)
        : app.navigate(choose);
    },
  });
  return { selected: state.view === view ? state.selected : null, select };
}
