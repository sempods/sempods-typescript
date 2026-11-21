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
  private holders = new Map<string, number>();
  private orders = new Map<string, number>();
  private announced = new Map<string, number>();
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
    if (previous && !previous.dismissed && sameNotice(previous.notice, notice))
      this.put(notice, { renewed: previous.renewed + 1 });
    else this.put(notice, { event: ++this.events, dismissed: false });
    this.emit();
  };
  /** `useNotice`: updates in place, silently; a dismissal stays. */
  declare(notice: Notice) {
    checked(notice);
    const previous = this.records.get(notice.key);
    if (previous && sameNotice(previous.notice, notice)) {
      // Only a new closure: keep it for the next press, render nothing.
      if (notice.action) this.runs.set(notice.key, notice.action.run);
      return;
    }
    this.put(notice, {});
    this.emit();
  }
  hold(key: string) {
    this.holders.set(key, (this.holders.get(key) ?? 0) + 1);
  }
  release(key: string) {
    const count = (this.holders.get(key) ?? 1) - 1;
    if (count > 0) {
      this.holders.set(key, count);
      return;
    }
    this.holders.delete(key);
    this.retire(key);
  }
  private retire(key: string) {
    if (!this.records.delete(key)) return;
    this.runs.delete(key);
    this.announced.delete(appId(key));
    this.forgetRun(appId(key));
    this.emit();
  }
  dismiss = (key: string) => {
    const record = this.records.get(key);
    if (!record || record.dismissed) return false;
    // A held notice stays dismissed until its holder retires it.
    if (this.holders.has(key)) {
      this.records.set(key, { ...record, dismissed: true });
      this.emit();
    } else this.retire(key);
    return true;
  };
  /**
   * After its action: a shown notice retires, a held one stays its holder's,
   * and one the action showed again, even identically, stays as shown:
   * every `show` stores a new record.
   */
  settle(key: string, before: NoticeRecord) {
    if (!this.holders.has(key) && this.records.get(key) === before)
      this.retire(key);
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
    if (this.announced.get(id) === event) return false;
    this.announced.set(id, event);
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
