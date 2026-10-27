import {
  useEffect,
  useId,
  useMemo,
  useState,
  useSyncExternalStore,
  useRef,
  useCallback,
} from 'react';
import {
  RuntimeError,
  bindResourceEditor,
  createViewLoader,
  type BoundView,
  type BoundPod,
  type ViewRead,
  type PodRead,
  type LoadState,
} from '../index.js';
import {
  updateFields,
  listSubjects,
  newSubjectIri,
  isFieldDefinition,
  type fields,
  type Creation,
  removeSnapshot,
  prepareCreation,
  type EditDefinition,
  type FieldDefinition,
  type ResourceEditor,
  type Snapshot,
  type UpdateOutcome,
  type RemoveSnapshotOutcome,
  type CreateOutcome,
} from '@sempods/client-sdk/edit';
import type { JsonLd } from '@sempods/client-sdk';
import { startupSettled } from '../authoring/app.js';
import { catalogueLists } from '../runtime/binding.js';
import {
  shallowEqual,
  useAppFacts,
  useAppState,
  useContextDiscovery,
  useController,
  useView,
  useWorkflowAccess,
} from './app.js';
import { shownData } from '../authoring/load.js';
import { useCommands } from './commands.js';
import {
  notSent,
  type MutationOutcome,
  type NotSent,
} from '../authoring/lane.js';
import { lanesOf, type LaneGroup } from '../authoring/lanes.js';
export type { MutationOutcome, NotSent } from '../authoring/lane.js';
import {
  observeStarts,
  observeWrites,
  startCount,
} from '../authoring/changes.js';

const noopSubscribe = () => () => {};
/** Internal: the number of writes started on this target, for feedback lifetime. */
export function useStartCount(view: BoundView | null | undefined) {
  const subscribe = useCallback(
    (listener: () => void) =>
      view ? observeStarts(view, listener) : noopSubscribe(),
    [view],
  );
  const read = () => (view ? startCount(view) : 0);
  return useSyncExternalStore(subscribe, read, read);
}
/**
 * Internal: calls `reload` when the page becomes visible again (back in the
 * tab or app), unless `skip()` says not to, for example while a read is
 * running and will answer anyway. Both are read when the page shows.
 */
export function useOnVisible(reload: () => void, skip: () => boolean) {
  const latest = useRef({ reload, skip });
  latest.current = { reload, skip };
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !latest.current.skip())
        latest.current.reload();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);
}
const loading = Object.freeze({ kind: 'loading' as const });
const noVersion = () => 0;
const unavailable = Object.freeze({ kind: 'unavailable' as const });
/** Reported in the console: a lost draft or write guard is an app bug. */
function warn(message: string) {
  console.warn(`[@sempods/app-sdk] ${message}`);
}
/** Structure of a `fields()` definition; `null` for any other definition. */
function definitionKey(definition: unknown): string | null {
  if (!isFieldDefinition(definition as EditDefinition<unknown>)) return null;
  const d = definition as FieldDefinition<unknown>;
  // Independent of construction order: the same fields written in another
  // order map the same terms and must keep drafts and lifetimes.
  return JSON.stringify([d.type ?? null, sorted(d.fields)]);
}
/** A plain value with object keys in a fixed order. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((k) => [k, sorted((value as Record<string, unknown>)[k])]),
  );
}
/**
 * What decides a new editor, form or list lane. A `fields()` definition keys by
 * its structure, so writing it inline changes nothing while a real change
 * (another type, language or predicate) does. Any other definition cannot be
 * compared: it never forces a new lifetime (an inline one would loop), its
 * latest value is used when one starts, and a changed identity warns once.
 */
/**
 * One instance per `fields()` structure, shared by all hooks. A list snapshot
 * belongs to the definition that created it (the portable mutations check that
 * identity), so a list and its row mutations must use the very same instance
 * even when the app writes the definition inline. `fields()` definitions are
 * fully determined by their structure, so equal ones are interchangeable.
 */
const canonical = new Map<string, unknown>();
function canonicalOf<T>(definition: T, key: string | null): T {
  if (key === null) return definition;
  const known = canonical.get(key) as T | undefined;
  if (known) return known;
  canonical.set(key, definition);
  return definition;
}
/** Internal: the stable key and canonical instance of a definition (see above). */
export function useDefinition<T>(input: T, hook: string) {
  const structure = definitionKey(input);
  const definition = canonicalOf(input, structure);
  const latest = useRef(definition);
  const warned = useRef(false);
  const key = structure ?? 'custom';
  if (key === 'custom' && latest.current !== definition && !warned.current) {
    warned.current = true;
    warn(
      `${hook}: a custom definition changed identity; the current editor or form keeps the one it started with. Keep custom definitions stable (module constant or useMemo), or remount for a different mapping.`,
    );
  }
  latest.current = definition;
  return { key, latest, definition };
}
/**
 * Runs `read` for the current target. A new target gets a fresh loader; the
 * latest `read` is used on each (re)load, so an inline function never loops.
 * Pass `key` for inputs such as a search term: a new value reads again.
 */
export function useLoad<T>(read: ViewRead<T>, options: LoadOptions = {}) {
  const { state, reload, cancel } = useBoundLoad(
    useView(),
    read,
    loading,
    options,
  );
  return { state, data: shownData(state), reload, cancel };
}
/**
 * `retain`: a reload of the same target keeps the last data visible as
 * `state.previous` while `loading`, and after a failed refresh as
 * `previous` of `failed`, which still needs a notice and a retry. A new
 * connection, authorization, target or definition, lost read access and
 * changed Pod grants start without it. It is never optimistic: only data a
 * read returned is kept. It may change between renders.
 */
