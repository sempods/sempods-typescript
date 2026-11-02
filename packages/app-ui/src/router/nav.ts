import {
  useCallback,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type MouseEvent,
} from 'react';
import { useApp } from '@sempods/app-sdk/react';

/**
 * How an app maps its places to addresses and back. The app owns it, so its
 * addresses, legacy forms and error pages stay its own; the router only
 * moves through the browser history.
 */
export interface AddressModel<P> {
  /**
   * The place of an address (`search` is empty or starts with `?`) and the
   * address's canonical form. A known address in another form, such as a
   * legacy link, names its canonical form, which replaces it in place; an
   * unknown or invalid address names itself, so its explicit page keeps the
   * address the person followed.
   */
  parse(
    pathname: string,
    search: string,
  ): { readonly place: P; readonly canonical: string };
  /** The address of a place: path and query, starting with the app's path. */
  format(place: P): string;
}

/** Props for an `<a>` that switches to a place. */
export interface NavLinkProps {
  /** The place's real address, so a modified click opens a new tab. */
  readonly href: string;
  /** A plain left click switches in place through `go`. */
  readonly onClick: (event: MouseEvent<HTMLAnchorElement>) => void;
}

/** What `useNav` returns. */
export interface Nav<P> {
  /** The place of the address the app shows. */
  readonly place: P;
  /**
   * Switches to a place under the SDK's leave policy: as a new history entry,
   * or in place with `replace`. Declined, the address and the screen stay.
   */
  go(place: P, options?: { readonly replace?: boolean }): void;
  /**
   * Leaves a screen: back to the in-app place that opened it, else, after a
   * direct entry, to `fallback` in place, without a new history entry.
   */
  close(fallback: P): void;
  /** Props for an `<a>` to a place: a real `href` and an in-place switch. */
  link(place: P): NavLinkProps;
}

/** What the router keeps about the session history of this document. */
interface Session {
  /** The address the app shows; it changes only through the router. */
  shown: string;
  /** The position of the shown entry, kept in its `history.state`. */
  position: number;
  /**
   * The position of the in-app entry that opened the shown entry, kept in its
   * `history.state` too; `close` goes back to it.
   */
  from?: number;
  /**
   * The router's position minus the browser's history index, where the
   * browser tells the index (the Navigation API); it measures entries
   * without the router's state.
   */
  offset?: number;
  /**
   * Set while the SDK decides about a Back or Forward. Further moves the
   * browser makes meanwhile start no second decision: the outcome applies to
   * where the browser is when it ends, never to an earlier target.
   */
  deciding: boolean;
  /**
   * The SDK's `navigate` of each mounted `useNav` call, the latest last; the
   * history listener exists while any is mounted.
   */
  frames: ((action: () => void) => Promise<boolean>)[];
}

// Created on first use, so importing the package touches no browser global.
let session: Session | undefined;
const listeners = new Set<() => void>();

const here = () => location.pathname + location.search;
/**
 * An address of this document's origin as the browser keeps it, so it
 * compares with `here()`; a path that starts with `//` stays a path.
 */
const normal = (address: string) => {
  const url = new URL(location.origin + address);
  return url.pathname + url.search;
};
/** The address as a URL of this origin, for the history. */
const own = (address: string) => location.origin + normal(address);
/** The browser's index of the current entry, where it tells it. */
const index = () =>
  (
    globalThis as {
      readonly navigation?: {
        readonly currentEntry?: { index: number } | null;
      };
    }
  ).navigation?.currentEntry?.index;
/** The position of the current entry as measured by its index, if known. */
const measured = (s: Session) => {
  const at = index();
  return at === undefined || s.offset === undefined ? undefined : at + s.offset;
};
const entry = (): Readonly<Record<string, unknown>> =>
  history.state !== null && typeof history.state === 'object'
    ? (history.state as Record<string, unknown>)
    : {};
const positionOf = () => {
  const position = entry().position;
  return typeof position === 'number' ? position : undefined;
};
const fromOf = () => {
  const from = entry().from;
  return typeof from === 'number' ? from : undefined;
};
/** The router's state for the shown entry, over what else the entry holds. */
const stamp = (s: Session) => ({
  ...entry(),
  position: s.position,
  ...(s.from === undefined ? {} : { from: s.from }),
});
/** Follows the entry the browser is on. */
function sync(s: Session) {
  s.position = positionOf() ?? measured(s) ?? s.position;
  s.from = fromOf();
}

function current(): Session {
  if (!session) {
    const position = positionOf();
    // The document's entry gets the router's position.
    if (position === undefined)
      history.replaceState({ ...entry(), position: 0 }, '');
    const at = index();
    session = {
      shown: here(),
      position: position ?? 0,
      from: fromOf(),
      ...(at === undefined ? {} : { offset: (position ?? 0) - at }),
      deciding: false,
      frames: [],
    };
  }
  return session;
}

