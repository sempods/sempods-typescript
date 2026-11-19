import {
  useSyncExternalStore,
  type ComponentType,
  type RefObject,
} from 'react';
import { useController } from './app.js';
import type { Notice, NoticeAction, NoticeProps } from './notices.js';

/**
 * Internal: the app notices of one provider and the mounted `Notices` hosts,
 * kept per controller so every hook beneath a provider shares them.
 */
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
/** A mounted `Notices` host and its current options. */
export interface Host {
  readonly token: symbol;
  readonly limit: number;
  readonly Notice: ComponentType<NoticeProps> | undefined;
  readonly accessPrompts: boolean;
  readonly focusTarget: RefObject<HTMLElement | null> | undefined;
}

class NoticeStore {
  private records = new Map<string, NoticeRecord>();
  /** The latest action of each notice, without re-rendering for a new closure. */
  private runs = new Map<string, NoticeAction['run']>();
  private holders = new Map<string, number>();
  private orders = new Map<string, number>();
  private announced = new Map<string, number>();
  /** Notices and prompts whose action runs, across remounts and hosts. */
  private running = new Set<string>();
  private sequence = 0;
  private events = 0;
  private listeners = new Set<() => void>();
  private list: readonly NoticeRecord[] = [];
  hosts: readonly Host[] = [];

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = () => this.list;
  getHosts = () => this.hosts;

  private emit() {
    this.list = Object.freeze(
      [...this.records.values()].sort((a, b) => a.order - b.order),
    );
    this.listeners.forEach((listener) => listener());
  }
  /** The stack position of an app key or access prompt id. */
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
      order: previous?.order ?? this.orderOf('app\n' + notice.key),
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
    this.orders.delete('app\n' + key);
    this.announced.delete('app\n' + key);
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
  /** Marks an action of `id` as running; `false` while one already runs. */
  begin(id: string) {
    if (this.running.has(id)) return false;
    this.running.add(id);
    this.listeners.forEach((listener) => listener());
    return true;
  }
  end(id: string) {
    this.running.delete(id);
    this.listeners.forEach((listener) => listener());
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
  }
  /** Adds a host or replaces its options in place, keeping its position. */
  register(host: Host) {
    const index = this.hosts.findIndex((entry) => entry.token === host.token);
    this.hosts =
      index < 0
        ? [...this.hosts, host]
        : this.hosts.map((entry, i) => (i === index ? host : entry));
    this.listeners.forEach((listener) => listener());
  }
  unregister(token: symbol) {
    this.hosts = this.hosts.filter((entry) => entry.token !== token);
    this.listeners.forEach((listener) => listener());
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