export interface LoadOptions {
  readonly retain?: boolean;
  /**
   * What the read depends on besides the target, for example a search term.
   * A changed value (compared with `Object.is`) reads again without the kept
   * data, which belongs to the old inputs. Use a string or number.
   */
  readonly key?: unknown;
}
/**
 * Loads the active BoundPod using the same cancellable/bounded loader as useLoad.
 * Context/catalogue/label changes do not reload it. Changed Pod/session/grants
 * retire obsolete results; no catalogue or Context fallback is requested.
 * No reader means unavailable after startup completes or fails. Inline callbacks do not loop:
 * pass `key` for the query's inputs, and a new value reads again.
 */
export function usePodLoad<T>(read: PodRead<T>, options: LoadOptions = {}) {
  const { pod, startup, startupError } = useAppState();
  const { state, reload, cancel } = useBoundLoad(
    pod,
    read,
    startupSettled({ startup, startupError }) ? unavailable : loading,
    options,
  );
  return { state, data: shownData(state), reload, cancel };
}
function useBoundLoad<T, H extends BoundView | BoundPod>(
  view: H | null,
  read: (handle: H, signal: AbortSignal) => ReturnType<ViewRead<T>>,
  empty: LoadState<T> = loading,
  { retain = false, key }: LoadOptions = {},
) {
  const latest = useRef(read);
  latest.current = read;
  // The loader reads it at each (re)load.
  const loaderOptions = useRef({ retain });
  loaderOptions.current.retain = retain;
  const [active, setActive] = useState<{
    view: H;
    loader: ReturnType<typeof createViewLoader<T, H>>;
  } | null>(null);
  useEffect(() => {
    if (!view) {
      setActive(null);
      return;
    }
    const loader = createViewLoader<T, H>(
      view,
      (target, signal) => latest.current(target, signal),
      loaderOptions.current,
    );
    setActive({ view, loader });
    void loader.reload();
    return () => loader.dispose();
  }, [view]);
  const loader = active?.view === view ? active.loader : null;
  const loaded: LoadState<T> = useSyncExternalStore(
    loader?.subscribe ?? noopSubscribe,
    loader?.getSnapshot ?? (() => empty),
    loader?.getSnapshot ?? (() => empty),
  );
  // The key whose read the loader's state belongs to; a newer key shows
  // loading until its own read starts, never the old inputs' data.
  const inputs = useRef({ loader, key });
  const state =
    loader &&
    inputs.current.loader === loader &&
    !Object.is(inputs.current.key, key)
      ? loading
      : loaded;
  const reload = useCallback(async () => {
    await loader?.reload();
    return loader?.getSnapshot();
  }, [loader]);
  /** A reload for changed read inputs: retained data belongs to the old ones. */
  const restart = useCallback(async () => {
    await loader?.reload({ fresh: true });
    return loader?.getSnapshot();
  }, [loader]);
  const cancel = useCallback(() => loader?.cancel(), [loader]);
  // Changed read inputs: a fresh read for this loader (a new one reads anyway).
  useEffect(() => {
    const before = inputs.current;
    inputs.current = { loader, key };
    if (before.loader === loader && !Object.is(before.key, key)) void restart();
  }, [loader, key, restart]);
  return { state, reload, restart, cancel };
}
/**
 * A typed list, refreshed after this bound target's own confirmed mutations
 * and when the page becomes visible again (back in the tab or app), so other
 * devices' changes appear without a reload button. Those refreshes and
 * `reload()` keep the rows visible (`retain`, see
 * `LoadOptions`, on by default; `retain: false` shows only `loading`).
 * `data` is what to render: the current rows, or the kept ones while
 * `loading` or after a failed refresh; `LoadNotice` says which.
 */
export function useList<D>(
  definition: FieldDefinition<D>,
  options: { readonly type?: string } & LoadOptions = {},
) {
  const view = useView();
  const type = options.type;
  const { key, latest } = useDefinition(definition, 'useList');
  const listKey = JSON.stringify([key, type ?? null]);
  // Which definition and type the loader's latest read was started for.
  const started = useRef<string | null>(null);
  const read = useCallback(
    (target: BoundView, signal: AbortSignal) => {
      started.current = listKey;
      return listSubjects(target, latest.current, {
        signal,
        ...(type === undefined ? {} : { type }),
      });
    },
    // `listKey` stands for the definition and type: a real change reads again.
    // `latest` is a ref and keeps its identity.
    [listKey, latest, type],
  );
  const load = useBoundLoad(view, read, loading, {
    retain: options.retain ?? true,
  });
  // Until the read for a changed definition or type has started, the rows on
  // screen belong to the previous definition and cannot be mutated with the
  // current one: report loading instead of offering them, also as retained data.
  const state: typeof load.state =
    started.current !== listKey &&
    (load.state.kind === 'ready' || 'previous' in load.state)
      ? loading
      : load.state;
  const { reload, restart } = load;
  // A real definition or type change reads again (the first read is the
  // load's), without the rows of the old one.
  const shown = useRef(read);
  useEffect(() => {
    if (shown.current === read) return;
    shown.current = read;
    void restart();
  }, [read, restart]);
  const current = useRef({ view, read, cancelled: false });
  if (current.current.view !== view || current.current.read !== read)
    current.current = { view, read, cancelled: false };
  const scope = current.current;
  useEffect(() => {
    if (!view) return;
    return observeWrites(view, () => {
      if (!scope.cancelled) void reload();
    });
  }, [view, reload, scope]);
  // Back in the tab or app, other devices may have changed the list. A read
  // still running answers that already: it is joined, not aborted.
  const shownState = useRef(state);
  shownState.current = state;
  useOnVisible(
    () => void reload(),
    () => !view || scope.cancelled || shownState.current.kind === 'loading',
  );
  const { cancel } = load;
  const reloadList = useCallback(() => {
    scope.cancelled = false;
    return reload();
  }, [scope, reload]);
  const cancelList = useCallback(() => {
    scope.cancelled = true;
    cancel();
  }, [scope, cancel]);
  return {
    state,
    data: shownData(state),
    reload: reloadList,
    cancel: cancelList,
  };
}
/** Identity/target and row changes create new editors; access and locale changes do not. */
export function useResourceEditor<
  F extends ReturnType<typeof fields<Record<never, never>>>,
