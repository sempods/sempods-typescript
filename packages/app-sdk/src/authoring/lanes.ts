import type { FieldDefinition } from '@sempods/client-sdk/edit';
import type { AppController } from './app.js';
import type { BoundView } from '../runtime/view.js';
import { Lane } from './lane.js';

/** At most this many settled, unguarded lanes stay per group for feedback. */
const SETTLED = 200;

/** Which guarded changes leave a group's lanes (see `LeaveGuard.scope`). */
export type LaneScope = 'target' | 'explicit';

/**
 * Internal: the write lanes of one target and one definition, owned by the
 * app controller rather than a component. A lane's lifetime follows its
 * target: unmounting, hiding (`<Activity>`) or remounting a screen never
 * retires it, so a write that settles meanwhile keeps its outcome and its
 * leave guard. The group retires once its target no longer holds (another
 * selected view, an explicit view no longer current, or another active
 * connection); then its lanes never update again and their guards go.
 */
export class LaneGroup<D> {
  readonly lanes = new Map<string, Lane<D>>();
  private readonly guards = new Map<Lane<D>, () => void>();
  private readonly listeners = new Set<() => void>();
  private readonly stops: (() => void)[] = [];
  /** Lanes a mounted, shown form currently claims, with a count per key. */
  private readonly owners = new Map<string, number>();
  private version = 0;
  private alive = true;
  private readable = false;

  constructor(
    readonly view: BoundView,
    private readonly definition: FieldDefinition<D>,
    private readonly app: AppController,
    readonly scope: LaneScope,
    /** The connection the group was created for. */
    private readonly connection: string | null,
    private readonly drop: () => void,
  ) {}

  /** Whether its target is still the one its lanes write to. */
  holds() {
    if (!this.alive) return false;
    const snapshot = this.app.getSnapshot();
    if (snapshot.activeId !== this.connection) return false;
    return this.scope === 'target'
      ? snapshot.view === this.view
      : Boolean(this.view.getSnapshot().current);
  }
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  /** Changes with every lane change, for `useSyncExternalStore`. */
  readonly getVersion = () => this.version;
  private readonly changed = () => {
    this.version++;
    for (const listener of [...this.listeners]) listener();
  };

  /**
   * The lane of one resource, created by a command (never while rendering).
   * Its guard is registered once and stays until the lane is evicted or the
   * group retires; an idle lane's guard asks about nothing.
   */
  lane(iri: string): Lane<D> {
    let lane = this.lanes.get(iri);
    if (lane) {
      // Most recently written last, for eviction.
      this.lanes.delete(iri);
      this.lanes.set(iri, lane);
      return lane;
    }
    if (this.stops.length === 0) this.start();
    lane = new Lane(
      this.view,
      this.definition,
      this.app,
      () => this.holds(),
      this.changed,
    );
    this.lanes.set(iri, lane);
    this.guards.set(lane, this.app.register(lane.guard(this.scope)));
    this.evict();
    return lane;
  }

  /** A mounted, shown form claims its lane; returns the release. */
  own(key: string) {
    this.owners.set(key, (this.owners.get(key) ?? 0) + 1);
    return () => {
      const count = (this.owners.get(key) ?? 1) - 1;
      if (count > 0) this.owners.set(key, count);
      else this.owners.delete(key);
    };
  }
  /**
   * A pending or unresolved lane whose key starts with `prefix` and that no
   * mounted form claims: what an earlier mount of a form left behind, for a
   * remounted form to take over (check, acknowledge), never to resend.
   */
  orphan(prefix: string): string | null {
    for (const [key, lane] of this.lanes)
      if (
        key.startsWith(prefix) &&
        !this.owners.has(key) &&
        (lane.pending || lane.unresolved)
      )
        return key;
    return null;
  }

  /** Drops the oldest settled, unguarded lanes beyond the bound: feedback only. */
  private evict() {
    let settled = [...this.lanes.values()].filter(
      (lane) => !lane.pending && !lane.unresolved,
    ).length;
    for (const [iri, lane] of this.lanes) {
      if (settled <= SETTLED) break;
      if (lane.pending || lane.unresolved) continue;
      this.lanes.delete(iri);
      this.guards.get(lane)?.();
      this.guards.delete(lane);
      settled--;
    }
  }

  /** Follows its target and its read access while it has lanes. */
  private start() {
    this.readable = this.view.getSnapshot().read;
    const follow = () => {
      if (!this.holds()) return this.retire();
      const readable = this.view.getSnapshot().read;
      if (this.readable && !readable)
        this.lanes.forEach((lane) => lane.loseRead());
      this.readable = readable;
    };
    this.stops.push(this.app.subscribe(follow), this.view.subscribe(follow));
  }

  /** Its target no longer holds: lanes never update again, guards go. */
  retire() {
    if (!this.expire()) return;
    this.changed();
  }
  /**
   * Like `retire`, without notifying: for a lookup while rendering, which
   * meets only groups without lanes (those follow their target themselves).
   */
  expire() {
    if (!this.alive) return false;
    this.alive = false;
    this.lanes.forEach((lane) => lane.retire());
    this.guards.forEach((unregister) => unregister());
    this.guards.clear();
    this.stops.splice(0).forEach((stop) => stop());
    this.drop();
    return true;
  }
}

/** Internal: the lane groups of one controller, by view, scope and definition. */
export interface LaneStore {
  group<D>(
    view: BoundView,
    key: string,
    definition: FieldDefinition<D>,
    scope: LaneScope,
  ): LaneGroup<D>;
}

const stores = new WeakMap<AppController, LaneStore>();
/**
 * The lane store of a controller. Groups are kept per view object, so a view
 * the runtime replaced is collected with its groups; a retired group leaves
 * the store and the next lookup starts a fresh one.
 */
export function lanesOf(app: AppController): LaneStore {
  let store = stores.get(app);
  if (store) return store;
  const groups = new WeakMap<BoundView, Map<string, LaneGroup<unknown>>>();
  store = {
    group<D>(
      view: BoundView,
      key: string,
      definition: FieldDefinition<D>,
      scope: LaneScope,
    ) {
      let byKey = groups.get(view);
      if (!byKey) groups.set(view, (byKey = new Map()));
      const name = `${scope} ${key}`;
      const known = byKey.get(name) as LaneGroup<D> | undefined;
      if (known?.holds()) return known;
      // Its target changed before it noticed (it follows only with lanes).
      known?.expire();
      const group: LaneGroup<D> = new LaneGroup(
        view,
        definition,
        app,
        scope,
        app.getSnapshot().activeId,
        () => {
          if (byKey.get(name) === group) byKey.delete(name);
        },
      );
      byKey.set(name, group as LaneGroup<unknown>);
      return group;
    },
  };
  stores.set(app, store);
  return store;
}