function show(address: string) {
  current().shown = address;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/**
 * Replaces the address in place, keeping the entry's router state.
 * Pass it to `createBrowserRuntime({ replaceUrl })`, so the address the
 * runtime returns to after sign-in is the one the app shows.
 */
export function replaceUrl(url: string): void {
  history.replaceState(stamp(current()), '', url);
  show(here());
}

/**
 * An entry at the shown address: nothing to decide. It is the shown entry
 * again, after a declined move was undone, or a fragment link's entry. That
 * one has no router state: a link adds it right after the shown entry, a
 * replaced fragment takes the shown entry's place. It gets its measured
 * position, else the next one, keeping the router's offsets in step with the
 * history, and the shown entry's opener position, so `close` still returns
 * to it.
 */
function adopt(s: Session) {
  if (positionOf() !== undefined) sync(s);
  else {
    s.position = measured(s) ?? s.position + 1;
    history.replaceState(stamp(s), '');
  }
}

// Fragment navigations fire popstate too.
function onPop() {
  const s = current();
  // A fragment link's entry is counted even while the SDK asks.
  if (here() === s.shown && positionOf() === undefined) return adopt(s);
  if (s.deciding) return;
  if (here() === s.shown) adopt(s);
  else void decide(s);
}

async function decide(s: Session) {
  s.deciding = true;
  // Without a mounted frame there is no leave policy to ask.
  const navigate =
    s.frames.at(-1) ??
    (async (action: () => void) => {
      action();
      return true;
    });
  let moved = false;
  // A refused or failed decision stays.
  const left = await navigate(() => {
    // Leaving: show the entry the browser is on now.
    moved = true;
    sync(s);
    show(here());
  }).catch(() => false);
  s.deciding = false;
  if (left) {
    // The browser moved on after the decision applied: decide again.
    if (moved && here() !== s.shown) onPop();
    return;
  }
  // Staying: back to the shown entry, keeping the history intact; its
  // popstate is at the shown address and asks nothing. An entry without the
  // router's position that the browser does not measure either shows the
  // shown address again in place.
  const target = positionOf() ?? measured(s);
  if (target === undefined) history.replaceState(stamp(s), '', own(s.shown));
  else if (target !== s.position) history.go(s.position - target);
}

const plainClick = (event: MouseEvent<HTMLAnchorElement>) =>
  !event.defaultPrevented &&
  event.button === 0 &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.shiftKey &&
  !event.altKey &&
  (!event.currentTarget.target || event.currentTarget.target === '_self');

/**
 * The place of the shown address and the navigation to other places, over
 * the app's address model. Every `go`, Back and Forward runs through the
 * SDK's `navigate`, so an unsaved edit asks first, and staying keeps the
 * address, the screen and the history. A known address in another form is
 * replaced by its canonical form. Call it once, in the app's frame inside
 * `SempodsProvider`, with a model that keeps its identity (a module-level
 * constant), and pass `nav` down; it changes only with the place.
 */
export function useNav<P>(model: AddressModel<P>): Nav<P> {
  const address = useSyncExternalStore(subscribe, () => current().shown);
  const { navigate } = useApp();
  const { place, canonical } = useMemo(() => {
    const query = address.indexOf('?');
    return query < 0
      ? model.parse(address, '')
      : model.parse(address.slice(0, query), address.slice(query));
  }, [address, model]);
  useEffect(() => {
    const s = current();
    if (s.frames.push(navigate) === 1) {
      // Moves while no frame listened: follow the entry the browser is on.
      sync(s);
      if (here() !== s.shown) show(here());
      addEventListener('popstate', onPop);
    }
    return () => {
      s.frames.splice(s.frames.lastIndexOf(navigate), 1);
      if (s.frames.length === 0) removeEventListener('popstate', onPop);
    };
  }, [navigate]);
  useEffect(() => {
    if (address !== normal(canonical)) replaceUrl(own(canonical));
  }, [address, canonical]);
  const go = useCallback(
    (next: P, options?: { readonly replace?: boolean }) => {
      const url = normal(model.format(next));
      const s = current();
      if (url === s.shown) return;
      void navigate(() => {
        if (options?.replace) history.replaceState(stamp(s), '', own(url));
        else {
          s.from = s.position;
          s.position += 1;
          history.pushState(
            { position: s.position, from: s.from },
            '',
            own(url),
          );
        }
        show(here());
      });
    },
    [navigate, model],
  );
  const close = useCallback(
    (fallback: P) => {
      // Back to the opener, past any fragment entries of this screen.
      const { from, position } = current();
      if (from !== undefined && from < position) history.go(from - position);
      else go(fallback, { replace: true });
    },
    [go],
  );
  const link = useCallback(
    (next: P): NavLinkProps => ({
      href: model.format(next),
      onClick: (event) => {
        if (!plainClick(event)) return;
        event.preventDefault();
        go(next);
      },
    }),
    [go, model],
  );
  return useMemo(() => ({ place, go, close, link }), [place, go, close, link]);
}