>(
  iri: string | null,
  definition: F,
): ResourceEditor<ReturnType<F['read']>, Partial<ReturnType<F['read']>>> | null;
export function useResourceEditor<D>(
  iri: string | null,
  definition: EditDefinition<D>,
): ResourceEditor<D> | null;
export function useResourceEditor<D>(
  iri: string | null,
  definition: EditDefinition<D>,
) {
  return useBoundEditor(
    useView(),
    iri,
    definition,
    'useResourceEditor',
    'local',
  );
}
/**
 * The editor lifetime behind `useResourceEditor` and `useContextEditor`: one
 * editor per view, subject and definition, registered as a leave guard with
 * `scope`. `hook` names the caller in warnings.
 */
function useBoundEditor<D>(
  view: BoundView | null,
  iri: string | null,
  definition: EditDefinition<D>,
  hook: string,
  scope: 'local' | 'connection',
) {
  const app = useController();
  const { key, latest } = useDefinition(definition, hook);
  const [active, setActive] = useState<{
    view: BoundView;
    iri: string;
    key: string;
    editor: ResourceEditor<D>;
  } | null>(null);
  const previous = useRef<typeof active>(null);
  useEffect(() => {
    const before = previous.current;
    if (
      before &&
      before.view === view &&
      before.iri === iri &&
      before.key !== key &&
      (before.editor.state.dirty ||
        before.editor.state.phase === 'saving' ||
        before.editor.state.review !== null)
    )
      warn(
        `${hook}: the field definition changed for the same subject; its unsaved draft, pending write or open review was discarded.`,
      );
    if (!view || !iri) {
      previous.current = null;
      setActive(null);
      return;
    }
    const editor = bindResourceEditor(view, iri, latest.current);
    const unregister = app.register({
      scope,
      unconfirmed: () => editor.state.review?.kind === 'unconfirmed',
      dirty: () =>
        editor.state.phase !== 'deleted' &&
        (editor.state.dirty || editor.state.review !== null),
      blocked: () => editor.state.phase === 'saving',
      discard: () => editor.discard(),
    });
    const next = { view, iri, key, editor };
    previous.current = next;
    setActive(next);
    return () => {
      unregister();
      editor.dispose();
    };
    // `key` stands for the definition (see useDefinition); `latest` is its ref.
    // `hook` only names the caller in a warning.
  }, [view, iri, key, app, latest, hook, scope]);
  const editor =
    active?.view === view && active.iri === iri && active.key === key
      ? active.editor
      : null;
  useSyncExternalStore(
    editor?.subscribe ?? noopSubscribe,
    () => editor?.state ?? null,
    () => null,
  );
  return editor;
}
/** A Pod-overview row as an edit target: one subject inside the one Context its `GRAPH` binding names. */
export interface ContextTarget {
  readonly subject: string;
  readonly context: string;
}
/** Where `useContextEditor` stands; see the hook for each phase. */
export type ContextEditorPhase =
  'idle' | 'loading' | 'unavailable' | 'ready' | 'retired';
/** Why `useContextEditor` reports `unavailable`. */
export type ContextEditorProblem =
  /** The catalogue does not list the Context as readable. */
  | 'unreadable'
  /** The catalogue could not be loaded. */
  | 'discovery-failed'
  /** The runtime refused the binding, for example another Context than an exact preset's. */
  | 'refused';
/** What `useContextEditor` returns: the opened target, its phase and, while ready, its editor. */
export interface ContextEditor<D, U = D> {
  /** The opened target, kept while retired so the app can name it. */
  readonly target: ContextTarget | null;
  readonly phase: ContextEditorPhase;
  /** Set only while `phase` is `'unavailable'`. */
  readonly problem: ContextEditorProblem | null;
  /** Present only while `phase` is `'ready'`; render it with `ResourceEditor`. */
  readonly editor: ResourceEditor<D, U> | null;
  /**
   * Opens another target under the leave policy, for the connection active
   * now. `true` once the target is open; whether it becomes `ready` is
   * reported through `phase`. `false` if the person declined, a pending write
   * blocks it, no connection is active, or another connection became active
   * while it asked. Opening the same target again while that is under way
   * shares its result.
   */
  open(target: ContextTarget): Promise<boolean>;
  /**
   * Closes the target under the leave policy; `false` if declined or blocked
   * by a pending write. A retired target closes at once.
   */
  close(): Promise<boolean>;
}
/** One opened target and the connection it belongs to. */
interface ContextLane {
  readonly target: ContextTarget;
  readonly connection: string;
}
interface ContextLaneState {
  readonly lane: ContextLane;
  /** The explicit binding once established, or the runtime's refusal. */
  readonly binding: BoundView | 'refused' | null;
  /** The catalogue listed the Context as readable once: the editor may exist. */
  readonly activated: boolean;
  /** Another connection became active; never revived. */
  readonly retired: boolean;
}
const sameTarget = (a: ContextTarget, b: ContextTarget) =>
  a.subject === b.subject && a.context === b.context;
/** Whether a lane is still live: not retired and its connection active. */
const liveLane = (s: ContextLaneState | null, activeId: string | null) =>
  s !== null && !s.retired && s.lane.connection === activeId;
