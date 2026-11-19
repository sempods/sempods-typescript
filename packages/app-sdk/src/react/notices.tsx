import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type CSSProperties,
  type RefObject,
} from 'react';
import type { AccessPrompt as AccessPromptFact } from '../authoring/access.js';
import { runAccessAction } from '../authoring/app.js';
import { useAppFacts, useController } from './app.js';
import { useAccessPrompts, usePromptText } from './access-prompts.js';
import { useFirst, useMounted } from './first.js';
import {
  useNoticeHost,
  useNoticeStore,
  type NoticeRecord,
} from './notice-store.js';
import { returnFocusAfterCommit, useFocusHold } from './focus.js';
import { useCommitted } from './hooks.js';
import { useSdkLocale } from './locale.js';
import { podName } from './names.js';
import { layered, SdkStyles } from './styles.js';

/**
 * An app-wide message for the `Notices` host. Severity says how serious it
 * is; `duration` says whether it waits for the person. Keep validation,
 * conflicts and unconfirmed writes beside the affected field or row: a notice
 * summarizes, it never acknowledges or retries a write.
 */
export interface Notice {
  /**
   * Stable for one message, such as `app-update` or `pod-unreachable:<id>`.
   * Publishing the same key again updates the notice in place: repeats
   * coalesce into one entry instead of stacking.
   */
  readonly key: string;
  /** The message, already localized. */
  readonly text: string;
  /** A short localized heading above the text. */
  readonly title?: string;
  /** `info` by default. */
  readonly severity?: 'info' | 'warning' | 'error';
  /** One action beside dismissing it, run through the SDK's guards. */
  readonly action?: NoticeAction;
  /**
   * Milliseconds until it hides by itself, unless hovered or focused, or
   * `'until-dismissed'`. By default, an `info` notice without an action hides
   * after about 6 seconds; warnings, errors and notices with an action stay
   * until dismissed or retired.
   */
  readonly duration?: number | 'until-dismissed';
}

/** The action of a `Notice`. */
export interface NoticeAction {
  /** The button's label, already localized. */
  readonly label: string;
  /**
   * Runs once per press. The button is disabled while it runs and while a
   * guarded SDK change or its leave question is open. A rejection shows its
   * localized error in the notice. Once it resolves, a notice published with
   * `show` retires; one held by `useNotice` stays until its holder changes it.
   */
  readonly run: () => void | Promise<unknown>;
}

/** What `useNotices` returns. */
export interface NoticeActions {
  /**
   * Shows `notice` as one event: it is announced once and shows again if it
   * was dismissed. An identical repeat of a visible notice only restarts its
   * timer; a changed one updates it in place and is announced.
   */
  readonly show: (notice: Notice) => void;
  /** Hides the notice with this key; `false` when none shows. */
  readonly dismiss: (key: string) => boolean;
}

/** One notice as the host's renderer receives it, app or access. */
export interface NoticeView {
  readonly key: string;
  /** `access`: one of `useAccessPrompts().prompts`; `app`: a `Notice`. */
  readonly source: 'app' | 'access';
  /** The access prompt's reason, for `source: 'access'`. */
  readonly reason?: AccessPromptFact['reason'];
  /** An access prompt's `action` severity reads as `warning`. */
  readonly severity: 'info' | 'warning' | 'error';
  readonly title: string | null;
  readonly text: string | null;
  /** The Pod an access prompt is about, when it is not the active one. */
  readonly pod: string | null;
  /** The Pod's own sign-in link of an access prompt; offer it beside signing in. */
  readonly link: { readonly href: string; readonly label: string } | null;
  /** In order; render them as buttons, the `primary` one first. */
  readonly actions: readonly NoticeViewAction[];
  /** The localized error of the last action that failed. */
  readonly failure: string | null;
  /** Hides it, or `null` when it cannot be dismissed. Never a write decision. */
  readonly dismiss: (() => void) | null;
  /** The localized label for a dismiss button. */
  readonly dismissLabel: string;
}

/** One action of a `NoticeView`, guarded by the host. */
export interface NoticeViewAction {
  readonly label: string;
  readonly primary: boolean;
  /** While it or another guarded change runs. */
  readonly disabled: boolean;
  readonly run: () => void;
}

