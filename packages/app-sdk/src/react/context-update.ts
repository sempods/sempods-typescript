import { useCallback, useMemo, useSyncExternalStore } from 'react';
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
  isSpent,
  notSent,
  spentData,
  type MutationOutcome,
  type NotSent,
} from '../authoring/lane.js';
import { lanesOf } from '../authoring/lanes.js';
import {
  shallowEqual,
  useAppFacts,
  useContextDiscovery,
  useController,
} from './app.js';
import {
  noNotice,
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
  const { activeId, catalogue } = useAppFacts((s) => {
    const connection = s.connections.find((c) => c.id === s.activeId);
    const active =
      connection?.session.kind === 'active' ||
      connection?.session.kind === 'renewing';
    return {
      activeId: active ? connection.id : null,
      catalogue: active ? connection.catalogue : undefined,
      // Row availability waits for a guarded change or its prompt; render
      // again once it ends.
      changing: s.changing,
      confirmingLeave: s.confirmingLeave,
    };
  }, shallowEqual);
  const store = lanesOf(app);
  const name = `rows ${key}`;
  const watch = useCallback(
    (listener: () => void) => store.watch(name, 'explicit', listener),
    [store, name],
  );
  const version = () => store.version(name, 'explicit');
  const changes = useSyncExternalStore(watch, version, version);
  // Commands start only while this screen is shown, for this connection and
  // definition; one kept from an earlier one never again.
  const shown = useCommandToken(activeId, key);

  /** The Context's view of the active connection, or why there is none. */
  const bind = (context: string): BoundView | 'refused' | null => {
    if (!activeId) return null;
    try {
      // Cached by the runtime: the same view `usePodList` read the rows from.
      return app.runtime.bindContext(activeId, context);
    } catch (error) {
      if (!(error instanceof RuntimeError)) throw error;
      return error.problem === 'configuration' ? 'refused' : null;
    }
  };
  const groupOf = (view: BoundView) =>
    store.group(view, name, definition, 'explicit');
  const run = (
    context: string,
    iri: string,
    operation: 'update' | 'remove',
    action: (target: BoundView) => Promise<MutationOutcome<D>>,
    subject: Snapshot<D>,
    after?: D,
  ): Promise<MutationOutcome<D> | NotSent> => {
    if (!shown.current) return Promise.resolve(notSent('ended'));
    const view = bind(context);
    if (!view || view === 'refused')
      return Promise.resolve(notSent('unavailable'));
    const lane = groupOf(view).lane(iri);
    // A refused write sends nothing and keeps the resource's recovery.
    const refused = lane.refusal(subject);
    if (refused) return Promise.resolve(notSent(refused));
    return lane.execute(operation, iri, action, subject, after);
  };

  function rowFor(item: PodListItem<D>): ContextUpdateRow<D>;
  function rowFor(item: ContextResource): ContextUpdateState<D>;
  function rowFor(
    item: PodListItem<D> | ContextResource,
  ): ContextUpdateState<D> | ContextUpdateRow<D> {
    const { context } = item;
    const snapshot = 'snapshot' in item ? item.snapshot : undefined;
    const iri = snapshot ? snapshot.iri : (item as ContextResource).iri;
    const view = bind(context);
    const bound = view && view !== 'refused' ? view : null;
    const group = bound ? groupOf(bound) : null;
    const lane = group?.lanes.get(iri);
    const problem = contextProblem(catalogue, context, view === 'refused');
    const writable = Boolean(bound?.getSnapshot().write) && problem === null;
    const state: ContextUpdateState<D> = {
      context,
      problem,
      canMutate: lane
        ? lane.canMutate(writable, snapshot)
        : // A spent snapshot stays locked, also once its lane was evicted.
          Boolean(group?.available(writable)) &&
          !(snapshot && isSpent(snapshot)),
      notice: lane && bound ? lane.notice(startCount(bound)) : noNotice,
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
          {
            ...snapshot.data,
            ...Object.fromEntries(
              Object.entries(change).filter(([, value]) => value !== undefined),
            ),
          },
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
      store.groups<D>(name, 'explicit').flatMap((group) =>
        [...group.lanes.values()]
          .filter((lane) => lane.unresolved)
          .map((lane): ContextResource => ({
            context: group.view.contextIri,
            iri: lane.iri,
          })),
      ),
    // `changes` moves with every lane change of these groups.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, name, changes, activeId],
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