/**
 * Edits one Pod-overview row in its own Context. The SELECT row is only a
 * pointer: the editor reads the subject fresh in that Context through
 * `runtime.bindContext` and saves with its version (If-Match). The connection's
 * selected Context, the remembered choice and every `TargetScreen` stay as
 * they are, so a creation form elsewhere keeps its target.
 *
 * `open(target)` records the active connection and demands its catalogue; the
 * editor needs no `TargetScreen`. Unlike a `TargetScreen` it asks for no
 * selected Context, so `AppAccess` shows no Context chooser for it; a failed
 * catalogue still appears there with "Check access".
 *
 * - `idle`: nothing is open.
 * - `loading`: startup, sign-in or the catalogue is not settled yet.
 * - `unavailable`: the target could not be established; `problem` says why
 *   (`unreadable`, `discovery-failed` or `refused`). A refusal is handled here:
 *   no request is sent, and close and reopen keep working. A later catalogue
 *   that lists the Context, for example after "Check access", still opens it.
 * - `ready`: the binding and its resource editor exist. That does not mean the
 *   resource exists or saving is permitted: loading, `404`, offline failures,
 *   blocked access and review are states of that editor, with its retry.
 * - `retired`: another connection became active. The editor is gone and the
 *   target is never revived; close it, or open the row again.
 *
 * Once an editor exists, losing read access, a failed catalogue refresh or the
 * session ending keep it with its draft and any unconfirmed-write review; it is
 * never attached to another Context, connection, subject or generation. The
 * editor is a `connection`-scoped leave guard: selecting another Context
 * neither asks about it nor discards it, while `open` with another target,
 * `close` and connection actions ask first, and its pending write blocks them.
 * One target is one Context: a subject with data in several Contexts appears as
 * several overview rows, and each row opens its own target.
 */
export function useContextEditor<
  F extends ReturnType<typeof fields<Record<never, never>>>,
>(
  definition: F,
): ContextEditor<ReturnType<F['read']>, Partial<ReturnType<F['read']>>>;
export function useContextEditor<D>(
  definition: EditDefinition<D>,
): ContextEditor<D>;
export function useContextEditor<D>(
  definition: EditDefinition<D>,
): ContextEditor<D> {
  const app = useController();
  const [state, setState] = useState<ContextLaneState | null>(null);
  // The latest lane state, ahead of rendering: open() and close() chained from
  // one render (`await open(); await close()`) act on what is current.
  const latest = useRef<ContextLaneState | null>(null);
  const apply = useCallback(
    (change: (s: ContextLaneState | null) => ContextLaneState | null) => {
      const next = change(latest.current);
      if (next === latest.current) return;
      latest.current = next;
      setState(next);
    },
    [],
  );
  const update = useCallback(
    (lane: ContextLane, change: Partial<ContextLaneState>) =>
      apply((s) => (s?.lane === lane && !s.retired ? { ...s, ...change } : s)),
    [apply],
  );
  const opening = useRef<{
    readonly target: ContextTarget;
    readonly result: Promise<boolean>;
  } | null>(null);
  const lane = state?.lane ?? null;
  // Only the facts this hook uses: a token renewal or another connection's
  // catalogue does not re-render the host.
  const laneConnection = state && !state.retired ? state.lane.connection : null;
  const { activeId, ready, catalogue } = useAppFacts(
    (s) => ({
      activeId: s.activeId,
      // No Context-bound editor before startup settles (a returning sign-in
      // may still replace the active connection), as for the selected view.
      // `pod` exists while the active connection is signed in.
      ready: startupSettled(s) && s.pod !== null,
      // The live lane's catalogue only: its connection is the active one.
      catalogue:
        laneConnection !== null && laneConnection === s.activeId
          ? s.connections.find((c) => c.id === laneConnection)?.catalogue
          : undefined,
    }),
    shallowEqual,
  );
  const binding = state?.binding ?? null;
  const bound = binding === 'refused' ? null : binding;
  const activated = state?.activated ?? false;
  const live = liveLane(state, activeId);
  // Only the originating connection may demand discovery for this target, and
  // only once the runtime accepted the binding: a refused target sends nothing.
  // Discovery only: an explicit target needs no selected Context, so AppAccess
  // offers no chooser for it.
  useContextDiscovery(live && bound !== null);
  // The binding's own rule for catalogue evidence, without its required-scope
  // check: a target missing scopes would otherwise stay loading with no problem
  // to present. A newly opened row needs a successful listing, not retained
  // evidence from before a failed refresh.
  const readable =
    live &&
    catalogue?.kind === 'ready' &&
    catalogueLists(catalogue, lane!.target.context);
  useEffect(() => {
    if (!lane) return;
    if (lane.connection !== activeId) {
      update(lane, { retired: true });
      return;
    }
    if (binding) {
      // Readability can arrive after the binding, for example after "Check access".
      if (bound && !activated && readable) update(lane, { activated: true });
      return;
    }
    if (!ready) return;
    try {
      const view = app.runtime.bindContext(
        lane.connection,
        lane.target.context,
      );
      // The first activation needs fresh readable evidence; afterwards access
      // loss keeps the editor and its draft.
      update(lane, { binding: view, activated: readable });
    } catch (error) {
      if (!(error instanceof RuntimeError)) throw error;
      // Not signed in after all: wait. A configuration refusal is the target's.
      if (error.problem === 'configuration')
        update(lane, { binding: 'refused' });
      else if (error.problem !== 'disconnected') throw error;
    }
  }, [app, lane, activeId, binding, bound, activated, readable, ready, update]);
  const editor = useBoundEditor(
    live && activated ? bound : null,
    live && activated ? lane!.target.subject : null,
    definition,
    'useContextEditor',
    'connection',
  );
  const problem: ContextEditorProblem | null =
    !live || editor
      ? null
      : binding === 'refused'
        ? 'refused'
        : catalogue?.kind === 'failed'
          ? 'discovery-failed'
          : catalogue?.kind === 'ready' && !readable
            ? 'unreadable'
            : null;
  const phase: ContextEditorPhase = !lane
    ? 'idle'
    : !live
      ? 'retired'
      : editor
        ? 'ready'
        : problem
          ? 'unavailable'
          : 'loading';
  const open = useCallback(
    (target: ContextTarget) => {
      const now = latest.current;
      const binding = now?.binding;
      if (
        liveLane(now, app.getSnapshot().activeId) &&
        sameTarget(now!.lane.target, target) &&
        // A binding that can never become valid again (session end, another
        // subject) is replaced by a fresh lane, after the leave policy asks.
        !(binding && binding !== 'refused' && !binding.getSnapshot().current)
      )
        return Promise.resolve(true);
      // Repeated before a re-render (a double click): share the first call.
      const pending = opening.current;
      if (pending && sameTarget(pending.target, target)) return pending.result;
      // The row belongs to the connection active when it is opened. The
      // controller cancels the prompt if another one becomes active meanwhile.
      const connection = app.getSnapshot().activeId;
      if (!connection) return Promise.resolve(false);
      const result = app
        .navigate(() =>
          apply(() => ({
            lane: {
              target: { subject: target.subject, context: target.context },
              connection,
            },
            binding: null,
            activated: false,
            retired: false,
          })),
        )
        .finally(() => {
          if (opening.current?.result === result) opening.current = null;
        });
      opening.current = { target, result };
      return result;
    },
    [app, apply],
  );
  const close = useCallback(() => {
    const now = latest.current;
    if (!now) return Promise.resolve(true);
    const clear = () => apply(() => null);
    // A retired target has no guard left; clearing it at once also keeps an
    // unrelated pending prompt from blocking the close.
    if (!liveLane(now, app.getSnapshot().activeId)) {
      clear();
      return Promise.resolve(true);
    }
    return app.navigate(clear);
  }, [app, apply]);
  const target = lane?.target ?? null;
  return useMemo(
    () => ({ target, phase, problem, editor, open, close }),
    [target, phase, problem, editor, open, close],
  );
}
/**
 * One mutation lane. Captures target/subject; stale completions never update a
 * new lane. `explicit` is a view bound to an explicit Context (`null` while it
 * binds); without it the lane follows the selected view.
 */
