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
import {
  infoTimeout,
  offeredActions,
  promptActionLabel,
  useAccessPrompts,
  usePromptText,
} from './access-prompts.js';
import { useMounted } from './first.js';
import {
  appId,
  useNoticeHost,
  useNoticeStore,
  type Host,
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
   * `AppAccess`; without it, focus returns to `AppAccess`'s `focusTarget`
   * for an access prompt and to where it came from otherwise.
   */
  readonly focusTarget?: RefObject<HTMLElement | null> | undefined;
  /**
   * At most this many notices show at once, at least one; the rest wait.
   * Default 3.
   */
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
 * hidden until it is retired and passed again. A `show` under the same key
 * takes it until that notice goes, and letting go never removes it; among
 * several holders of a key, the one that declared last owns the notice and
 * its action, and one that stays takes over when it unmounts.
 */
export function useNotice(notice: Notice | null): void {
  const store = useNoticeStore();
  const [holder] = useState(() => Symbol('useNotice'));
  const key = notice?.key ?? null;
  useEffect(() => {
    if (key === null) return;
    store.hold(key, holder);
    return () => store.release(key, holder);
  }, [store, key, holder]);
  useEffect(() => {
    if (notice) store.declare(holder, notice);
  });
}

// ---------------------------------------------------------------------------
// The host.

/** As for brief access information. */
const briefDuration = infoTimeout;
const defaultLimit = 3;
/** At least one; a value that is no number keeps the default. */
function limitOf(limit: number | undefined) {
  return limit !== undefined && Number.isFinite(limit)
    ? Math.max(1, Math.floor(limit))
    : defaultLimit;
}

interface Entry {
  readonly id: string;
  readonly order: number;
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
  const waits = (entry: Entry) => durationOf(entry) === null;
  const sticky = entries.filter(waits).slice(0, limit);
  const brief = entries
    .filter((entry) => !waits(entry))
    .slice(0, limit - sticky.length);
  const shown = new Set([...sticky, ...brief]);
  return entries.filter((entry) => shown.has(entry));
}

const none: readonly Entry[] = [];

/**
 * The notices a host draws, up to its limit. While a modal covers them,
 * those drawn when it opened stay mounted beside the new ones, so a notice
 * that takes a slot never unmounts a renderer's open confirmation; the order
 * applies once the modal closes.
 */
function useDrawn(
  entries: readonly Entry[],
  limit: number,
  suspended: boolean,
) {
  const shown = useMemo(() => visible(entries, limit), [entries, limit]);
  const [held, setHeld] = useState(shown);
  if (!suspended && held !== shown) setHeld(shown);
  return useMemo(() => {
    if (!suspended || held === shown) return shown;
    const kept = new Set([...held, ...shown].map((entry) => entry.id));
    return entries.filter((entry) => kept.has(entry.id));
  }, [suspended, held, shown, entries]);
}

function appEntries(records: readonly NoticeRecord[]): Entry[] {
  return records
    .filter((record) => !record.dismissed)
    .map((record) => ({
      id: appId(record.key),
      order: record.order,
      app: record,
    }));
}

interface Announcement {
  readonly id: number;
  readonly text: string;
  readonly assertive: boolean;
}
const Announce = createContext<{
  readonly announce: (text: string, assertive: boolean) => void;
  readonly layer: 'page' | 'gate';
  /** A modal covers the stack: its notices wait, hidden but mounted. */
  readonly suspended: boolean;
  /** The notice whose renderer opened the covering modal: it stays drawn. */
  readonly owner: Element | null;
}>({ announce: () => {}, layer: 'page', suspended: false, owner: null });

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
  const regions = (
    <>
      <LiveRegion items={items} assertive={false} />
      <LiveRegion items={items} assertive />
    </>
  );
  return { announce, regions };
}

/**
 * Not atomic, unlike the roles' default: only the added paragraph is read,
 * never the retained ones again.
 */
