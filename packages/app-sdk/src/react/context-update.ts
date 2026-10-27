import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useSyncExternalStore,
} from 'react';
import {
  removeSnapshot,
  updateFields,
  type FieldDefinition,
  type RemoveSnapshotOutcome,
  type Snapshot,
  type UpdateOutcome,
} from '@sempods/client-sdk/edit';
import { RuntimeError, type BoundView } from '../index.js';
import { startCount } from '../authoring/changes.js';
import {
  contextProblem,
  type ContextEditorProblem,
} from '../authoring/contexts.js';
import {
  changedData,
  notSent,
  spentData,
  type MutationOutcome,
  type NotSent,
} from '../authoring/lane.js';
import { lanesOf, type LaneGroup } from '../authoring/lanes.js';
import {
  activeCatalogue,
  shallowEqual,
  useAppFacts,
  useContextDiscovery,
  useController,
  useWriteGate,
} from './app.js';
import {
  laneState,
  useCommandToken,
  useDefinition,
  type FieldUpdateRow,
  type FieldUpdateState,
} from './hooks.js';
import type { PodListItem } from './pod-list.js';

/** A resource in its own Context, as `useContextUpdate().unresolved` lists it. */
export interface ContextResource {
  readonly context: string;
  readonly iri: string;
}
/** One resource of `useContextUpdate`, from `for({ context, iri })`. */
export interface ContextUpdateState<D> extends FieldUpdateState<D> {
  readonly context: string;
  /** Why its Context is not available here; texts: `contextProblems`. */
  readonly problem: ContextEditorProblem | null;
}
/** One overview row of `useContextUpdate`, from `for(item)`. */
export interface ContextUpdateRow<D>
  extends ContextUpdateState<D>, FieldUpdateRow<D> {}

/** A row's Context of the active connection, as a row reads it. */
interface Target<D> {
  readonly view: BoundView | null;
  readonly group: LaneGroup<D> | null;
  readonly problem: ContextEditorProblem | null;
  /** The view's write access as this render read it. */
  readonly write: boolean;
  readonly writable: boolean;
}
/**
 * The Context's view of the active connection (cached by the runtime: the same
 * view `usePodList` read the rows from), `'refused'` for a configuration
 * refusal, `null` while there is none.
 */
function bindOrRefuse(
  app: ReturnType<typeof useController>,
  activeId: string | null,
  context: string,
): BoundView | 'refused' | null {
  if (!activeId) return null;
  try {
    return app.runtime.bindContext(activeId, context);
  } catch (error) {
    if (!(error instanceof RuntimeError)) throw error;
    return error.problem === 'configuration' ? 'refused' : null;
  }
}

/**
 * One-click updates and removals of overview rows, each in its own Context:
 * the write half of `usePodList`, as `useFieldUpdate` is for `useList`.
 * `const row = overview.for(item)` gives a row its `data`, `canMutate`,
 * `notice`, `problem` and `update(change)` / `remove()`, with exactly the row
 * semantics of `useFieldUpdate` (snapshot evidence, `changed-on-pod`,
 * `unconfirmed` with check and acknowledgement, a spent snapshot). The SDK
 * binds each Context, asks for the catalogue and knows the write rights; the
 * selected Context and its drafts stay as they are.
 *
 * Each resource has its own write lane, owned by the app controller per
 * Context, so rows in several Contexts can be written at once, and an
 * unresolved write stays (with its check, acknowledgement and leave guard)
 * while its row is not rendered or the screen is hidden. `unresolved` lists
 * them; `for({ context, iri })` gives the `notice` of one whose row is gone
 * (`<UnresolvedNotices of={overview} shown={list.data?.items} />`). Another
 * active connection retires them. Pass the same definition as to `usePodList`.
 */