function useMutation<D>(
  definition: FieldDefinition<D>,
  explicit?: BoundView | null,
) {
  const selected = useView();
  const view = explicit === undefined ? selected : explicit;
  const app = useController();
  const access = useWorkflowAccess();
  const ownWrite = useSyncExternalStore(
    explicit?.subscribe ?? noopSubscribe,
    () => explicit?.getSnapshot().write ?? false,
    () => explicit?.getSnapshot().write ?? false,
  );
  const writable = explicit === undefined ? access.write : ownWrite;
  const { key } = useDefinition(definition, 'useFieldUpdate');
  // The controller owns this form's lane, so a creation that settles while the
  // form is hidden keeps its outcome and guard; an explicit Context stays
  // through row changes and Context selection.
  const group = view
    ? lanesOf(app).group(
        view,
        key,
        definition,
        explicit === undefined ? 'target' : 'explicit',
      )
    : null;
  useSyncExternalStore(
    group?.subscribe ?? noopSubscribe,
    group?.getVersion ?? noVersion,
    group?.getVersion ?? noVersion,
  );
  // One lane per hook instance (it survives hiding, not remounting). Commands
  // look it up live: a create in the same event may have just started it.
  const id = `form ${useId()}`;
  const lane = group?.lanes.get(id) ?? null;
  const live = () => group?.lanes.get(id);
  const starts = useStartCount(view);
  const available = Boolean(
    view &&
    writable &&
    group?.holds() &&
    !app.getSnapshot().changing &&
    !app.getSnapshot().confirmingLeave,
  );
  return {
    execute: (
      operation: 'create' | 'update' | 'remove',
      iri: string,
      action: (target: BoundView) => Promise<MutationOutcome<D>>,
    ): Promise<MutationOutcome<D> | NotSent> =>
      group
        ? group.lane(id).execute(operation, iri, action)
        : Promise.resolve(notSent('unavailable')),
    editable: () =>
      Boolean(group?.holds()) && !live()?.pending && !live()?.unresolved,
    refusal: () =>
      group ? group.lane(id).refusal() : ('unavailable' as const),
    acknowledge: () => live()?.acknowledge(),
    busy: lane?.state?.busy ?? false,
    unresolved: lane?.unresolved ?? false,
    canMutate: lane ? lane.canMutate(writable) : available,
    outcome: lane?.outcome(starts) ?? null,
    operation: lane?.state?.operation ?? null,
    notice: lane ? lane.notice(starts) : noNotice,
    checked: () => live()?.isChecked() ?? false,
    absent: () => (live()?.isChecked() ?? false) && Boolean(live()?.absent),
  };
}
/** Notice props for a resource this hook has not written yet. */
const noNotice = Object.freeze({
  outcome: null,
  checked: false,
  current: undefined,
  unreadable: false,
  onCheck: async () => false,
  onAcknowledge: () => {},
});
const iriOf = (target: string | { readonly iri: string }) =>
  typeof target === 'string' ? target : target.iri;
