import {
  useSyncExternalStore,
  type ComponentType,
  type RefObject,
} from 'react';
import { useController } from './app.js';
import type { Notice, NoticeAction, NoticeProps } from './notices.js';

/** Internal: one app notice as the store keeps it. */
export interface NoticeRecord {
  readonly key: string;
  readonly notice: Notice;
  /** First publication, across app and access notices: the stack's order. */
  readonly order: number;
  /** Each announced event gets a new number. */
  readonly event: number;
  /** Each coalesced repeat restarts the timer. */
  readonly renewed: number;
  readonly dismissed: boolean;
}
interface Run {
  readonly token: symbol;
  readonly event: number;
}
interface Failure {
  readonly cause: unknown;
  readonly event: number;
}
/** A mounted `Notices` host and its current options. */
export interface Host {
  readonly token: symbol;
  readonly limit: number;
  readonly Notice: ComponentType<NoticeProps> | undefined;
  readonly accessPrompts: boolean;
  readonly focusTarget: RefObject<HTMLElement | null> | undefined;
}

/** The owner of a notice published with `show`. */
const shown = Symbol('shown');

/** The id of an app notice beside the access prompts' ids. */
export const appId = (key: string) => 'app\n' + key;

/**
 * The app notices of one provider and the mounted `Notices` hosts, kept per
 * controller so every hook beneath a provider shares them.
 */
class NoticeStore {
  private records = new Map<string, NoticeRecord>();
  /** The latest action of each notice, without re-rendering for a new closure. */
  private runs = new Map<string, NoticeAction['run']>();
  /**
   * Each `useNotice` that holds a key, with what it declared, in the order
   * they last declared.
   */
  private holders = new Map<string, Map<symbol, Notice | null>>();
  /** Who published the record under a key: a holder, or a `show`. */
  private owners = new Map<string, symbol>();
  /** Held notices the person dismissed, until their holders retire them. */
  private quiet = new Set<string>();
  private orders = new Map<string, number>();
  /** The events announced per notice or prompt, until it retires. */
  private announced = new Map<string, Set<number>>();
  /**
   * A holder's record that a `show` covers: it returns as it was, with its
   * event, its announcement and its running action, once the `show` goes.
   */
  private behind = new Map<string, NoticeRecord>();
  /**
   * The action that runs for a notice or prompt, across remounts and hosts:
   * its token and the event it started in. Retiring a notice drops it, so a
   * late answer never reaches a later notice with the same key.
   */
  private running = new Map<string, Run>();
  /** The last failed action of each, for the event it started in. */
  private failures = new Map<string, Failure>();
  private sequence = 0;
  private events = 0;
  private listeners = new Set<() => void>();
  private list: readonly NoticeRecord[] = [];
  private hosts: readonly Host[] = [];
  /** `AppAccess`'s focus target, for access prompts this store's host shows. */
  private accessFocus: RefObject<HTMLElement | null> | undefined;
  private warned = false;
  private warning: ReturnType<typeof setTimeout> | undefined;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = () => this.list;
  private notify() {
    this.listeners.forEach((listener) => listener());
  }
  getHosts = () => this.hosts;