/** What a replacement notice renderer receives. */
export interface NoticeProps {
  readonly notice: NoticeView;
}

/** What `Notices` receives. */
export interface NoticesProps {
  /**
   * Focus after a notice goes while it holds focus, as `focusTarget` of
   * `AppAccess`; without it, focus returns to where it came from.
   */
  readonly focusTarget?: RefObject<HTMLElement | null> | undefined;
  /** At most this many notices show at once; the rest wait. Default 3. */
  readonly limit?: number | undefined;
  /**
   * `false` leaves the access prompts out of this stack, for an app that
   * shows them itself (`AccessPrompt`, `useAccessPrompts`) or keeps the
   * stack of `AppAccess`. Default `true`: this stack shows them instead.
   */
  readonly accessPrompts?: boolean | undefined;
  /**
   * `Notice` replaces how one notice renders. The host still owns its
   * position, timers, announcement, keyboard dismissal and action guards.
   */
  readonly components?:
    { readonly Notice?: ComponentType<NoticeProps> | undefined } | undefined;
}

// ---------------------------------------------------------------------------
// Publishing.

/**
 * Publish, update and dismiss app notices by key; the `Notices` host shows
 * them. Use it for events, such as a finished batch.
 */
export function useNotices(): NoticeActions {
  const store = useNoticeStore();
  return useMemo(() => ({ show: store.show, dismiss: store.dismiss }), [store]);
}

/**
 * Holds `notice` while it is passed and this component is mounted, for a
 * state that lasts, such as a waiting update or an unreachable Pod. Passing
 * `null` or unmounting retires it, so a warning ends with its cause. Changes
 * update it in place without a new announcement; once dismissed, it stays
 * hidden until it is retired and passed again.
 */
export function useNotice(notice: Notice | null): void {
  const store = useNoticeStore();
  const key = notice?.key ?? null;
  useEffect(() => {
    if (key === null) return;
    store.hold(key);
    return () => store.release(key);
  }, [store, key]);
  useEffect(() => {
    if (notice) store.declare(notice);
  });
}

// ---------------------------------------------------------------------------
// The host.

/** About 6 seconds, as for brief access information. */
const briefDuration = 6000;
const defaultLimit = 3;

interface Entry {
  readonly id: string;
  readonly order: number;
  readonly sticky: boolean;
  readonly app?: NoticeRecord;
  readonly prompt?: AccessPromptFact;
}

function durationOf(entry: Entry): number | null {
  if (entry.prompt)
    return entry.prompt.severity === 'info' ? briefDuration : null;
  const notice = entry.app!.notice;
  const duration =
    notice.duration ??
    ((notice.severity ?? 'info') === 'info' && !notice.action
      ? briefDuration
      : 'until-dismissed');
  return duration === 'until-dismissed' ? null : duration;
}

/**
 * The bounded set to show: in order, but over the limit the notices that wait
 * for the person (an action, an error, no timer) go first, so a burst of
 * brief information never pushes a pending action out of reach.
 */
function visible(entries: readonly Entry[], limit: number) {
  if (entries.length <= limit) return entries;
  const sticky = entries.filter((entry) => entry.sticky).slice(0, limit);
  const brief = entries
    .filter((entry) => !entry.sticky)
    .slice(0, limit - sticky.length);
  const shown = new Set([...sticky, ...brief]);
  return entries.filter((entry) => shown.has(entry));
}

function appEntries(records: readonly NoticeRecord[]): Entry[] {
  return records
    .filter((record) => !record.dismissed)
    .map((record) => {
      const entry: Entry = {
        id: 'app\n' + record.key,
        order: record.order,
        sticky: false,
        app: record,
      };
      return { ...entry, sticky: durationOf(entry) === null };
    });
}

interface Announcement {
  readonly id: number;
  readonly text: string;
  readonly assertive: boolean;
}
const Announce = createContext<{
  readonly announce: (text: string, assertive: boolean) => void;
  readonly layer: 'page' | 'gate';
}>({ announce: () => {}, layer: 'page' });

/**
 * One polite and one assertive live region. Each event is added once and
 * removed again later, so a repeat or a later update is no new announcement
 * and the visible notices need no live role of their own.
 */