export function useContextUpdate<D>(input: FieldDefinition<D>) {
  const { key, definition } = useDefinition(input, 'useContextUpdate');
  const app = useController();
  useContextDiscovery(true);
  const { activeId, catalogue } = useAppFacts(activeCatalogue, shallowEqual);
  // Row availability reads the guarded-change state while rendering.
  useWriteGate();
  const store = lanesOf(app);
  const name = `rows ${key}`;
  const channel = store.channel(name, 'explicit');
  const changes = useSyncExternalStore(
    channel.subscribe,
    channel.getVersion,
    channel.getVersion,
  );
  // Commands start only while this screen is shown, for this connection and
  // definition; one kept from an earlier one never again.
  const shown = useCommandToken(activeId, key);

  // What a row needs of its Context, once per Context and render.
  const contexts = new Map<string, Target<D>>();
  const target = (context: string): Target<D> => {
    let found = contexts.get(context);
    if (found) return found;
    const view = bindOrRefuse(app, activeId, context);
    const bound = view && view !== 'refused' ? view : null;
    const problem = contextProblem(catalogue, context, view === 'refused');
    const write = Boolean(bound?.getSnapshot().write);
    found = {
      view: bound,
      group: bound ? store.group(bound, name, definition, 'explicit') : null,
      problem,
      write,
      writable: write && problem === null,
    };
    contexts.set(context, found);
    return found;
  };
  // Write access lives in each Context's view: render again when one of the
  // views this render's rows read changes (rows are read after this hook, so
  // their Contexts are known once it commits).
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const subscribed = useRef(new Map<BoundView, () => void>());
  useEffect(() => {
    const read = [...contexts.values()];
    const want = new Set(read.flatMap((c) => (c.view ? [c.view] : [])));
    for (const [view, stop] of subscribed.current)
      if (!want.has(view)) {
        stop();
        subscribed.current.delete(view);
      }
    for (const view of want)
      if (!subscribed.current.has(view))
        subscribed.current.set(view, view.subscribe(rerender));
    // Changed between rendering and subscribing.
    if (read.some((c) => c.view && c.write !== c.view.getSnapshot().write))
      rerender();
  });
  useEffect(() => {
    const own = subscribed.current;
    return () => {
      own.forEach((stop) => stop());
      own.clear();
    };
  }, []);

  const run = (
    context: string,
    iri: string,
    operation: 'update' | 'remove',
    action: (target: BoundView) => Promise<MutationOutcome<D>>,
    subject: Snapshot<D>,
    after?: D,
  ): Promise<MutationOutcome<D> | NotSent> => {
    if (!shown.current) return Promise.resolve(notSent('ended'));
    const view = bindOrRefuse(app, activeId, context);
    if (!view || view === 'refused')
      return Promise.resolve(notSent('unavailable'));
    // A refused write sends nothing and keeps the resource's recovery.
    return store
      .group(view, name, definition, 'explicit')
      .lane(iri)
      .execute(operation, iri, action, subject, after);
  };

  function rowFor(item: PodListItem<D>): ContextUpdateRow<D>;
  function rowFor(item: ContextResource): ContextUpdateState<D>;
  function rowFor(
    item: PodListItem<D> | ContextResource,
  ): ContextUpdateState<D> | ContextUpdateRow<D> {
    const { context } = item;
    const snapshot = 'snapshot' in item ? item.snapshot : undefined;
    const iri = 'snapshot' in item ? item.snapshot.iri : item.iri;
    const { view, group, problem, writable } = target(context);
    const state: ContextUpdateState<D> = {
      context,
      problem,
      ...laneState<D>(
        group?.lanes.get(iri),
        writable,
        Boolean(group?.available(writable)),
        view ? startCount(view) : 0,
        snapshot,
      ),
    };
    if (!snapshot) return state;
    return {
      ...state,
      // A confirmed update shows at once, until the list reads it again.
      data: spentData<D>(snapshot) ?? snapshot.data,
      update: (change: Partial<D>) =>
        run(
          context,
          iri,
          'update',
          (v) => updateFields(v, snapshot, definition, change),
          snapshot,
          changedData(snapshot.data, change),
        ) as Promise<UpdateOutcome<D> | NotSent>,
      remove: () =>
        run(
          context,
          iri,
          'remove',
          (v) => removeSnapshot(v, snapshot, definition),
          snapshot,
        ) as Promise<RemoveSnapshotOutcome<D> | NotSent>,
    } satisfies ContextUpdateRow<D>;
  }
  // Stable between lane changes, so it fits effect dependencies.
  const unresolved = useMemo(
    () =>
      channel.held<D>().flatMap((group) =>
        [...group.lanes.values()]
          .filter((lane) => lane.unresolved)
          .map((lane): ContextResource => ({
            context: group.view.contextIri,
            iri: lane.iri,
          })),
      ),
    // `changes` moves with every lane change of these groups.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [channel, changes, activeId],
  );
  return {
    /**
     * One overview row: whether it may be written now, its notice, why its
     * Context is not available (`problem`), what to show and its commands.
     * Other rows' writes do not lock it. `{ context, iri }` alone gives
     * `canMutate`, `notice` and `problem`, for a resource whose row is gone.
     */
    for: rowFor,
    /**
     * Resources whose write is unconfirmed or changed on the Pod, until
     * checked and acknowledged, across Contexts of the active connection.
     */
    unresolved,
  };
}
/** What `useContextUpdate` returns. */
export type ContextUpdate<D> = ReturnType<typeof useContextUpdate<D>>;
