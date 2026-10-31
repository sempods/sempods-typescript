import type { FieldDefinition } from '@sempods/client-sdk/edit';
import type { AppController } from './app.js';
import type { BoundView } from '../runtime/view.js';
import { notify, observeStarts, startCount } from './changes.js';
import { Lane, type LaneScope } from './lane.js';

/** At most this many settled, unguarded lanes stay per group for feedback. */
const SETTLED = 200;

export type { LaneScope } from './lane.js';

/**
 * Internal: the write lanes of one target and one definition, owned by the
 * app controller rather than a component. A lane's lifetime follows its
 * target: unmounting, hiding (`<Activity>`) or remounting a screen never
 * retires it, so a write that settles meanwhile keeps its outcome and its
 * leave guard. The group retires once its target no longer holds (another
 * selected view, an explicit view no longer current, or another active
 * connection); then its lanes never update again and their guards go.
 */
export class LaneGroup<D, L extends Lane<D> = Lane<D>> {
  readonly lanes = new Map<string, L>();
  private readonly guards = new Map<L, () => void>();
  private readonly listeners = new Set<() => void>();
  private readonly stops: (() => void)[] = [];
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
    /** The groups of this scope and key across views (see `LaneChannel`). */
    private readonly channel: LaneChannel,
    /** Leaves the store's lookup once it retired. */
    private readonly drop: () => void,
    /** The kind of lane this group holds (`Lane`, or `CreationLane`). */
    private readonly make: LaneKind<D, L>,
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
    // A write that settled may bring the group over its bound.
    this.evict();
    notify([...this.listeners]);
    this.channel.changed();
  };
  /**
   * Whether a resource without a lane of its own could be written now, given
   * the target's write access (`Lane.canMutate` for one with a lane).
   */
  available(writable: boolean) {
    const app = this.app.getSnapshot();
    return writable && this.holds() && !app.changing && !app.confirmingLeave;
  }

  /**
   * The lane of one resource, created by a command (never while rendering).
   * Its guard is registered once and stays until the lane is evicted or the
   * group retires; an idle lane's guard asks about nothing.
   */
  lane(iri: string): L {
    let lane = this.lanes.get(iri);
    if (lane) {
      // Most recently written last, for eviction.
      this.lanes.delete(iri);
      this.lanes.set(iri, lane);
      return lane;
    }
    if (this.stops.length === 0) this.start();
    lane = new this.make(
      this.view,
      this.definition,
      this.app,
      () => this.holds(),
      this.changed,
    );
    this.lanes.set(iri, lane);
    this.guards.set(
      lane,
      this.app.register({
        ...lane.guard(this.scope),
        subscribe: this.subscribe,
      }),
    );
    this.evict();
    return lane;
  }

  /** Drops the oldest settled, unguarded lanes beyond the bound: feedback only. */
  private evict() {
    if (this.lanes.size <= SETTLED) return;
    let settled = [...this.lanes.values()].filter(
      (lane) => !lane.outstanding(),
    ).length;
    for (const [iri, lane] of this.lanes) {
      if (settled <= SETTLED) break;
      if (lane.outstanding()) continue;
      this.lanes.delete(iri);
      this.guards.get(lane)?.();
      this.guards.delete(lane);
      settled--;
    }
  }

  /**
   * Follows its target, its read access and the writes started on it (which
   * retire a shown success) while it has lanes.
   */
  private start() {
    this.channel.groups.add(this as unknown as LaneGroup<unknown>);
    this.readable = this.view.getSnapshot().read;
    let starts = startCount(this.view);
    const follow = () => {
      if (!this.holds()) return this.retire();
      const readable = this.view.getSnapshot().read;
      const lost = this.readable && !readable;
      this.readable = readable;
      if (!lost) return;
      this.lanes.forEach((lane) => lane.loseRead());
      this.changed();
    };
    this.stops.push(
      this.app.subscribe(follow),
      this.view.subscribe(follow),
      observeStarts(this.view, () => {
        const before = starts;
        starts = startCount(this.view);
        // Only a success shown until now changes: it retires.
        if ([...this.lanes.values()].some((lane) => lane.showsSuccess(before)))
          this.changed();
      }),
    );
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
    this.channel.groups.delete(this as unknown as LaneGroup<unknown>);
    this.drop();
    return true;
  }
}

/** A lane class; one group key always holds one kind. */
export type LaneKind<D, L extends Lane<D>> = new (
  ...args: ConstructorParameters<typeof Lane<D>>
) => L;

/**
 * Internal: the started groups of one scope and key across views, for a hook
 * writing to many targets (one group per Context): it subscribes once and is
 * told about every lane change of each. Groups leave when they retire, so
 * nothing here keeps a replaced view alive.
 */
export class LaneChannel {
  readonly groups = new Set<LaneGroup<unknown>>();
  private readonly listeners = new Set<() => void>();
  private version = 0;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly getVersion = () => this.version;
  changed() {
    this.version++;
    notify([...this.listeners]);
  }
  /** Its groups whose target still holds. */
  held<D>(): readonly LaneGroup<D>[] {
    return [...this.groups].filter((group) =>
      group.holds(),
    ) as unknown as LaneGroup<D>[];
  }
}

/** Internal: the lane groups of one controller, by view, scope and definition. */
export interface LaneStore {
  group<D, L extends Lane<D> = Lane<D>>(
    view: BoundView,
    key: string,
    definition: FieldDefinition<D>,
    scope: LaneScope,
    kind?: LaneKind<D, L>,
  ): LaneGroup<D, L>;
  /** The started groups of one scope and key across views. */
  channel(key: string, scope: LaneScope): LaneChannel;
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
  const groups = new WeakMap<
    BoundView,
    Map<string, LaneGroup<unknown, Lane<unknown>>>
  >();
  const channels = new Map<string, LaneChannel>();
  const channel = (name: string) => {
    let found = channels.get(name);
    if (!found) channels.set(name, (found = new LaneChannel()));
    return found;
  };
  store = {
    group<D, L extends Lane<D> = Lane<D>>(
      view: BoundView,
      key: string,
      definition: FieldDefinition<D>,
      scope: LaneScope,
      kind: LaneKind<D, L> = Lane as unknown as LaneKind<D, L>,
    ) {
      let byKey = groups.get(view);
      if (!byKey) groups.set(view, (byKey = new Map()));
      const name = `${scope} ${key}`;
      const known = byKey.get(name) as LaneGroup<D, L> | undefined;
      if (known?.holds()) return known;
      // Its target changed before it noticed (it follows only with lanes).
      known?.expire();
      const group: LaneGroup<D, L> = new LaneGroup(
        view,
        definition,
        app,
        scope,
        app.getSnapshot().activeId,
        channel(name),
        () => {
          if (byKey.get(name) === group) byKey.delete(name);
        },
        kind,
      );
      byKey.set(name, group as unknown as LaneGroup<unknown, Lane<unknown>>);
      return group;
    },
    channel: (key: string, scope: LaneScope) => channel(`${scope} ${key}`),
  };
  stores.set(app, store);
  return store;
}