function useAnnouncer() {
  const [items, setItems] = useState<readonly Announcement[]>([]);
  const next = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((timer) => clearTimeout(timer));
  }, []);
  const announce = useCallback((text: string, assertive: boolean) => {
    const id = ++next.current;
    setItems((list) => [...list, { id, text, assertive }]);
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setItems((list) => list.filter((item) => item.id !== id));
    }, 7000);
    timers.current.add(timer);
  }, []);
  // Not atomic, unlike the roles' default: only the added paragraph is
  // read, never the retained ones again.
  const regions = (
    <>
      <div
        className="sp-notices-live"
        role="status"
        aria-live="polite"
        aria-atomic="false"
        aria-relevant="additions"
      >
        {items
          .filter((item) => !item.assertive)
          .map((item) => (
            <p key={item.id}>{item.text}</p>
          ))}
      </div>
      <div
        className="sp-notices-live"
        role="alert"
        aria-live="assertive"
        aria-atomic="false"
        aria-relevant="additions"
      >
        {items
          .filter((item) => item.assertive)
          .map((item) => (
            <p key={item.id}>{item.text}</p>
          ))}
      </div>
    </>
  );
  return { announce, regions };
}

/** Whether a modal outside `own` covers the page, and the avoided bottom zone. */
/**
 * Inside the gate only these cover the stack: a dialog of the gate itself
 * (its settings), and management or a leave question, which the gate raises
 * above itself. An app modal that was open before the gate lies below it.
 */
const aboveGate =
  'dialog[data-sempods-ui="management"][open], dialog[data-sempods-ui="leave"][open]';

/**
 * The order in which open dialogs were first seen open, per document: the
 * top layer stacks modals by opening order, which no API reports.
 */
const opened = new WeakMap<
  Document,
  { sequence: number; readonly of: Map<Element, number> }
>();
/**
 * Records dialogs that opened since the last call, in document order, and
 * `last` after them when it is new; forgets closed ones, so one that opens
 * again counts as opened then.
 */
function trackOpened(document: Document, last?: Element) {
  let order = opened.get(document);
  if (!order) {
    order = { sequence: 0, of: new Map() };
    opened.set(document, order);
  }
  for (const element of order.of.keys())
    if (!element.isConnected || !element.hasAttribute('open'))
      order.of.delete(element);
  for (const element of document.querySelectorAll('dialog[open]'))
    if (element !== last && !order.of.has(element))
      order.of.set(element, ++order.sequence);
  if (last && !order.of.has(last)) order.of.set(last, ++order.sequence);
  return order.of;
}