/**
 * Safe availability and standard recovery feedback for one-click row mutations.
 *
 * Each resource has its own write lane, owned by the app controller rather than
 * by this hook or a row component, so hiding or remounting keeps it. `const row = mutate.for(item)` gives one row what it needs:
 * `row.data` to show, `row.canMutate`, `row.notice` and `row.update(change)` /
 * `row.remove()`. Ticking one task leaves the others usable, and an unresolved
 * write stays (with its check and acknowledgement) also while its row is not
 * rendered, for example during lost read access. `canMutate`, `outcome`,
 * `notice` and `acknowledge` keep their list-wide meaning: false while any
 * resource's write is pending or unresolved, and the latest write's feedback.
 * The commands keep their identity for one target and definition.
 *
 * A success in the feedback retires when this hook or another creation,
 * row mutation or bound editor starts a write on the same target, and is not
 * shown if such a write started while it was pending. A failure
 * stays until that resource is written again; an unresolved outcome
 * (`unconfirmed`, `changed-on-pod`) stays until it is checked and acknowledged.
 * Losing read access clears comparison values (including `outcome.current`
 * and `desiredObserved`) and `checked`. Regaining access needs a fresh
 * check. Write-only loss retains comparison evidence; neither loss replays a write.
 *
 * A command that sends nothing resolves `{ kind: 'not-sent', reason }` (see
 * `NotSent`). A sent one always resolves its outcome, also when the target
 * changed meanwhile; then it is no longer shown or guarded here.
 */