function LiveRegion({
  items,
  assertive,
}: {
  readonly items: readonly Announcement[];
  readonly assertive: boolean;
}) {
  return (
    <div
      className="sp-notices-live"
      role={assertive ? 'alert' : 'status'}
      aria-live={assertive ? 'assertive' : 'polite'}
      aria-atomic="false"
      aria-relevant="additions"
    >
      {items
        .filter((item) => item.assertive === assertive)
        .map((item) => (
          <p key={item.id}>{item.text}</p>
        ))}
    </div>
  );
}

interface Cover {
  /** A modal covers the stack's layer, or one a renderer opened inside it. */
  readonly modal: boolean;
  /**
   * The notice holding a modal its renderer opened, such as its own
   * confirmation: it stays drawn, so its modal does.
   */
  readonly owner: Element | null;
  /** The height of the avoided zone at the bottom. */
  readonly avoid: number;
  /** The layout viewport's height hidden below the visual viewport. */
  readonly below: number;
  /** The stack's height in a reduced visual viewport, or 0. */
  readonly room: number;
  /** The layout viewport's width hidden left and right of the visual one. */
  readonly left: number;
  readonly right: number;
}
const uncovered: Cover = {
  modal: false,
  owner: null,
  avoid: 0,
  below: 0,
  room: 0,
  left: 0,
  right: 0,
};

/**
 * Inside the gate only these cover the stack: a modal inside the gate itself
 * (its settings, an overlay of a custom renderer), and management or a leave
 * question, which the gate raises above itself. An app modal that was open
 * before the gate lies below it.
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

/**
 * Whether a modal above the stack's layer covers it, the avoided zone at the
 * bottom and the part of the layout viewport the visual viewport hides.
 */