function usePageCover(
  own: RefObject<HTMLElement | null>,
  enabled = true,
  layer: 'page' | 'gate' = 'page',
) {
  const [cover, setCover] = useState({ modal: false, avoid: 0 });
  useEffect(() => {
    if (!enabled) return;
    const document = own.current?.ownerDocument;
    const view = document?.defaultView;
    if (!document || !view) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const element = own.current;
      if (!element) return;
      // Every host keeps the opening order, from its first measure on.
      trackOpened(document);
      const modal = isCovered(element, layer);
      const height = view.innerHeight;
      let avoid = 0;
      for (const zone of document.querySelectorAll<HTMLElement>(
        '[data-sempods-notices-avoid]',
      )) {
        const rect = zone.getBoundingClientRect();
        if (rect.height === 0 || rect.top >= height || rect.bottom < height / 2)
          continue;
        avoid = Math.max(avoid, Math.ceil(height - rect.top));
      }
      setCover((current) =>
        current.modal === modal && current.avoid === avoid
          ? current
          : { modal, avoid },
      );
    };
    const schedule = () => {
      if (!frame) frame = view.requestAnimationFrame(measure);
    };
    // An avoided zone that grows (an auto-growing composer) moves the stack.
    const sizes =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver(schedule)
        : null;
    const zones = new Set<Element>();
    const watchZones = () => {
      if (!sizes) return;
      const now = new Set(
        document.querySelectorAll('[data-sempods-notices-avoid]'),
      );
      for (const zone of zones)
        if (!now.has(zone)) {
          sizes.unobserve(zone);
          zones.delete(zone);
        }
      for (const zone of now)
        if (!zones.has(zone)) {
          sizes.observe(zone, { box: 'border-box' });
          zones.add(zone);
        }
    };
    const changed = () => {
      watchZones();
      schedule();
    };
    watchZones();
    measure();
    const observer = new MutationObserver(changed);
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        'open',
        'inert',
        'aria-hidden',
        'aria-modal',
        'data-sempods-notices-avoid',
      ],
    });
    view.addEventListener('resize', schedule);
    view.addEventListener('scroll', schedule, { passive: true });
    view.visualViewport?.addEventListener('resize', schedule);
    view.visualViewport?.addEventListener('scroll', schedule);
    return () => {
      observer.disconnect();
      sizes?.disconnect();
      view.removeEventListener('resize', schedule);
      view.removeEventListener('scroll', schedule);
      view.visualViewport?.removeEventListener('resize', schedule);
      view.visualViewport?.removeEventListener('scroll', schedule);
      if (frame) view.cancelAnimationFrame(frame);
    };
  }, [own, enabled, layer]);
  return cover;
}
/** Whether a modal above `element`'s layer covers it, right now. */
function isCovered(element: HTMLElement, layer: 'page' | 'gate') {
  const document = element.ownerDocument;
  const gate = layer === 'gate' ? element.closest('dialog') : null;
  if (gate) {
    const order = trackOpened(document, gate);
    const gateOpened = order.get(gate) ?? 0;
    return (
      [...gate.querySelectorAll('dialog[open]')].some(isModal) ||
      [...document.querySelectorAll(aboveGate)].some(
        (other) => !gate.contains(other) && isModal(other),
      ) ||
      // A dialog of the app that opened after the gate lies above it; one
      // that was open before (#264) lies below.
      [...document.querySelectorAll('dialog[open]')].some(
        (other) =>
          !gate.contains(other) &&
          (order.get(other) ?? 0) > gateOpened &&
          isModal(other),
      )
    );
  }
  return (
    // An overlay library hides the page around its modal.
    Boolean(element.closest('[inert], [aria-hidden="true"]')) ||
    [...document.querySelectorAll('dialog[open], [aria-modal="true"]')].some(
      (other) =>
        !other.contains(element) && !element.contains(other) && isModal(other),
    )
  );
}

function isModal(element: Element) {
  if (element.localName !== 'dialog') return true;
  // Without a top layer (jsdom), an SDK dialog opens with the attribute.
  if (typeof (element as HTMLDialogElement).showModal !== 'function')
    return true;
  try {
    return element.matches(':modal');
  } catch {
    return true;
  }
}

/**
 * The shared notification host: one bounded stack of the app's notices
 * (`useNotice`, `useNotices`) and the access prompts of `AccessPrompts`,
 * fixed at the bottom of the viewport, outside the document flow. Render it
 * once beneath `SempodsProvider`; while it is mounted, `AppAccess` shows no
 * prompt stack of its own, unless `accessPrompts={false}` leaves the prompts
 * there. Without it, `AppAccess` is unchanged.
 *
 * Each event is announced once through its own live region; nothing takes
 * the focus. Brief notices hide after their duration unless hovered or
 * focused, and Escape dismisses the focused one. The stack waits while a
 * modal covers the page and, beside `AppAccess`, while the app starts; app
 * notices show inside the sign-in gate instead.
 * It stays above elements marked `data-sempods-notices-avoid`, such as a
 * composer at the bottom, and above the safe area. A CSP must permit its
 * styles.
 */