export function useFieldUpdate<D>(input: FieldDefinition<D>) {
  // The same instance as useList's snapshots (see canonicalOf).
  const definition = canonicalOf(input, definitionKey(input));
  const view = useView();
  const app = useController();
  const access = useWorkflowAccess();
  const { key } = useDefinition(definition, 'useFieldUpdate');
  // The controller owns the lanes of this target and definition: a write keeps
  // its outcome and leave guard while this screen is hidden or remounts.
  const group = view
    ? lanesOf(app).group(view, key, definition, 'target')
    : null;
  useSyncExternalStore(
    group?.subscribe ?? noopSubscribe,
    group?.getVersion ?? noVersion,
    group?.getVersion ?? noVersion,
  );
  // This hook's own part: whether its screen is shown (commands start only
  // then) and which resource it wrote last (its list-wide feedback).
  const own = useRef<{
    readonly group: LaneGroup<D> | null;
    active: boolean;
    latest: string | null;
  }>({ group, active: false, latest: null });
  if (own.current.group !== group)
    own.current = { group, active: own.current.active, latest: null };
  const mine = own.current;
  useEffect(() => {
    mine.active = true;
    return () => {
      mine.active = false;
    };
  }, [mine]);
  const starts = useStartCount(view);
  const all = group ? [...group.lanes.values()] : [];
  // Whether a resource without a lane of its own could be written now.
  const available = Boolean(
    view &&
    access.write &&
    group?.holds() &&
    !app.getSnapshot().changing &&
    !app.getSnapshot().confirmingLeave,
  );
  const latest = mine.latest ? (group?.lanes.get(mine.latest) ?? null) : null;
  // The commands keep their identity for this target and definition, so they
  // fit effect dependencies; a retained one keeps writing to its own target.
  const actions = useMemo(() => {
    const run = (
      iri: string,
      operation: 'create' | 'update' | 'remove',
      action: (target: BoundView) => Promise<MutationOutcome<D>>,
      subject?: Snapshot<D>,
      after?: D,
    ): Promise<MutationOutcome<D> | NotSent> => {
      if (!group) return Promise.resolve(notSent('unavailable'));
      if (!mine.active) return Promise.resolve(notSent('ended'));
      const lane = group.lane(iri);
      // A refused write sends nothing and keeps the latest write's recovery.
      const refused = lane.refusal(subject);
      if (refused) return Promise.resolve(notSent(refused));
      mine.latest = iri;
      return lane.execute(operation, iri, action, subject, after);
    };
    return {
      update: (snapshot: Snapshot<D>, change: Partial<D>) =>
        run(
          snapshot.iri,
          'update',
          (v) => updateFields(v, snapshot, definition, change),
          snapshot,
          {
            ...snapshot.data,
            ...Object.fromEntries(
              Object.entries(change).filter(([, value]) => value !== undefined),
            ),
          },
        ) as Promise<UpdateOutcome<D> | NotSent>,
      remove: (snapshot: Snapshot<D>) =>
        run(snapshot.iri, 'remove', (v) =>
          removeSnapshot(v, snapshot, definition),
        ) as Promise<RemoveSnapshotOutcome<D> | NotSent>,
      create: (
        ...args:
          | [iri: string, body: JsonLd]
          | [iri: string, definition: FieldDefinition<D>, draft: D]
      ) =>
        run(args[0], 'create', (v) =>
          args.length === 3
            ? prepareCreation(v, args[0], args[1], args[2]).run()
            : prepareCreation(v, args[0], args[1]).run(),
        ) as Promise<CreateOutcome | NotSent>,
      acknowledge: () => {
        if (mine.latest) group?.lanes.get(mine.latest)?.acknowledge();
      },
    };
    // `definition` belongs to `group` (same target and definition).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group, mine]);
  function rowFor(item: Snapshot<D>): FieldUpdateRow<D>;
  function rowFor(item: string): FieldUpdateState<D>;
  function rowFor(
    item: Snapshot<D> | string,
  ): FieldUpdateState<D> | FieldUpdateRow<D> {
    const lane = group?.lanes.get(iriOf(item));
    const state: FieldUpdateState<D> = {
      canMutate: lane
        ? lane.canMutate(
            access.write,
            typeof item === 'string' ? undefined : item,
          )
        : available,
      notice: lane?.notice(starts) ?? noNotice,
    };
    if (typeof item === 'string') return state;
    return {
      ...state,
      data:
        lane && lane.spent === item && lane.spentData
          ? lane.spentData
          : item.data,
      update: (change: Partial<D>) => actions.update(item, change),
      remove: () => actions.remove(item),
    } satisfies FieldUpdateRow<D>;
  }
  return {
    /**
     * One resource: whether it may be written now, its notice, what to show
     * and its commands. Other resources' writes do not lock it. Pass the
     * list's snapshot; an IRI alone gives `canMutate` and `notice`, for
     * example for a resource whose row is gone.
     */
    for: rowFor,
    /**
     * Resources whose write is unconfirmed or changed on the Pod, until checked
     * and acknowledged. Show `for(iri).notice` for those whose rows are gone,
     * for example deleted elsewhere, so their recovery stays reachable.
     */
    unresolved: all.filter((l) => l.unresolved).map((l) => l.iri),
    /** False while any resource's write is pending or unresolved. */
    canMutate: available && all.every((l) => !l.pending && !l.unresolved),
    /** The latest write's state and feedback, for a single shared notice. */
    busy: latest?.state?.busy ?? false,
    outcome: latest?.outcome(starts) ?? null,
    operation: latest?.state?.operation ?? null,
    notice: latest ? latest.notice(starts) : noNotice,
    update: actions.update,
    remove: actions.remove,
    create: actions.create,
    /**
     * Explicit acknowledgement does not replay the command. Prefer notice for
     * checked UI recovery. It reads the live latest lane, so a result kept
     * across an awaited write acknowledges that write.
     */
    acknowledge: actions.acknowledge,
  };
}

/** `UpdateNotice` props for one resource's latest write. */
export interface FieldUpdateNotice<D> {
  readonly outcome: MutationOutcome<D> | null;
  readonly checked: boolean;
  readonly current: D | null | undefined;
  readonly unreadable: boolean;
  readonly onCheck: () => Promise<boolean>;
  readonly onAcknowledge: () => void;
}
/** One resource of `useFieldUpdate`, from `for(iri)`. */
export interface FieldUpdateState<D> {
  /** Whether this resource may be written now. */
  readonly canMutate: boolean;
  readonly notice: FieldUpdateNotice<D>;
}
/** One resource of `useFieldUpdate`, from `for(snapshot)`. */
export interface FieldUpdateRow<D> extends FieldUpdateState<D> {
  /**
   * What to show: the snapshot's values, with a confirmed update laid over
   * until the list reads the resource again.
   */
  readonly data: D;
  /** Updates the changed fields from this snapshot; see `useFieldUpdate`. */
  update(change: Partial<D>): Promise<UpdateOutcome<D> | NotSent>;
  /** Removes the version this snapshot shows. */
  remove(): Promise<RemoveSnapshotOutcome<D> | NotSent>;
}
/** What `useFieldUpdate` returns. */
export type FieldUpdate<D> = ReturnType<typeof useFieldUpdate<D>>;

/**
 * A view bound to an explicit Context of the active connection, as
 * `useContextEditor` binds one: after startup settles, through
 * `runtime.bindContext`. A configuration refusal (not a Context of this Pod,
 * or not the preset's) is reported; while signed out it waits. It demands
 * catalogue discovery, so its write access is known, but no selection.
 */
function useExplicitView(context: string | undefined) {
  const app = useController();
  const { activeId, ready } = useAppFacts(
    (s) => ({
      activeId: s.activeId,
      ready: startupSettled(s) && s.pod !== null,
    }),
    shallowEqual,
  );
  const key =
    context !== undefined && activeId ? `${activeId} ${context}` : null;
  const [binding, setBinding] = useState<{
    readonly key: string;
    readonly view: BoundView | 'refused';
  } | null>(null);
  const current = binding?.key === key ? binding.view : null;
  const bound = current === 'refused' ? null : current;
  // A binding stays through access loss; a new authorization (for example a
  // re-authorization resumed from the back/forward cache) retires it.
  const live = useSyncExternalStore(
    bound?.subscribe ?? noopSubscribe,
    () => bound?.getSnapshot().current ?? true,
    () => bound?.getSnapshot().current ?? true,
  );
  useEffect(() => {
    if (!key || !ready || current === 'refused' || (current && live)) return;
    try {
      const view = app.runtime.bindContext(activeId!, context!);
      if (view !== current) setBinding({ key, view });
    } catch (error) {
      if (!(error instanceof RuntimeError)) throw error;
      if (error.problem === 'configuration')
        setBinding({ key, view: 'refused' });
      else if (error.problem !== 'disconnected') throw error;
    }
  }, [app, key, ready, current, live, activeId, context]);
  useContextDiscovery(current !== null && current !== 'refused');
  return {
    view: current === 'refused' ? null : current,
    refused: current === 'refused',
  };
}
/**
 * Owns the draft, leave guard and captured command for one intended creation.
 *
 * Several resources from one input are created one at a time: while `canEdit`
 * is true and the draft is blank, call `change(draft)` and then
 * `await create()` for each item, and stop at the first result that is not
 * `created`. Both actions use the hook's latest state, so one handler may keep
 * calling them across awaits. Each confirmed creation resets the draft; the
 * next item captures a fresh IRI. The item that stopped stays in the draft, or
 * may exist if the target lifetime ended (see `create`); never resubmit it
 * from the input.
 *
 * `created` stays in `outcome`/`notice` until the next `change` or until another
 * hook or bound-editor write starts on the same target (also while pending). A failure stays until the next `change` or
 * `create`; an unconfirmed creation stays until it is checked and acknowledged.
 * Comparison evidence follows the read-access lifetime described by
 * `useFieldUpdate`; read loss keeps the locked draft and captured command.
 */
export function useCreation<D extends object>(
  definition: FieldDefinition<D>,
  options: {
    readonly initial: D;
    readonly collection: string;
    /**
     * Create in this Context instead of the selected one, through
     * `runtime.bindContext`. The draft and its target stay when another
     * Context is selected or a row opens; connection actions ask first.
     */
    readonly context?: string;
  },
) {
  const explicit = useExplicitView(options.context);
  const selected = useView();
  const view = options.context === undefined ? selected : explicit.view;
  const { key } = useDefinition(definition, 'useCreation');
  const mutation = useMutation(
    definition,
    options.context === undefined ? undefined : explicit.view,
  );
  const initial = useRef(options.initial);
  initial.current = options.initial;
  const copy = (draft: D) => Object.freeze({ ...draft });
  const [state, setState] = useState(() => ({
    view,
    key,
    draft: copy(options.initial),
  }));
  const current = useRef(state);
  if (state.view !== view || state.key !== key) {
    if (
      state.view === view &&
      JSON.stringify(state.draft) !== JSON.stringify(options.initial)
    )
      warn(
        'useCreation: the field definition changed and the unsaved creation draft was reset.',
      );
    const next = { view, key, draft: copy(options.initial) };
    current.current = next;
    setState(next);
  } else current.current = state;
  const command = useRef<{
    state: typeof state;
    creation: Creation;
    retry: boolean;
  } | null>(null);
  const draft = current.current.draft;
  const reset = () => {
    if (current.current.view !== view || current.current.key !== key) return;
    const next = { view, key, draft: copy(initial.current) };
    current.current = next;
    command.current = null;
    setState(next);
  };
  useDraftGuard(
    JSON.stringify(draft) !== JSON.stringify(options.initial),
    reset,
    options.context === undefined ? 'target' : 'explicit',
  );
  const retrying = () =>
    command.current?.state === current.current && command.current.retry;
  const canEdit = !mutation.busy && !mutation.unresolved && !retrying();
  const valid = (value: D) => {
    try {
      return definition.valid?.(value) ?? true;
    } catch {
      return false;
    }
  };
  // Both keep their identity for this target and definition.
  const commands = useCommands([view, key], {
    /**
     * Applies at once, so a following `create()` submits this draft. Ignored
     * while a command is pending, unconfirmed or held for an explicit retry
     * (`canEdit` is false).
     */
    change: (patch: Partial<D>) => {
      if (
        !mutation.editable() ||
        retrying() ||
        current.current.view !== view ||
        current.current.key !== key
      )
        return;
      mutation.acknowledge();
      const next = {
        view,
        key,
        draft: copy({ ...current.current.draft, ...patch }),
      };
      current.current = next;
      command.current = null;
      setState(next);
    },
    /**
     * Sends the current draft under its captured IRI and resolves its outcome
     * with that `iri`, also when the target changed meanwhile (then the
     * notice is gone, but the item may exist; never resubmit it from the
     * input). `not-sent` means nothing was sent and the draft is kept.
     */
    create: async (): Promise<
      (CreateOutcome & { readonly iri: string }) | NotSent
    > => {
      if (!view || current.current.view !== view)
        return notSent(view ? 'ended' : 'unavailable');
      // Live: a batch may call this before the render after its last item.
      const refused = mutation.refusal();
      if (refused) return notSent(refused);
      if (!valid(current.current.draft)) return notSent('invalid');
      const submitted = current.current;
      if (command.current?.state !== submitted)
        command.current = {
          state: submitted,
          retry: false,
          creation: prepareCreation(
            view,
            newSubjectIri(view, options.collection),
            definition,
            submitted.draft,
          ),
        };
      const captured = command.current.creation;
      const outcome = await mutation.execute('create', captured.iri, () =>
        captured.run(),
      );
      if (outcome.kind === 'not-sent') return outcome;
      if (outcome.kind === 'created' && current.current === submitted) reset();
      // The captured IRI of every sent creation, for example to link a second
      // creation to it; an unconfirmed one keeps it for its retry as well.
      return { ...(outcome as CreateOutcome), iri: captured.iri };
    },
  });
  return {
    draft,
    canEdit: canEdit && view !== null,
    canCreate: mutation.canMutate && valid(draft),
    /**
     * The `context` is not a Context of the active connection's Pod, or not
     * the preset's: nothing is created there.
     */
    refused: explicit.refused,
    busy: mutation.busy,
    outcome: mutation.outcome,
    change: commands.change,
    create: commands.create,
    notice: {
      ...mutation.notice,
      onAcknowledge: () => {
        if (!mutation.checked()) return;
        // Absence is only an observation: the original write may still land.
        // Preserve its exact command/draft for an explicit create-only retry.
        const absent = mutation.absent();
        if (absent && command.current?.state === current.current)
          command.current.retry = true;
        mutation.acknowledge();
        if (!absent) reset();
      },
    },
  };
}

/**
 * App drafts survive row changes by default; choose `local` for drafts left by
 * row navigation, `connection` for a draft bound to an explicit Context, which
 * survives a Context selection, or `explicit` for a draft at an explicit
 * Context that also survives row navigation (see `LeaveGuard.scope`).
 */
export function useDraftGuard(
  dirty: boolean,
  discard: () => void,
  scope: 'local' | 'target' | 'connection' | 'explicit' = 'target',
) {
  const app = useController();
  const latest = useRef({ dirty, discard });
  latest.current = { dirty, discard };
  useEffect(
    () =>
      app.register({
        scope,
        dirty: () => latest.current.dirty,
        blocked: () => false,
        discard: () => latest.current.discard(),
      }),
    [app, scope],
  );
}
