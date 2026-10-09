import {
  useEffect,
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
  type CreateOutcome,
  type UpdateOutcome,
  type RemoveSnapshotOutcome,
} from '@sempods/client-sdk/edit';
import type { JsonLd } from '@sempods/client-sdk';
import { startupSettled } from '../authoring/app.js';
import { catalogueLists } from '../runtime/binding.js';
import {
  shallowEqual,
  useAppFacts,
  useAppState,
  useContextDemand,
  useController,
  useView,
  useWorkflowAccess,
} from './app.js';
import {
  changed,
  observeStarts,
  observeWrites,
  startCount,
  started,
  succeeded,
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
const loading = Object.freeze({ kind: 'loading' as const });
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
function useDefinition<T>(input: T, hook: string) {
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
 * Call `reload()` after changing what `read` returns.
 */
export function useLoad<T>(read: ViewRead<T>) {
  return useBoundLoad(useView(), read);
}
/**
 * Loads the active BoundPod using the same cancellable/bounded loader as useLoad.
 * Context/catalogue/label changes do not reload it. Changed Pod/session/grants
 * retire obsolete results; no catalogue or Context fallback is requested.
 * No reader means unavailable after startup completes or fails. Inline callbacks do not loop:
 * call reload after changing the query or other read inputs.
 */
export function usePodLoad<T>(read: PodRead<T>) {
  const { pod, startup, startupError } = useAppState();
  return useBoundLoad(
    pod,
    read,
    startupSettled({ startup, startupError }) ? unavailable : loading,
  );
}
function useBoundLoad<T, H extends BoundView | BoundPod>(
  view: H | null,
  read: (handle: H, signal: AbortSignal) => ReturnType<ViewRead<T>>,
  empty: LoadState<T> = loading,
) {
  const latest = useRef(read);
  latest.current = read;
  const [active, setActive] = useState<{
    view: H;
    loader: ReturnType<typeof createViewLoader<T, H>>;
  } | null>(null);
  useEffect(() => {
    if (!view) {
      setActive(null);
      return;
    }
    const loader = createViewLoader<T, H>(view, (target, signal) =>
      latest.current(target, signal),
    );
    setActive({ view, loader });
    void loader.reload();
    return () => loader.dispose();
  }, [view]);
  const loader = active?.view === view ? active.loader : null;
  const state: LoadState<T> = useSyncExternalStore(
    loader?.subscribe ?? noopSubscribe,
    loader?.getSnapshot ?? (() => empty),
    loader?.getSnapshot ?? (() => empty),
  );
  const reload = useCallback(async () => {
    await loader?.reload();
    return loader?.getSnapshot();
  }, [loader]);
  return {
    state,
    reload,
    cancel: () => loader?.cancel(),
  };
}
/** A typed list, refreshed after this bound target's own confirmed mutations. */
export function useList<D>(
  definition: FieldDefinition<D>,
  options: { readonly type?: string } = {},
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
  const load = useLoad(read);
  // Until the read for a changed definition or type has started, the rows on
  // screen belong to the previous definition and cannot be mutated with the
  // current one: report loading instead of offering them.
  const state: typeof load.state =
    load.state.kind === 'ready' && started.current !== listKey
      ? loading
      : load.state;
  const { reload } = load;
  // A real definition or type change reads again (the first read is the load's).
  const shown = useRef(read);
  useEffect(() => {
    if (shown.current === read) return;
    shown.current = read;
    void reload();
  }, [read, reload]);
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
  return {
    ...load,
    state,
    reload: () => {
      scope.cancelled = false;
      return reload();
    },
    cancel: () => {
      scope.cancelled = true;
      load.cancel();
    },
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
 * `open(target)` records the active connection and demands its catalogue, as
 * `TargetScreen` does; the editor needs no `TargetScreen`.
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
  const laneConnection = lane?.connection;
  const { activeId, ready, laneCatalogue } = useAppFacts(
    (s) => ({
      activeId: s.activeId,
      // No Context-bound editor before startup settles (a returning sign-in
      // may still replace the active connection), as for the selected view.
      // `pod` exists while the active connection is signed in.
      ready: startupSettled(s) && s.pod !== null,
      laneCatalogue: s.connections.find((c) => c.id === laneConnection)
        ?.catalogue,
    }),
    shallowEqual,
  );
  const binding = state?.binding ?? null;
  const bound = binding === 'refused' ? null : binding;
  const activated = state?.activated ?? false;
  const live = liveLane(state, activeId);
  // Only the originating connection may demand discovery for this target, and
  // only once the runtime accepted the binding: a refused target sends nothing.
  useContextDemand(live && bound !== null);
  const catalogue = live ? laneCatalogue : undefined;
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
export type MutationOutcome<D> =
  UpdateOutcome<D> | RemoveSnapshotOutcome<D> | CreateOutcome;
/** One mutation lane. Captures target/subject; stale completions never update a new lane. */
function useMutation<D>(definition: FieldDefinition<D>) {
  const view = useView();
  const app = useController();
  const access = useWorkflowAccess();
  const { key } = useDefinition(definition, 'useFieldUpdate');
  const current = useRef({
    view,
    key,
    pending: false,
    unresolved: false,
    checked: false,
    absent: false,
    iri: '',
    version: 0,
    uncertain: false,
    alive: true,
  });
  if (current.current.view !== view || current.current.key !== key) {
    const before = current.current;
    // N3: a new definition for the same target starts a new lane; a pending or
    // unresolved write of the old one loses its guard and feedback.
    if (before.view === view && (before.pending || before.unresolved))
      warn(
        'The field definition changed while a write was pending or unresolved; its guard and feedback were dropped.',
      );
    current.current = {
      view,
      key,
      pending: false,
      unresolved: false,
      checked: false,
      absent: false,
      iri: '',
      version: 0,
      uncertain: false,
      alive: true,
    };
  }
  const lane = current.current;
  const [state, setState] = useState<{
    lane: typeof lane;
    outcome: MutationOutcome<D> | null;
    operation: 'create' | 'update' | 'remove';
    busy: boolean;
    /** The target's start count at this lane's own start. */
    start: number;
  } | null>(null);
  const [evidence, setEvidence] = useState<{
    lane: typeof lane;
    version: number;
    value: D | null;
    /** Present, but the definition cannot read it. */
    unreadable: boolean;
  } | null>(null);
  useEffect(() => {
    lane.alive = true;
    const unregister = app.register({
      scope: 'target',
      unconfirmed: () => lane.uncertain,
      blocked: () => lane.pending,
      dirty: () => lane.unresolved,
      discard: () => {
        lane.unresolved = false;
        lane.uncertain = false;
        lane.version++;
        lane.checked = false;
        if (current.current === lane) setState(null);
      },
    });
    return () => {
      lane.alive = false;
      unregister();
    };
  }, [app, lane]);
  const starts = useStartCount(view);
  const visible = state?.lane === lane ? state : null;
  // Another write started on this target since this lane's own start retires
  // its success; failures and unresolved outcomes stay.
  const outcome =
    visible && !(succeeded(visible.outcome) && visible.start !== starts)
      ? visible.outcome
      : null;
  const eligible = () =>
    lane.alive && current.current === lane && app.getSnapshot().view === view;
  async function execute(
    operation: 'create' | 'update' | 'remove',
    iri: string,
    action: (target: BoundView) => Promise<MutationOutcome<D>>,
  ) {
    if (
      !view ||
      !eligible() ||
      lane.pending ||
      lane.unresolved ||
      !view.getSnapshot().write ||
      app.getSnapshot().changing ||
      app.getSnapshot().confirmingLeave
    )
      return;
    lane.version++;
    lane.pending = true;
    lane.checked = false;
    lane.iri = iri;
    const start = started(view);
    setState({ lane, operation, outcome: null, busy: true, start });
    let outcome: MutationOutcome<D>;
    try {
      outcome = await action(view);
    } catch {
      outcome =
        operation === 'create'
          ? { kind: 'not-created', reason: 'failure' }
          : operation === 'remove'
            ? { kind: 'not-removed', reason: 'failure' }
            : { kind: 'not-saved', reason: 'failure' };
    }
    lane.pending = false;
    if (!eligible()) return;
    lane.unresolved =
      outcome.kind === 'unconfirmed' || outcome.kind === 'changed-on-pod';
    lane.uncertain = outcome.kind === 'unconfirmed';
    setState({ lane, operation, outcome, busy: false, start });
    if (succeeded(outcome)) changed(view);
    return outcome;
  }
  const acknowledge = () => {
    if (!eligible() || lane.pending) return;
    lane.unresolved = false;
    lane.uncertain = false;
    lane.version++;
    lane.checked = false;
    setState(null);
  };
  const check = async () => {
    if (!view || !eligible() || !lane.unresolved) return false;
    lane.checked = false;
    setEvidence(null);
    const version = ++lane.version;
    try {
      const read = await view.subjects.get(lane.iri);
      if (!eligible() || !lane.unresolved || lane.version !== version)
        return false;
      if (read.kind !== 'ok' && read.kind !== 'not-found') return false;
      let value: D | null = null;
      let unreadable = false;
      if (read.kind === 'ok')
        try {
          value = definition.read(read.body);
        } catch {
          // Still evidence of presence: settling must not depend on mapping it.
          unreadable = true;
        }
      setEvidence({ lane, version, value, unreadable });
      lane.absent = read.kind === 'not-found';
      lane.checked = true;
      changed(view);
      return true;
    } catch {
      return false;
    }
  };
  return {
    execute,
    editable: () => eligible() && !lane.pending && !lane.unresolved,
    acknowledge,
    busy: visible?.busy ?? false,
    unresolved: lane.unresolved,
    canMutate: Boolean(
      view &&
      access.write &&
      eligible() &&
      !lane.pending &&
      !lane.unresolved &&
      !app.getSnapshot().changing &&
      !app.getSnapshot().confirmingLeave,
    ),
    outcome,
    operation: visible?.operation ?? null,
    notice: {
      outcome,
      current:
        evidence?.lane === lane &&
        evidence.version === lane.version &&
        !evidence.unreadable
          ? evidence.value
          : undefined,
      unreadable:
        evidence?.lane === lane &&
        evidence.version === lane.version &&
        evidence.unreadable,
      onCheck: check,
      onAcknowledge: () => {
        if (lane.checked) acknowledge();
      },
    },
    checked: () => eligible() && lane.checked,
    absent: () => eligible() && lane.checked && lane.absent,
  };
}
/**
 * Safe availability and standard recovery feedback for one-click row mutations.
 *
 * A success in `outcome`/`notice` retires when this hook or another creation,
 * row mutation or bound editor starts a write on the same target, and is not
 * shown if such a write started while it was pending. A failure
 * stays until this hook writes again; an unresolved outcome (`unconfirmed`,
 * `changed-on-pod`) stays until it is checked and acknowledged.
 */
export function useFieldUpdate<D>(input: FieldDefinition<D>) {
  // The same instance as useList's snapshots (see canonicalOf); the lane's
  // useDefinition below reports a changing custom definition.
  const definition = canonicalOf(input, definitionKey(input));
  const mutation = useMutation(definition);
  return {
    canMutate: mutation.canMutate,
    busy: mutation.busy,
    outcome: mutation.outcome,
    operation: mutation.operation,
    notice: mutation.notice,
    update: (snapshot: Snapshot<D>, change: Partial<D>) =>
      mutation.execute('update', snapshot.iri, (v) =>
        updateFields(v, snapshot, definition, change),
      ),
    remove: (snapshot: Snapshot<D>) =>
      mutation.execute('remove', snapshot.iri, (v) =>
        removeSnapshot(v, snapshot, definition),
      ),
    create: (
      ...args:
        | [iri: string, body: JsonLd]
        | [iri: string, definition: FieldDefinition<D>, draft: D]
    ) =>
      mutation.execute('create', args[0], (v) =>
        args.length === 3
          ? prepareCreation(v, args[0], args[1], args[2]).run()
          : prepareCreation(v, args[0], args[1]).run(),
      ),
    /** Explicit acknowledgement does not replay the command. Prefer notice for checked UI recovery. */
    acknowledge: mutation.acknowledge,
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
 */
export function useCreation<D extends object>(
  definition: FieldDefinition<D>,
  options: { readonly initial: D; readonly collection: string },
) {
  const view = useView();
  const { key } = useDefinition(definition, 'useCreation');
  const mutation = useMutation(definition);
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
  return {
    draft,
    canEdit,
    canCreate: mutation.canMutate && valid(draft),
    busy: mutation.busy,
    outcome: mutation.outcome,
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
     * Sends the current draft under its captured IRI. `undefined` either means
     * nothing was sent (no write access, an invalid draft, a pending or
     * unconfirmed command or a guarded transition; the draft is kept) or that
     * the target lifetime ended before the answer. In the second case the
     * write may have landed and its result is retired; the two cannot be told
     * apart here, so treat the item as possibly created.
     */
    create: async () => {
      if (
        !view ||
        !mutation.canMutate ||
        !valid(current.current.draft) ||
        current.current.view !== view
      )
        return;
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
      if (outcome?.kind === 'created' && current.current === submitted) reset();
      return outcome;
    },
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
 * row navigation, or `connection` for a draft bound to an explicit Context,
 * which survives a Context selection (see `LeaveGuard.scope`).
 */
export function useDraftGuard(
  dirty: boolean,
  discard: () => void,
  scope: 'local' | 'target' | 'connection' = 'target',
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