export function Notices(props: NoticesProps) {
  const store = useNoticeStore();
  const [token] = useState(() => Symbol('notices'));
  const limit = props.limit ?? defaultLimit;
  const Notice = props.components?.Notice;
  const accessPrompts = props.accessPrompts ?? true;
  const { focusTarget } = props;
  useEffect(() => () => store.unregister(token), [store, token]);
  useEffect(
    () => store.register({ token, limit, Notice, accessPrompts, focusTarget }),
    [store, token, limit, Notice, accessPrompts, focusTarget],
  );
  // One stack per provider, also with several hosts.
  const first = useFirst('notices');
  const records = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const { blocking, prompts } = useAccessPrompts();
  const starting = useAppFacts((s) => s.starting);
  const gateMounted = useMounted('gate');
  const { direction } = useSdkLocale();
  const root = useRef<HTMLDivElement>(null);
  const cover = usePageCover(root);
  const { announce, regions } = useAnnouncer();
  const pageAnnounce = useMemo(
    () => ({ announce, layer: 'page' as const }),
    [announce],
  );
  const live = useRef(new Set<string>());
  const entries = useMemo(() => {
    const access: Entry[] =
      blocking || starting || !accessPrompts
        ? []
        : prompts.map((prompt) => ({
            id: prompt.id,
            order: store.orderOf(prompt.id),
            sticky: prompt.severity !== 'info',
            prompt,
          }));
    return [...access, ...appEntries(records)].sort(
      (a, b) => a.order - b.order,
    );
  }, [blocking, starting, accessPrompts, prompts, records, store]);
  // Retired access prompts free their position and announcement.
  useEffect(() => {
    const ids = new Set(prompts.map((prompt) => prompt.id));
    for (const id of live.current) if (!ids.has(id)) store.forgetPrompt(id);
    live.current = ids;
  }, [prompts, store]);
  // The SDK gate covers the page from its first render on; during startup
  // it may still open, and its notices then show inside it.
  const gated = (Boolean(blocking) || starting) && gateMounted;
  const shown = !first || cover.modal || gated ? [] : visible(entries, limit);
  return (
    <div
      ref={root}
      data-sempods-ui="notices"
      dir={direction}
      style={
        cover.avoid
          ? ({ '--sp-notices-avoid': `${cover.avoid}px` } as CSSProperties)
          : undefined
      }
    >
      <SdkStyles />
      <style href="sempods-notices" precedence="sempods">
        {layered(styles)}
      </style>
      {first && regions}
      <Announce.Provider value={pageAnnounce}>
        <ul hidden={shown.length === 0}>
          {shown.map((entry) => (
            <NoticeItem
              key={entry.id}
              entry={entry}
              focusTarget={focusTarget}
              Notice={Notice ?? DefaultNotice}
            />
          ))}
        </ul>
      </Announce.Provider>
    </div>
  );
}

/**
 * Internal: the app notices inside the sign-in gate, so a waiting update
 * shows before sign-in. Only with a mounted `Notices` host, whose renderer
 * and limit it uses; the gate keeps room for it at its end.
 */
export function GateNotices() {
  const store = useNoticeStore();
  const host = useNoticeHost();
  const records = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const { direction } = useSdkLocale();
  const { announce, regions } = useAnnouncer();
  const root = useRef<HTMLDivElement>(null);
  // A dialog above the gate, such as the app's settings, makes the stack
  // wait: its notices time out and are announced once it closes.
  const cover = usePageCover(root, Boolean(host), 'gate');
  const gateAnnounce = useMemo(
    () => ({ announce, layer: 'gate' as const }),
    [announce],
  );
  const shown =
    host && !cover.modal ? visible(appEntries(records), host.limit) : [];
  // Room at the gate's end, so the stack never covers its last control.
  useLayoutEffect(() => {
    const element = root.current;
    const gate = element?.closest('dialog');
    if (!element || !gate) return;
    const list = element.querySelector('ul');
    const reserve = () => {
      const height = list && !list.hidden ? list.offsetHeight : 0;
      gate.style.paddingBlockEnd = height ? `${height + 24}px` : '';
    };
    reserve();
    const observer =
      typeof ResizeObserver === 'function' && list
        ? new ResizeObserver(reserve)
        : null;
    if (list) observer?.observe(list);
    return () => {
      observer?.disconnect();
      gate.style.paddingBlockEnd = '';
    };
  }, [shown.length]);
  if (!host) return null;
  return (
    <div
      ref={root}
      data-sempods-ui="notices"
      data-placement="gate"
      dir={direction}
    >
      <style href="sempods-notices" precedence="sempods">
        {layered(styles)}
      </style>
      {regions}
      <Announce.Provider value={gateAnnounce}>
        <ul hidden={shown.length === 0}>
          {shown.map((entry) => (
            <NoticeItem
              key={entry.id}
              entry={entry}
              // The app's focus target is inert behind the gate: focus
              // returns to where it came from inside the gate.
              focusTarget={undefined}
              Notice={host.Notice ?? DefaultNotice}
            />
          ))}
        </ul>
      </Announce.Provider>
    </div>
  );
}