  private emit() {
    this.list = Object.freeze(
      [...this.records.values()].sort((a, b) => a.order - b.order),
    );
    this.notify();
    this.checkHost();
  }
  /**
   * Notices with no mounted `Notices` host show nowhere: reported once in
   * the console, after a moment, so a host that mounts a little later
   * (a lazy shell) is no false report.
   */
  private checkHost() {
    if (this.warned || this.warning || this.hosts.length || !this.records.size)
      return;
    this.warning = setTimeout(() => {
      this.warning = undefined;
      if (this.warned || this.hosts.length || !this.records.size) return;
      this.warned = true;
      console.warn(
        '[@sempods/app-sdk] A notice was published, but no <Notices /> host is mounted: render one beneath SempodsProvider to show it.',
      );
    }, 2000);
  }
  setAccessFocus(target: RefObject<HTMLElement | null> | undefined) {
    this.accessFocus = target;
  }
  accessFocusTarget() {
    return this.accessFocus;
  }
  /** The stack position of an access prompt id. */
  orderOf(id: string) {
    let order = this.orders.get(id);
    if (order === undefined) {
      order = ++this.sequence;
      this.orders.set(id, order);
    }
    return order;
  }
  private put(notice: Notice, record: Partial<NoticeRecord>) {
    const previous = this.records.get(notice.key);
    this.records.set(notice.key, {
      key: notice.key,
      notice,
      order: previous?.order ?? ++this.sequence,
      event: previous?.event ?? ++this.events,
      renewed: previous?.renewed ?? 0,
      dismissed: previous?.dismissed ?? false,
      ...record,
    });
    if (notice.action) this.runs.set(notice.key, notice.action.run);
    else this.runs.delete(notice.key);
  }
  show = (notice: Notice) => {
    checked(notice);
    const previous = this.records.get(notice.key);
    // A `show` takes the key until it goes; a holder's notice waits behind
    // it, also an identical one, which it only renews.
    if (previous && this.owners.get(notice.key) !== shown)
      this.behind.set(notice.key, previous);
    this.owners.set(notice.key, shown);
    if (previous && !previous.dismissed && sameNotice(previous.notice, notice))
      // An identical repeat restarts the timer: one announcement.
      this.put(notice, { renewed: previous.renewed + 1 });
    else this.put(notice, { event: ++this.events, dismissed: false });
    this.emit();
  };
  /** `useNotice`: a holder's notice, updated in place, silently. */
  hold(key: string, holder: symbol) {
    const held = this.holders.get(key) ?? new Map<symbol, Notice | null>();
    held.set(holder, null);
    this.holders.set(key, held);
  }
  /**
   * The last holder to declare owns the notice and its action; one that
   * declares the same message takes it over silently. Behind a `show` it
   * only keeps what it would show once that goes. A dismissal stays.
   */
  declare(holder: symbol, notice: Notice) {
    checked(notice);
    const held = this.holders.get(notice.key);
    if (!held?.has(holder)) return;
    held.delete(holder);
    held.set(holder, notice);
    const owner = this.owners.get(notice.key);
    if (owner === shown) return;
    const previous = this.records.get(notice.key);
    this.owners.set(notice.key, holder);
    if (previous && sameNotice(previous.notice, notice)) {
      // Only a new closure or owner: keep it for the next press.
      if (notice.action) this.runs.set(notice.key, notice.action.run);
      return;
    }
    this.put(notice, previous ? {} : { dismissed: this.quiet.has(notice.key) });
    this.emit();
  }
  /**
   * A holder goes: its notice retires with the last holder, or passes to the
   * holder that declared last before it, with that holder's action. A newer
   * `show` under the key stays.
   */
  release(key: string, holder: symbol) {
    const held = this.holders.get(key);
    held?.delete(holder);
    if (held && held.size === 0) {
      this.holders.delete(key);
      this.quiet.delete(key);
      this.behind.delete(key);
    }
    if (this.owners.get(key) !== holder) return;
    if (!this.reclaim(key)) this.retire(key);
  }
  /** The latest holder's notice takes the key again; false without one. */
  private reclaim(key: string) {
    const latest = this.latestHolder(key);
    if (!latest) return false;
    const [holder, notice] = latest;
    this.owners.set(key, holder);
    const previous = this.records.get(key);
    if (previous && sameNotice(previous.notice, notice)) {
      if (notice.action) this.runs.set(key, notice.action.run);
      else this.runs.delete(key);
      return true;
    }
    // In place for a held notice; a new event once a `show` went.
    this.put(notice, previous ? {} : { dismissed: this.quiet.has(key) });
    this.emit();
    return true;
  }
  private retire(key: string) {
    if (!this.records.delete(key)) return;
    this.owners.delete(key);
    this.behind.delete(key);
    this.runs.delete(key);
    this.announced.delete(appId(key));
    this.forgetRun(appId(key));
    this.emit();
  }
  /**
   * A shown notice goes; a holder's notice behind it shows again as it was:
   * the same event, so it is not announced again and an action it started
   * stays guarded until that settles.
   */
  private close(key: string) {
    const covered = this.behind.get(key);
    const latest = this.latestHolder(key);
    if (covered && latest) {
      const [holder, notice] = latest;
      this.behind.delete(key);
      this.owners.set(key, holder);
      this.records.set(key, { ...covered, notice });
      if (notice.action) this.runs.set(key, notice.action.run);
      else this.runs.delete(key);
      this.emit();
      return;
    }
    this.retire(key);
    this.reclaim(key);
  }
  private latestHolder(key: string) {
    const held = [...(this.holders.get(key) ?? [])].filter(
      (entry): entry is [symbol, Notice] => entry[1] !== null,
    );
    return held[held.length - 1];
  }
  dismiss = (key: string) => {
    const record = this.records.get(key);
    if (!record || record.dismissed) return false;
    // An identical `show` only renewed the holder's notice: dismissing it
    // dismisses that.
    const latest = this.latestHolder(key);
    if (latest && this.behind.get(key)?.event === record.event) {
      this.behind.delete(key);
      this.owners.set(key, latest[0]);
    }
    // A holder's notice stays dismissed until its holders retire it.
    if (this.owners.get(key) !== shown) {
      this.quiet.add(key);
      this.records.set(key, { ...record, dismissed: true });
      this.emit();
    } else this.close(key);
    return true;
  };
  /**
   * After its action: a shown notice goes, a held one stays its holder's,
   * and one the action showed again, even identically, stays as shown:
   * every `show` stores a new record.
   */
  settle(key: string, before: NoticeRecord) {
    if (this.owners.get(key) === shown && this.records.get(key) === before)
      this.close(key);
  }
  recordOf(key: string) {
    return this.records.get(key);
  }
  run(key: string) {
    return this.runs.get(key);
  }
  private forgetRun(id: string) {
    this.running.delete(id);
    this.failures.delete(id);
  }
  /** The event an app notice shows now; an access prompt has one. */
  private eventOf(id: string) {
    const prefix = appId('');
    return id.startsWith(prefix)
      ? (this.records.get(id.slice(prefix.length))?.event ?? 0)
      : 0;
  }
  /**
   * Marks an action of `id` as running and returns its token, or `null`
   * while one already runs, also one a changed `show` left running.
   */
  begin(id: string) {
    if (this.running.has(id)) return null;
    const run: Run = { token: Symbol(id), event: this.eventOf(id) };
    this.running.set(id, run);
    this.failures.delete(id);
    this.notify();
    return run.token;
  }
  /**
   * Ends the run of `token`, keeping its failure for whoever shows the same
   * event; nothing once its notice has retired, and no failure once a
   * changed `show` replaced the event it started in.
   */
  end(id: string, token: symbol, failure?: { readonly cause: unknown }) {
    const run = this.running.get(id);
    if (run?.token !== token) return;
    this.running.delete(id);
    if (failure && run.event === this.eventOf(id))
      this.failures.set(id, { cause: failure.cause, event: run.event });
    this.notify();
  }
  failureOf(id: string) {
    const failure = this.failures.get(id);
    // A changed `show` is a new notice: an earlier failure no longer applies.
    return failure?.event === this.eventOf(id) ? failure : undefined;
  }
  isRunning(id: string) {
    return this.running.has(id);
  }
  /** Whether this event still needs its one announcement; marks it made. */
  announce(id: string, event: number) {
    const made = this.announced.get(id) ?? new Set<number>();
    if (made.has(event)) return false;
    made.add(event);
    this.announced.set(id, made);
    return true;
  }
  forgetPrompt(id: string) {
    this.orders.delete(id);
    this.announced.delete(id);
    this.forgetRun(id);
  }
  /** Adds a host or replaces its options in place, keeping its position. */
  register(host: Host) {
    const index = this.hosts.findIndex((entry) => entry.token === host.token);
    this.hosts =
      index < 0
        ? [...this.hosts, host]
        : this.hosts.map((entry, i) => (i === index ? host : entry));
    this.notify();
  }
  unregister(token: symbol) {
    this.hosts = this.hosts.filter((entry) => entry.token !== token);
    this.notify();
  }
}

function checked(notice: Notice) {
  if (!notice.key) throw new Error('A notice needs a key.');
}
function sameNotice(a: Notice, b: Notice) {
  return (
    a.text === b.text &&
    a.title === b.title &&
    (a.severity ?? 'info') === (b.severity ?? 'info') &&
    a.duration === b.duration &&
    a.action?.label === b.action?.label
  );
}

const stores = new WeakMap<object, NoticeStore>();
export function useNoticeStore() {
  const app = useController();
  let store = stores.get(app);
  if (!store) {
    store = new NoticeStore();
    stores.set(app, store);
  }
  return store;
}

/**
 * Internal: the first mounted `Notices` host. `AccessPrompts` yields to it
 * unless it leaves the access prompts out (`accessPrompts={false}`).
 */
export function useNoticeHost() {
  const store = useNoticeStore();
  const hosts = useSyncExternalStore(
    store.subscribe,
    store.getHosts,
    store.getHosts,
  );
  return hosts[0] ?? null;
}
