import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
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
  shownTimestamps,
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
  /**
   * The connection it was read from, for a row bound to it (#408); absent for
   * a row of the active connection.
   */
  readonly connection?: string;
  readonly context: string;
  readonly iri: string;
}
/**
 * An overview item as `useContextUpdate().for` takes it: a `usePodList` item
 * of the active connection, or with `connection` a row read from that
 * connection's Context, for example with `listSubjects` through
 * `runtime.bindContext(connection, context)`.
 */
export interface ContextUpdateItem<D> extends PodListItem<D> {
  readonly connection?: string;
}
/** One resource of `useContextUpdate`, from `for({ context, iri })`. */
export interface ContextUpdateState<D> extends FieldUpdateState<D> {
  /** Set for a row bound to its own connection (`for({ connection, … })`). */
  readonly connection?: string;
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
  readonly writable: boolean;
}
/**
 * The Context's view of a connection (cached by the runtime: the same view
 * `usePodList` read the rows from), `'refused'` for a configuration
 * refusal, `null` while there is none.
 */
function bindOrRefuse(
  app: ReturnType<typeof useController>,
  connection: string | null,
  context: string,
): BoundView | 'refused' | null {
  if (!connection) return null;
  try {
    return app.runtime.bindContext(connection, context);
  } catch (error) {
    if (!(error instanceof RuntimeError)) throw error;
    return error.problem === 'configuration' ? 'refused' : null;
  }
}
/** Whether a connection reads (signed in, or without a token): it can bind. */
function reads(app: ReturnType<typeof useController>, id: string) {
  return Boolean(
    app.getSnapshot().connections.find((c) => c.id === id)?.reading,
  );
}
/** A reading connection's catalogue, as `activeCatalogue` gives the active one's. */
function catalogueOf(app: ReturnType<typeof useController>, id: string) {
  const connection = app.getSnapshot().connections.find((c) => c.id === id);
  return connection?.reading ? connection.catalogue : undefined;
}
const sameList = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length === b.length && a.every((value, i) => Object.is(value, b[i]));

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
 *
 * An overview across connected Pods (#408) passes each row's `connection`
 * (`for({ connection, context, snapshot })`): the row is then written in
 * that connection's Context whether or not it is active, without selecting
 * it or changing a creation's destination. Its lane, its recovery and its
 * leave guard stay with that connection: another active connection neither
 * retires nor asks about them, while connection actions on that connection
 * (sign-in, sign-out, forget) ask first, and a new authorization of it
 * retires them as for the active one. Its `unresolved` entry carries the
 * `connection`, so the same subject in two Pods stays two resources. Write a
 * resource through one form only: a row with and without `connection` has
 * separate lanes.
 */
export function useContextUpdate<D>(input: FieldDefinition<D>) {
  const { key, definition } = useDefinition(input, 'useContextUpdate');
  const app = useController();
  useContextDiscovery(true);
  const { activeId, catalogue } = useAppFacts(activeCatalogue, shallowEqual);
  // A view's write access follows its connection's facts (catalogue, scopes,
  // authorization): render again with any of them, also for rows rendered by
  // their own components.
  useAppFacts((s) => s.connections.find((c) => c.id === s.activeId));
  // A new authorization replaces the views the rows were read from.
  const pod = useAppFacts((s) => s.pod);
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
  // Rows bound to their own connection (`connection`), in their own groups.
  const originName = `origin rows ${key}`;
  const originChannel = store.channel(originName, 'explicit');
  const originChanges = useSyncExternalStore(
    originChannel.subscribe,
    originChannel.getVersion,
    originChannel.getVersion,
  );
  // Commands start only while this screen is shown, for this connection, its
  // authorization and definition; one kept from an earlier one never again.
  const shown = useCommandToken(activeId, pod, key);
  // An origin-bound row's group carries its own connection's lifetime: only
  // the screen and the definition end its commands here.
  const originShown = useCommandToken(key);
  // The connections rows were bound to while rendering, also by a row's own
  // component: their facts (catalogue, session, scopes) render again, as the
  // active one's do. It only grows, up to the connections there are.
  const origins = useRef(new Set<string>()).current;
  useAppFacts(
    (s) => [...origins].map((id) => s.connections.find((c) => c.id === id)),
    sameList,
  );
  // Under `on-demand`, each of them asks for its own catalogue once known
  // without one (`required` loads every connection's).
  const undiscovered = useAppFacts((s) =>
    s.contextSelection === 'on-demand'
      ? [...origins]
          .filter((id) => {
            const c = s.connections.find((entry) => entry.id === id);
            return c?.reading && c.catalogue.kind === 'unknown';
          })
          .join(' ')
      : '',
  );
  useEffect(() => {
    for (const id of undiscovered ? undiscovered.split(' ') : [])
      void app.runtime.loadContexts(id).catch(() => {});
  }, [app, undiscovered]);

  // What a row needs of its Context, once per connection, Context and render.
  const contexts = new Map<string, Target<D>>();
  const target = (context: string, origin?: string): Target<D> => {
    const cached = `${origin ?? ''}\n${context}`;
    let found = contexts.get(cached);
    if (found) return found;
    if (origin !== undefined) origins.add(origin);
    // Without a current view (a session that ended), writes kept for their
    // recovery are found through their own view (`keepsWork`).
    const view =
      origin === undefined
        ? (bindOrRefuse(app, activeId, context) ??
          store.kept(name, 'explicit', context) ??
          null)
        : ((reads(app, origin) ? bindOrRefuse(app, origin, context) : null) ??
          store.kept(originName, 'explicit', context, origin) ??
          null);
    const bound = view && view !== 'refused' ? view : null;
    const problem = contextProblem(
      origin === undefined ? catalogue : catalogueOf(app, origin),
      context,
      view === 'refused',
    );
    found = {
      view: bound,
      group: bound
        ? origin === undefined
          ? store.group(bound, name, definition, 'explicit')
          : store.group(
              bound,
              originName,
              definition,
              'explicit',
              undefined,
              origin,
            )
        : null,
      problem,
      writable: Boolean(bound?.getSnapshot().write) && problem === null,
    };
    contexts.set(cached, found);
    return found;
  };
  // Through the group the row was rendered with: its own lifetime check
  // ends a command kept past another connection or target, also before this
  // screen renders again (never a fresh lookup for the connection now).
  const run = (
    token: { readonly current: boolean },
    group: LaneGroup<D> | null,
    iri: string,
    operation: 'update' | 'remove',
    action: (target: BoundView) => Promise<MutationOutcome<D>>,
    subject?: Snapshot<D>,
    after?: D,
  ): Promise<MutationOutcome<D> | NotSent> => {
    if (!token.current || (group && !group.holds()))
      return Promise.resolve(notSent('ended'));
    if (!group) return Promise.resolve(notSent('unavailable'));
    // A refused write sends nothing and keeps the resource's recovery.
    return group.lane(iri).execute(operation, iri, action, subject, after);
  };

  function rowFor(item: ContextUpdateItem<D>): ContextUpdateRow<D>;
  function rowFor(item: ContextResource): ContextUpdateState<D>;
  function rowFor(
    item: ContextUpdateItem<D> | ContextResource,
  ): ContextUpdateState<D> | ContextUpdateRow<D> {
    const { context, connection } = item;
    const snapshot = 'snapshot' in item ? item.snapshot : undefined;
    const iri = 'snapshot' in item ? item.snapshot.iri : item.iri;
    const { view, group, problem, writable } = target(context, connection);
    const token = connection === undefined ? shown : originShown;
    const own = laneState<D>(
      group?.lanes.get(iri),
      writable,
      Boolean(group?.available(writable)),
      view ? startCount(view) : 0,
      snapshot,
    );
    // Without a snapshot there is nothing to write from: recovery only.
    const state: ContextUpdateState<D> = {
      ...(connection !== undefined ? { connection } : {}),
      context,
      problem,
      notice: own.notice,
      canMutate: snapshot ? own.canMutate : false,
    };
    if (!snapshot) return state;
    return {
      ...state,
      // A confirmed update shows at once, until the list reads it again.
      data: spentData<D>(snapshot) ?? snapshot.data,
      timestamps: shownTimestamps(snapshot),
      update: (change: Partial<D>) =>
        run(
          token,
          group,
          iri,
          'update',
          (v) => updateFields(v, snapshot, definition, change),
          snapshot,
          changedData(snapshot.data, change),
        ) as Promise<UpdateOutcome<D> | NotSent>,
      remove: () =>
        run(token, group, iri, 'remove', (v) =>
          removeSnapshot(v, snapshot, definition),
        ) as Promise<RemoveSnapshotOutcome<D> | NotSent>,
    } satisfies ContextUpdateRow<D>;
  }
  // Stable between lane changes, so it fits effect dependencies.
  const unresolved = useMemo(
    () => [
      ...channel.held<D>().flatMap((group) =>
        [...group.lanes.values()]
          .filter((lane) => lane.unresolved)
          .map((lane): ContextResource => ({
            context: group.view.contextIri,
            iri: lane.iri,
          })),
      ),
      ...originChannel.held<D>().flatMap((group) =>
        [...group.lanes.values()]
          .filter((lane) => lane.unresolved)
          .map((lane): ContextResource => ({
            connection: group.connection!,
            context: group.view.contextIri,
            iri: lane.iri,
          })),
      ),
    ],
    // `changes` and `originChanges` move with every lane change of these
    // groups; `activeId` with the groups of the active connection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [channel, changes, originChannel, originChanges, activeId],
  );
  return {
    /**
     * One overview row: whether it may be written now, its notice, why its
     * Context is not available (`problem`), what to show and its commands.
     * Other rows' writes do not lock it. `{ context, iri }` alone gives the
     * `notice` and `problem` of a resource whose row is gone; `canMutate`
     * stays false there, as there is no snapshot to write from.
     */
    for: rowFor,
    /**
     * Resources whose write is unconfirmed or changed on the Pod, until
     * checked and acknowledged, across Contexts of the active connection,
     * then those of rows bound to their own connection (with `connection`).
     */
    unresolved,
  };
}
/** What `useContextUpdate` returns. */
export type ContextUpdate<D> = ReturnType<typeof useContextUpdate<D>>;