function usePageCover(
  own: RefObject<HTMLElement | null>,
  layer: 'page' | 'gate',
  waiting: boolean,
) {
  const [cover, setCover] = useState<Cover>(uncovered);
  const waits = useRef(waiting);
  const kick = useRef<(() => void) | null>(null);
  // A notice that arrives under a modal starts the per-frame look.
  useEffect(() => {
    waits.current = waiting;
    if (waiting) kick.current?.();
  }, [waiting]);
  useEffect(() => {
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
      // A renderer's own modal inside the stack, such as an inline
      // `<dialog>` opened with `showModal()`, covers the other notices.
      const inner = [...element.querySelectorAll(modalCandidates)].find(
        isModal,
      );
      const owner = inner?.closest('li') ?? null;
      const modal = Boolean(inner) || isCovered(element, layer);
      const height = view.innerHeight;
      // A pinch zoom, or a keyboard that resizes only the visual viewport
      // (Chrome on Android by default, iOS), hides the layout viewport's end.
      // A zoomed one hides its sides as well.
      const visual = view.visualViewport;
      const width = document.documentElement.clientWidth;
      const top = visual ? Math.max(0, visual.offsetTop) : 0;
      const seen = visual
        ? Math.min(height, visual.offsetTop + visual.height)
        : height;
      const below = Math.max(0, Math.floor(height - seen));
      const left = visual ? Math.max(0, Math.floor(visual.offsetLeft)) : 0;
      const right = visual
        ? Math.max(0, Math.floor(width - visual.offsetLeft - visual.width))
        : 0;
      // A zone in the lower half of what the person sees, such as a
      // composer kept at the visible bottom; the page's zones lie behind
      // the gate.
      let avoid = 0;
      for (const zone of layer === 'page'
        ? document.querySelectorAll<HTMLElement>('[data-sempods-notices-avoid]')
        : []) {
        const rect = zone.getBoundingClientRect();
        if (
          rect.height === 0 ||
          rect.top >= seen ||
          rect.bottom < top + (seen - top) / 2
        )
          continue;
        avoid = Math.max(avoid, Math.ceil(height - rect.top));
      }
      // At most 60% of what the person sees, and never above its top; the
      // stack scrolls beyond that.
      const end = height - Math.max(16, avoid + 8, below + 16);
      const fits = Math.floor(Math.min((seen - top) * 0.6, end - top - 16));
      const room = fits < Math.floor(height * 0.6) ? Math.max(0, fits) : 0;
      const next: Cover = { modal, owner, avoid, below, room, left, right };
      setCover((current) =>
        (Object.keys(next) as (keyof Cover)[]).every(
          (name) => current[name] === next[name],
        )
          ? current
          : next,
      );
      // A covering modal may also close through a stylesheet or media
      // query, which no observer reports: while one covers notices that
      // wait, look again each frame; with nothing waiting, never.
      if (modal && waits.current) schedule();
    };
    const schedule = () => {
      if (!frame) frame = view.requestAnimationFrame(measure);
    };
    kick.current = schedule;
    // An avoided zone that grows (an auto-growing composer) moves the stack.
    const sizes =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver(schedule)
        : null;
    const zones = new Set<Element>();
    const watchZones = () => {
      // The page's zones lie behind the gate.
      if (!sizes || layer === 'gate') return;
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
    const changed = (records: readonly MutationRecord[] = []) => {
      const element = own.current;
      // A style or class matters only on a modal or an avoided zone or
      // around one: it may open or close a modal kept mounted but hidden
      // through CSS, or move a zone without resizing it.
      const styled = (record: MutationRecord) =>
        record.attributeName === 'style' || record.attributeName === 'class';
      const watched =
        layer === 'page'
          ? `${modalCandidates}, [data-sempods-notices-avoid]`
          : modalCandidates;
      const candidates = records.some(styled)
        ? [...document.querySelectorAll(watched)]
        : [];
      // A modal a renderer mounts or unmounts, already marked modal.
      const holdsModal = (node: Node) =>
        node.nodeType === Node.ELEMENT_NODE &&
        ((node as Element).matches(modalCandidates) ||
          (node as Element).querySelector(modalCandidates) !== null);
      const counts = (record: MutationRecord) =>
        // Changes inside the stack cover nothing and move no zone, except a
        // renderer's own modal that opens, closes, mounts or unmounts there;
        // one on its root, such as `aria-hidden` from an overlay library,
        // does.
        (record.attributeName === 'open' ||
          record.attributeName === 'aria-modal' ||
          [...record.addedNodes, ...record.removedNodes].some(holdsModal) ||
          !(
            element &&
            element !== record.target &&
            element.contains(record.target)
          )) &&
        (!styled(record) ||
          candidates.some((candidate) => record.target.contains(candidate)));
      if (records.length > 0 && !records.some(counts)) return;
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
        'hidden',
        'inert',
        'aria-hidden',
        'aria-modal',
        'data-sempods-notices-avoid',
        'style',
        'class',
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
      kick.current = null;
    };
  }, [own, layer]);
  return cover;
}
/** How the host places itself, from `usePageCover`. */
function placement(cover: Cover): CSSProperties | undefined {
  const style: Record<string, string> = {};
  if (cover.avoid) style['--sp-notices-avoid'] = `${cover.avoid}px`;
  if (cover.below) style['--sp-notices-below'] = `${cover.below}px`;
  if (cover.room) style['--sp-notices-room'] = `${cover.room}px`;
  if (cover.left) style['--sp-notices-left'] = `${cover.left}px`;
  if (cover.right) style['--sp-notices-right'] = `${cover.right}px`;
  return Object.keys(style).length ? (style as CSSProperties) : undefined;
}

