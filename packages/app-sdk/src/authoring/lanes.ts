import type { FieldDefinition } from '@sempods/client-sdk/edit';
import type { AppController } from './app.js';
import type { BoundView } from '../runtime/view.js';
import { notify, observeStarts } from './changes.js';
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
    /** The store's part: it follows started groups by name. */
    private readonly owner: {
      readonly start: () => void;
      readonly change: () => void;
      readonly drop: () => void;
    },
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
    this.owner.change();
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
    this.guards.set(lane, this.app.register(lane.guard(this.scope)));
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
    this.owner.start();
    this.readable = this.view.getSnapshot().read;
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
      observeStarts(this.view, this.changed),
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
    this.owner.drop();
    return true;
  }
}

/** A lane class; one group key always holds one kind. */
export type LaneKind<D, L extends Lane<D>> = new (
  ...args: ConstructorParameters<typeof Lane<D>>
) => L;

/** Internal: the lane groups of one controller, by view, scope and definition. */
export interface LaneStore {
  group<D, L extends Lane<D> = Lane<D>>(
    view: BoundView,
    key: string,
    definition: FieldDefinition<D>,
    scope: LaneScope,
    kind?: LaneKind<D, L>,
  ): LaneGroup<D, L>;
  /**
   * The groups of one scope and key across views that have lanes, for a hook
   * writing to many targets (one group per Context).
   */
  groups<D>(key: string, scope: LaneScope): readonly LaneGroup<D>[];
  /** Notified on every lane change of those groups; `version` changes too. */
  watch(key: string, scope: LaneScope, listener: () => void): () => void;
  version(key: string, scope: LaneScope): number;
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
  // Started groups by name: they leave when they retire, so nothing else
  // keeps a replaced view alive here.
  const named = new Map<
    string,
    {
      readonly groups: Set<LaneGroup<unknown, Lane<unknown>>>;
      readonly listeners: Set<() => void>;
      version: number;
    }
  >();
  const channel = (name: string) => {
    let entry = named.get(name);
    if (!entry)
      named.set(
        name,
        (entry = { groups: new Set(), listeners: new Set(), version: 0 }),
      );
    return entry;
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
        {
          start: () => {
            channel(name).groups.add(entry());
          },
          change: () => {
            const c = channel(name);
            c.version++;
            notify([...c.listeners]);
          },
          drop: () => {
            if (byKey.get(name) === group) byKey.delete(name);
            channel(name).groups.delete(entry());
          },
        },
        kind,
      );
      const entry = () => group as unknown as LaneGroup<unknown, Lane<unknown>>;
      byKey.set(name, entry());
      return group;
    },
    groups<D>(key: string, scope: LaneScope) {
      return [...(named.get(`${scope} ${key}`)?.groups ?? [])].filter((g) =>
        g.holds(),
      ) as unknown as LaneGroup<D>[];
    },
    watch(key: string, scope: LaneScope, listener: () => void) {
      const c = channel(`${scope} ${key}`);
      c.listeners.add(listener);
      return () => {
        c.listeners.delete(listener);
      };
    },
    version(key: string, scope: LaneScope) {
      return named.get(`${scope} ${key}`)?.version ?? 0;
    },
  };
  stores.set(app, store);
  return store;
}