function NoticeItem({
  entry,
  focusTarget,
  Notice,
}: {
  readonly entry: Entry;
  readonly focusTarget: RefObject<HTMLElement | null> | undefined;
  readonly Notice: ComponentType<NoticeProps>;
}) {
  const store = useNoticeStore();
  const view = useNoticeView(entry);
  const { announce, layer } = useContext(Announce);
  const event = entry.app?.event ?? 0;
  const message = [view.pod, view.title, view.text].filter(Boolean).join('. ');
  const element = useRef<HTMLLIElement>(null);
  // Once per event, when it first shows uncovered: here, in the gate or
  // after a modal. A modal that opened in the same event as the notice is
  // seen at once, before the host measures it: the event waits for it.
  useEffect(() => {
    if (!message) return;
    let frame = 0;
    const attempt = () => {
      frame = 0;
      const li = element.current;
      if (!li) return;
      if (isCovered(li, layer)) {
        frame = requestAnimationFrame(attempt);
        return;
      }
      if (store.announce(entry.id, event))
        announce(message, view.severity === 'error');
    };
    attempt();
    return () => cancelAnimationFrame(frame);
    // Only a new event announces; a changed text or language does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, entry.id, event]);
  // Timer, paused while hovered or focused; a repeat or a new event
  // restarts it, an update in place (a language change) does not.
  const [held, setHeld] = useState({ hover: false, focus: false });
  const duration = durationOf(entry);
  const renewed = entry.app?.renewed ?? 0;
  const expire = useCommitted(view.dismiss);
  useEffect(() => {
    if (duration === null || held.hover || held.focus) return;
    // Hiding dismisses it, so a remount or a second host does not replay it.
    const timer = setTimeout(() => expire.current?.(), duration);
    return () => clearTimeout(timer);
  }, [duration, held.hover, held.focus, renewed, event, expire]);
  // Focus returns from a notice that goes while it holds focus.
  const focus = useFocusHold();
  const previous = useRef<HTMLElement | null>(null);
  const target = useCommitted(focusTarget);
  useLayoutEffect(() => {
    const returnTo = () =>
      focus.held.current ? (target.current?.current ?? previous.current) : null;
    return () => {
      const next = returnTo();
      if (next?.isConnected) returnFocusAfterCommit(next);
    };
  }, [focus.held, target]);
  return (
    <li
      ref={element}
      data-source={view.source}
      data-severity={view.severity}
      onPointerEnter={() => setHeld((h) => ({ ...h, hover: true }))}
      onPointerLeave={() => setHeld((h) => ({ ...h, hover: false }))}
      onFocusCapture={(event) => {
        const from = event.relatedTarget;
        if (from instanceof HTMLElement && !event.currentTarget.contains(from))
          previous.current = from;
        focus.onFocusCapture();
        setHeld((h) => ({ ...h, focus: true }));
      }}
      onBlurCapture={(event) => {
        focus.onBlurCapture(event);
        const next = event.relatedTarget;
        if (!(next instanceof Node && element.current?.contains(next)))
          setHeld((h) => ({ ...h, focus: false }));
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && view.dismiss) {
          event.stopPropagation();
          view.dismiss();
        }
      }}
    >
      <Notice notice={view} />
    </li>
  );
}

/** Internal: the guarded view of one entry, app or access. */
function useNoticeView(entry: Entry): NoticeView {
  const app = useController();
  const store = useNoticeStore();
  const { changing, confirmingLeave, fixed, connections, activeId } =
    useAppFacts(
      (s) => ({
        changing: s.changing,
        confirmingLeave: s.confirmingLeave,
        fixed: Boolean(s.preset?.podUrl ?? s.allowedPods?.length === 1),
        connections: s.connections,
        activeId: s.activeId,
      }),
      (a, b) =>
        a.changing === b.changing &&
        a.confirmingLeave === b.confirmingLeave &&
        a.fixed === b.fixed &&
        a.connections === b.connections &&
        a.activeId === b.activeId,
    );
  const { messages: m, error } = useSdkLocale();
  const prompt = entry.prompt;
  // Hooks run for both kinds; only an access prompt has a text to derive.
  const promptText = usePromptText(prompt ?? placeholder);
  // Running is kept per notice in the store, so a remount (after a modal,
  // in another host, after sign-in) never runs it twice at once.
  const busy = useSyncExternalStore(
    store.subscribe,
    () => store.isRunning(entry.id),
    () => store.isRunning(entry.id),
  );
  // So is its failure: the instance that shows it now displays it.
  const failure = useSyncExternalStore(
    store.subscribe,
    () => store.failureOf(entry.id),
    () => store.failureOf(entry.id),
  );
  const disabled = busy || changing || confirmingLeave;
  const guarded = (run: () => Promise<unknown>) => () => {
    const life = disabled ? null : store.begin(entry.id);
    if (life === null) return;
    void run().then(
      () => store.end(entry.id, life),
      (cause: unknown) => store.end(entry.id, life, { cause }),
    );
  };
  const dismissLabel = m.controls.dismiss ?? m.controls.close ?? 'OK';
  const failed = failure ? error(failure.cause) : null;
  if (prompt) {
    const c = connections.find((entry) => entry.id === prompt.connectionId);
    const label = (action: AccessPromptFact['actions'][number]) =>
      action === 'sign-in'
        ? prompt.reason === 'missing-scopes'
          ? m.controls.updateAccess
          : m.controls.signIn
        : action === 'retry'
          ? m.controls.retry
          : action === 'forget'
            ? (m.controls.forget ?? 'Forget')
            : (m.controls.reload ?? m.controls.retry);
    // A sign-in without a known address needs the gate's address field.
    const actions = prompt.actions.filter(
      (action) =>
        action !== 'dismiss' &&
        (action !== 'sign-in' || prompt.connectionId !== null || fixed),
    );
    return {
      key: prompt.id,
      source: 'access',
      reason: prompt.reason,
      severity: prompt.severity === 'info' ? 'info' : 'warning',
      title: null,
      text: promptText,
      pod: c && c.id !== activeId ? podName(c.podUrl) : null,
      link: prompt.providerLink
        ? {
            href: prompt.providerLink,
            label: m.controls.providerLink ?? m.controls.signIn,
          }
        : null,
      actions: actions.map((action, index) => ({
        label: label(action),
        primary: prompt.severity !== 'info' && index === 0,
        disabled,
        run: guarded(() => runAccessAction(app, prompt, action)),
      })),
      failure: failed,
      dismiss: prompt.actions.includes('dismiss')
        ? () => void app.dismiss(prompt.id)
        : null,
      dismissLabel,
    };
  }
  const record = entry.app!;
  const notice = record.notice;
  return {
    key: record.key,
    source: 'app',
    severity: notice.severity ?? 'info',
    title: notice.title ?? null,
    text: notice.text,
    pod: null,
    link: null,
    actions: notice.action
      ? [
          {
            label: notice.action.label,
            primary: true,
            disabled,
            run: guarded(async () => {
              const run = store.run(record.key);
              const before = store.recordOf(record.key);
              if (!run || !before) return;
              await run();
              // A shown notice has done its job, unless the action showed it
              // again; a held one is its holder's.
              store.settle(record.key, before);
            }),
          },
        ]
      : [],
    failure: failed,
    dismiss: () => void store.dismiss(record.key),
    dismissLabel,
  };
}
const placeholder: AccessPromptFact = Object.freeze({
  id: '',
  severity: 'info',
  reason: 'no-connection',
  connectionId: null,
  actions: [],
});

/** The default renderer: an SDK surface with the shared button styles. */
function DefaultNotice({ notice }: NoticeProps) {
  const { direction } = useSdkLocale();
  const actions = notice.actions;
  const primaryDismiss =
    notice.source === 'access' &&
    notice.severity !== 'info' &&
    actions.length === 0;
  return (
    <div
      data-sempods-ui={notice.source === 'access' ? 'prompt' : 'toast'}
      data-severity={notice.severity}
      {...(notice.reason ? { 'data-reason': notice.reason } : {})}
      className="sp-notice"
      dir={direction}
    >
      {notice.severity !== 'info' && (
        <svg className="sp-notice-icon" viewBox="0 0 24 24" aria-hidden="true">
          {notice.severity === 'error' ? (
            <>
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7.5v5.5M12 16.5v.01" />
            </>
          ) : (
            <path d="M12 3.5 2.5 20h19zM12 10v4.5M12 17.5v.01" />
          )}
        </svg>
      )}
      <div className="sp-notice-body">
        {notice.pod && <p className="sp-prompt-pod">{notice.pod}</p>}
        {notice.title && <p className="sp-notice-title">{notice.title}</p>}
        {notice.text && <p>{notice.text}</p>}
        {notice.link && (
          <p className="sp-provider-link">
            <a
              href={notice.link.href}
              target="_blank"
              rel="noopener noreferrer"
            >
              {notice.link.label}
            </a>
          </p>
        )}
        {(actions.length > 0 || notice.dismiss) && (
          <div className="sp-sdk-actions">
            {actions.map((action) => (
              <button
                key={action.label}
                type="button"
                className={action.primary ? 'sp-sdk-primary' : undefined}
                disabled={action.disabled}
                onClick={action.run}
              >
                {action.label}
              </button>
            ))}
            {notice.dismiss && (
              <button
                type="button"
                className={primaryDismiss ? 'sp-sdk-primary' : undefined}
                onClick={notice.dismiss}
              >
                {notice.dismissLabel}
              </button>
            )}
          </div>
        )}
        {notice.failure && <p role="alert">{notice.failure}</p>}
      </div>
    </div>
  );
}

const styles = `
[data-sempods-ui="notices"] {
  --sp-notice-warning:var(--sempods-warning,light-dark(#8a5300,#f2c26b));
  --sp-notice-error:var(--sempods-danger,light-dark(#a31e15,#ffb4ab));
  position:fixed; z-index:1000; pointer-events:none;
  inset-inline:max(16px, env(safe-area-inset-left, 0px)) max(16px, env(safe-area-inset-right, 0px));
  inset-block-end:calc(max(16px + env(safe-area-inset-bottom, 0px), var(--sp-notices-avoid, 0px) + 8px) + var(--sempods-notices-offset, 0px));
}
[data-sempods-ui="notices"] .sp-notices-live { position:absolute; width:1px; height:1px; margin:-1px; padding:0; overflow:hidden; clip-path:inset(50%); white-space:nowrap; border:0; }
[data-sempods-ui="notices"] ul { list-style:none; margin:0 auto; padding:0; display:grid; gap:8px; max-width:28rem; max-block-size:60vh; overflow-y:auto; pointer-events:auto; }
[data-sempods-ui="notices"] ul[hidden] { display:none; }
[data-sempods-ui="notices"] li { animation:sp-notice-in .16s ease-out; }
[data-sempods-ui="notices"] .sp-notice { display:flex; gap:12px; align-items:flex-start; background:var(--sp-bg); border:1px solid var(--sp-line); border-radius:calc(var(--sp-radius) * 1.5); padding:4px 16px 12px; box-shadow:0 8px 24px rgb(0 0 0 / .16); }
[data-sempods-ui="notices"] .sp-notice[data-severity="warning"] { border-inline-start:4px solid var(--sp-notice-warning); }
[data-sempods-ui="notices"] .sp-notice[data-severity="error"] { border-inline-start:4px solid var(--sp-notice-error); }
[data-sempods-ui="notices"] .sp-notice-icon { flex:none; width:20px; height:20px; margin-block-start:14px; fill:none; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
[data-sempods-ui="notices"] [data-severity="warning"] .sp-notice-icon { stroke:var(--sp-notice-warning); }
[data-sempods-ui="notices"] [data-severity="error"] .sp-notice-icon { stroke:var(--sp-notice-error); }
[data-sempods-ui="notices"] .sp-notice-body { flex:1; min-width:0; }
[data-sempods-ui="notices"] .sp-notice-title { font-weight:600; margin-block:12px 0; }
[data-sempods-ui="notices"] .sp-notice-title + p { margin-block-start:4px; }
[data-sempods-ui="notices"] .sp-prompt-pod { font-size:.875rem; color:var(--sp-muted); margin-block:8px 0; }
[data-sempods-ui="notices"] .sp-sdk-actions { justify-content:flex-end; }
[data-sempods-ui="notices"][data-placement="gate"] { position:fixed; }
@keyframes sp-notice-in { from { opacity:0; transform:translateY(8px); } }
@media (prefers-reduced-motion: reduce) { [data-sempods-ui="notices"] li { animation:none; } }
`;