/** Whether a modal above `element`'s layer covers it, right now. */
function isCovered(element: HTMLElement, layer: 'page' | 'gate') {
  const document = element.ownerDocument;
  const gate = layer === 'gate' ? element.closest('dialog') : null;
  if (gate) {
    const order = trackOpened(document, gate);
    const gateOpened = order.get(gate) ?? 0;
    // An overlay inside the gate, such as one of a custom Connections
    // renderer, hides the gate's other content around it.
    const hiddenBy = element.closest('[inert], [aria-hidden="true"]');
    return (
      Boolean(hiddenBy && gate.contains(hiddenBy)) ||
      [...gate.querySelectorAll(modalCandidates)].some(
        (other) =>
          !other.contains(element) &&
          !element.contains(other) &&
          isModal(other),
      ) ||
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
    [...document.querySelectorAll(modalCandidates)].some(
      (other) =>
        !other.contains(element) && !element.contains(other) && isModal(other),
    )
  );
}

/** What may cover the stack: `isCovered` looks at these. */
const modalCandidates = 'dialog[open], [aria-modal="true"]';

function isModal(element: Element) {
  if (element.localName === 'dialog' && !topLayerModal(element)) return false;
  // A dialog kept mounted while hidden covers nothing.
  return rendered(element);
}
/** Whether an open dialog is modal; checked before its costlier styles. */
function topLayerModal(element: Element) {
  // Without a top layer (jsdom), an SDK dialog opens with the attribute.
  if (typeof (element as HTMLDialogElement).showModal !== 'function')
    return true;
  try {
    return element.matches(':modal');
  } catch {
    return true;
  }
}

/** Whether `element` is drawn: not hidden, `display: none` or invisible. */
function rendered(element: Element): boolean {
  if (element.closest('[hidden]')) return false;
  if (typeof element.checkVisibility === 'function') {
    if (
      element.checkVisibility({
        visibilityProperty: true,
        checkVisibilityCSS: true,
      })
    )
      return true;
    // Without a box of its own (`display: contents`), it is drawn when what
    // it contains is.
    const view = element.ownerDocument.defaultView;
    return (
      view?.getComputedStyle(element).display === 'contents' &&
      [...element.children].some(rendered)
    );
  }
  // Without it (jsdom), from the computed styles.
  const view = element.ownerDocument.defaultView;
  if (!view) return true;
  if (view.getComputedStyle(element).visibility === 'hidden') return false;
  for (let at: Element | null = element; at; at = at.parentElement)
    if (view.getComputedStyle(at).display === 'none') return false;
  return true;
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
  const limit = limitOf(props.limit);
  const Notice = props.components?.Notice;
  const accessPrompts = props.accessPrompts ?? true;
  const { focusTarget } = props;
  // Before the first paint, so `AppAccess` never shows the access prompts
  // for a frame before this stack takes them.
  useLayoutEffect(() => () => store.unregister(token), [store, token]);
  useLayoutEffect(
    () => store.register({ token, limit, Notice, accessPrompts, focusTarget }),
    [store, token, limit, Notice, accessPrompts, focusTarget],
  );
  // One stack per provider, also with several hosts: the first registered.
  const first = useNoticeHost()?.token === token;
  const records = useNoticeRecords();
  const { blocking, prompts } = useAccessPrompts();
  const starting = useAppFacts((s) => s.starting);
  const gateMounted = useMounted('gate');
  const { direction } = useSdkLocale();
  const root = useRef<HTMLDivElement>(null);
  const { announce, regions } = useAnnouncer();
  const live = useRef(new Set<string>());
  const entries = useMemo(() => {
    const access: Entry[] =
      blocking || starting || !accessPrompts
        ? []
        : prompts.map((prompt) => ({
            id: prompt.id,
            order: store.orderOf(prompt.id),
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
  const cover = usePageCover(
    root,
    'page',
    first && !gated && entries.length > 0,
  );
  const shown = useDrawn(!first || gated ? none : entries, limit, cover.modal);
  return (
    <div
      ref={root}
      data-sempods-ui="notices"
      dir={direction}
      style={placement(cover)}
    >
      <SdkStyles />
      <style href="sempods-notices" precedence="sempods">
        {layered(styles)}
      </style>
      {first && regions}
      <NoticeList
        entries={shown}
        layer="page"
        suspended={cover.modal}
        owner={cover.owner}
        announce={announce}
        focusTarget={focusTarget}
        Notice={Notice}
      />
    </div>
  );
}

/**
 * Internal: the app notices inside the sign-in gate, so a waiting update
 * shows before sign-in. Only with a mounted `Notices` host, whose renderer
 * and limit it uses; the gate keeps room for it at its end.
 */
export function GateNotices() {
  const host = useNoticeHost();
  return host ? <GateStack host={host} /> : null;
}

function GateStack({ host }: { readonly host: Host }) {
  const records = useNoticeRecords();
  const { direction } = useSdkLocale();
  const { announce, regions } = useAnnouncer();
  const root = useRef<HTMLDivElement>(null);
  const entries = useMemo(() => appEntries(records), [records]);
  // A dialog above the gate, such as the app's settings, makes the stack
  // wait: its notices time out and are announced once it closes.
  const cover = usePageCover(root, 'gate', entries.length > 0);
  const shown = useDrawn(entries, host.limit, cover.modal);
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
  return (
    <div
      ref={root}
      data-sempods-ui="notices"
      data-placement="gate"
      dir={direction}
      style={placement(cover)}
    >
      <style href="sempods-notices" precedence="sempods">
        {layered(styles)}
      </style>
      {regions}
      <NoticeList
        entries={shown}
        layer="gate"
        suspended={cover.modal}
        owner={cover.owner}
        announce={announce}
        // The app's focus target is inert behind the gate: focus returns to
        // where it came from inside the gate.
        focusTarget={undefined}
        Notice={host.Notice}
      />
    </div>
  );
}

function useNoticeRecords() {
  const store = useNoticeStore();
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
}

/**
 * The shown notices of one host, each in its kind's guarded view. While a
 * modal covers them they stay mounted but hidden, without timers or
 * announcements, so an overlay their renderer opened, such as its own
 * confirmation in a portal, stays open.
 */
function NoticeList({
  entries,
  layer,
  suspended,
  owner,
  announce,
  focusTarget,
  Notice = DefaultNotice,
}: {
  readonly entries: readonly Entry[];
  readonly layer: 'page' | 'gate';
  readonly suspended: boolean;
  readonly owner: Element | null;
  readonly announce: (text: string, assertive: boolean) => void;
  readonly focusTarget: RefObject<HTMLElement | null> | undefined;
  readonly Notice: ComponentType<NoticeProps> | undefined;
}) {
  const store = useNoticeStore();
  const value = useMemo(
    () => ({ announce, layer, suspended, owner }),
    [announce, layer, suspended, owner],
  );
  // Without a focus target of its own, the host returns focus from an
  // access prompt as `AppAccess` would: to its current `focusTarget`, read
  // when focus returns.
  const promptFocus = useMemo<RefObject<HTMLElement | null>>(
    () => ({
      get current() {
        return (focusTarget ?? store.accessFocusTarget())?.current ?? null;
      },
    }),
    [focusTarget, store],
  );
  return (
    <Announce.Provider value={value}>
      <ul hidden={entries.length === 0 || (suspended && !owner)}>
        {entries.map((entry) =>
          entry.prompt ? (
            <AccessNoticeItem
              key={entry.id}
              entry={entry}
              prompt={entry.prompt}
              focusTarget={promptFocus}
              Notice={Notice}
            />
          ) : (
            <AppNoticeItem
              key={entry.id}
              entry={entry}
              record={entry.app!}
              focusTarget={focusTarget}
              Notice={Notice}
            />
          ),
        )}
      </ul>
    </Announce.Provider>
  );
}

interface ItemProps {
  readonly entry: Entry;
  readonly focusTarget: RefObject<HTMLElement | null> | undefined;
  readonly Notice: ComponentType<NoticeProps>;
}

function NoticeItem({
  entry,
  view,
  focusTarget,
  Notice,
}: ItemProps & { readonly view: NoticeView }) {
  const store = useNoticeStore();
  const { announce, layer, suspended, owner } = useContext(Announce);
  const event = entry.app?.event ?? 0;
  const message = [view.pod, view.title, view.text].filter(Boolean).join('. ');
  const element = useRef<HTMLLIElement>(null);
  // Also as state, to keep the notice that holds the covering modal drawn.
  const [drawn, setDrawn] = useState<HTMLLIElement | null>(null);
  const attach = useCallback((node: HTMLLIElement | null) => {
    element.current = node;
    setDrawn(node);
  }, []);
  // Once per event, when it first shows uncovered: here, in the gate or
  // after a modal. A modal that opened in the same event as the notice is
  // seen at once, before the host measures it: the event waits for it.
  useEffect(() => {
    if (!message || suspended) return;
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
  }, [store, entry.id, event, suspended]);
  // Timer, paused while hovered, focused or covered; a repeat or a new event
  // restarts it, an update in place (a language change) does not.
  const [held, setHeld] = useState({ hover: false, focus: false });
  const duration = durationOf(entry);
  const renewed = entry.app?.renewed ?? 0;
  const expire = useCommitted(view.dismiss);
  useEffect(() => {
    if (suspended || duration === null || held.hover || held.focus) return;
    // Hiding dismisses it, so a remount or a second host does not replay it.
    const timer = setTimeout(() => expire.current?.(), duration);
    return () => clearTimeout(timer);
  }, [suspended, duration, held.hover, held.focus, renewed, event, expire]);
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
      ref={attach}
      hidden={suspended && owner !== drawn}
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
        // A dialog the renderer opened, in a portal or inside the notice,
        // handles its own Escape: it closes the dialog, not the notice.
        if (
          event.key === 'Escape' &&
          view.dismiss &&
          !inRendererDialog(event.currentTarget, event.target)
        ) {
          event.stopPropagation();
          view.dismiss();
        }
      }}
    >
      <Notice notice={view} />
    </li>
  );
}

/** Whether a key event on a notice comes from a dialog its renderer opened. */
function inRendererDialog(item: HTMLElement, target: EventTarget) {
  // React events bubble from a portal, which lies outside the notice.
  if (!(target instanceof Node) || !item.contains(target)) return true;
  const from = target instanceof Element ? target : target.parentElement;
  const dialog = from?.closest(
    'dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]',
  );
  // The gate around the stack is a dialog too.
  return Boolean(dialog && item.contains(dialog));
}

/**
 * The guards both kinds share: running and its failure are kept per notice
 * in the store, so a remount (after a modal, in another host, after
 * sign-in) never runs it twice at once and shows its failure again.
 */
function useGuardedRun(id: string) {
  const app = useController();
  const store = useNoticeStore();
  const { changing, confirmingLeave } = useAppFacts(
    (s) => ({ changing: s.changing, confirmingLeave: s.confirmingLeave }),
    (a, b) =>
      a.changing === b.changing && a.confirmingLeave === b.confirmingLeave,
  );
  const { messages: m, error } = useSdkLocale();
  const busy = useSyncExternalStore(
    store.subscribe,
    () => store.isRunning(id),
    () => store.isRunning(id),
  );
  const failure = useSyncExternalStore(
    store.subscribe,
    () => store.failureOf(id),
    () => store.failureOf(id),
  );
  const guarded =
    (run: () => Promise<unknown>, current = () => true) =>
    () => {
      // Read again when it runs: a renderer may call a callback it kept from
      // an earlier render, while a guarded change has started since, or the
      // notice it showed has been replaced.
      if (!current()) return;
      const now = app.getSnapshot();
      const token =
        now.changing || now.confirmingLeave ? null : store.begin(id);
      if (token === null) return;
      void run().then(
        () => store.end(id, token),
        (cause: unknown) => store.end(id, token, { cause }),
      );
    };
  return {
    disabled: busy || changing || confirmingLeave,
    guarded,
    failure: failure ? error(failure.cause) : null,
    dismissLabel: m.controls.dismiss ?? m.controls.close ?? 'OK',
  };
}

function AccessNoticeItem({
  prompt,
  ...props
}: ItemProps & { readonly prompt: AccessPromptFact }) {
  const app = useController();
  const { fixed, connections, activeId } = useAppFacts(
    (s) => ({
      fixed: Boolean(s.preset?.podUrl ?? s.allowedPods?.length === 1),
      connections: s.connections,
      activeId: s.activeId,
    }),
    (a, b) =>
      a.fixed === b.fixed &&
      a.connections === b.connections &&
      a.activeId === b.activeId,
  );
  const { messages: m } = useSdkLocale();
  const text = usePromptText(prompt);
  const { disabled, guarded, failure, dismissLabel } = useGuardedRun(prompt.id);
  const c = connections.find((entry) => entry.id === prompt.connectionId);
  const view: NoticeView = {
    key: prompt.id,
    source: 'access',
    reason: prompt.reason,
    severity: prompt.severity === 'info' ? 'info' : 'warning',
    title: null,
    text,
    pod: c && c.id !== activeId ? podName(c.podUrl) : null,
    link: prompt.providerLink
      ? {
          href: prompt.providerLink,
          label: m.controls.providerLink ?? m.controls.signIn,
        }
      : null,
    actions: offeredActions(prompt, fixed)
      .filter((action) => action !== 'dismiss')
      .map((action, index) => ({
        label: promptActionLabel(m, prompt, action),
        primary: prompt.severity !== 'info' && index === 0,
        disabled,
        run: guarded(() => runAccessAction(app, prompt, action)),
      })),
    failure,
    dismiss: prompt.actions.includes('dismiss')
      ? () => void app.dismiss(prompt.id)
      : null,
    dismissLabel,
  };
  return <NoticeItem {...props} view={view} />;
}

function AppNoticeItem({
  record,
  ...props
}: ItemProps & { readonly record: NoticeRecord }) {
  const store = useNoticeStore();
  const { disabled, guarded, failure, dismissLabel } = useGuardedRun(
    appId(record.key),
  );
  const notice = record.notice;
  // A renderer may keep a callback, for an exit animation or its own
  // confirmation: it acts only on the event it was shown for, while that
  // shows and has not been dismissed. `useNotices().dismiss` stays by key.
  const current = () => {
    const now = store.recordOf(record.key);
    return now?.event === record.event && !now.dismissed;
  };
  const view: NoticeView = {
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
              // A shown notice has done its job, unless the action showed
              // it again; a held one is its holder's.
              store.settle(record.key, before);
            }, current),
          },
        ]
      : [],
    failure,
    dismiss: () => {
      if (current()) store.dismiss(record.key);
    },
    dismissLabel,
  };
  return <NoticeItem {...props} view={view} />;
}

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
  left:max(16px, env(safe-area-inset-left, 0px), var(--sp-notices-left, 0px) + 16px);
  right:max(16px, env(safe-area-inset-right, 0px), var(--sp-notices-right, 0px) + 16px);
  inset-block-end:calc(max(16px + env(safe-area-inset-bottom, 0px), var(--sp-notices-avoid, 0px) + 8px, var(--sp-notices-below, 0px) + 16px) + var(--sempods-notices-offset, 0px));
}
[data-sempods-ui="notices"] .sp-notices-live { position:absolute; width:1px; height:1px; margin:-1px; padding:0; overflow:hidden; clip-path:inset(50%); white-space:nowrap; border:0; }
[data-sempods-ui="notices"] ul { list-style:none; margin:0 auto; padding:0; display:grid; gap:8px; max-width:28rem; max-block-size:min(60vh, var(--sp-notices-room, 60vh)); overflow-y:auto; pointer-events:auto; }
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
@keyframes sp-notice-in { from { opacity:0; transform:translateY(8px); } }
@media (prefers-reduced-motion: reduce) { [data-sempods-ui="notices"] li { animation:none; } }
`;
