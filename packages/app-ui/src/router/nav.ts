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
  /** Set while the router undoes a declined step; it ignores that popstate. */
  undoing: boolean;
  /**
   * Set while the SDK decides about a Back or Forward. Further moves the
   * browser makes meanwhile start no second decision: the outcome applies to
   * where the browser is when it ends, never to an earlier target.
   */
  deciding: boolean;
  /** The SDK's `navigate` of the mounted frame. */
  navigate?: (action: () => void) => Promise<boolean>;
  /** Mounted `useNav` calls; the history listeners exist while any is. */
  frames: number;
}

// Created on first use, so importing the package touches no browser global.
let session: Session | undefined;
const listeners = new Set<() => void>();

const here = () => location.pathname + location.search;
const entry = (): Readonly<Record<string, unknown>> =>
  history.state !== null && typeof history.state === 'object'
    ? (history.state as Record<string, unknown>)
    : {};
const positionOf = () => {
  const position = entry().position;
  return typeof position === 'number' ? position : undefined;
};

function current(): Session {
  if (!session) {
    const position = positionOf();
    // The document's entry gets the router's position.
    if (position === undefined)
      history.replaceState({ ...entry(), position: 0 }, '');
    session = {
      shown: here(),
      position: position ?? 0,
      undoing: false,
      deciding: false,
      frames: 0,
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
 * Replaces the address in place, keeping the entry's position and opener.
 * Pass it to `createBrowserRuntime({ replaceUrl })`, so the address the
 * runtime returns to after sign-in is the one the app shows.
 */
export function replaceUrl(url: string): void {
  history.replaceState({ ...entry(), position: current().position }, '', url);
  show(here());
}

/**
 * An entry at the shown address: nothing to decide. A fragment link adds one
 * without the router's position, right after the shown entry; it takes the
 * next position, so the router's offsets keep matching the history.
 */
function adopt(s: Session) {
  const position = positionOf();
  if (position !== undefined) s.position = position;
  else {
    s.position += 1;
    history.replaceState({ ...entry(), position: s.position }, '');
  }
}

function onPop() {
  const s = current();
  if (s.undoing) {
    s.undoing = false;
    return;
  }
  if (s.deciding) return;
  if (here() === s.shown) adopt(s);
  else void decide(s);
}

// A fragment navigation fires popstate in current browsers; hashchange
// covers one that does not.
function onHash() {
  const s = current();
  if (
    !s.undoing &&
    !s.deciding &&
    here() === s.shown &&
    positionOf() === undefined
  )
    adopt(s);
}

async function decide(s: Session) {
  s.deciding = true;
  // Without a mounted frame there is no leave policy to ask.
  const navigate =
    s.navigate ??
    (async (action: () => void) => {
      action();
      return true;
    });
  // A refused or failed decision stays.
  const left = await navigate(() => {
    // Leaving: show the entry the browser is on now.
    s.position = positionOf() ?? s.position;
    show(here());
  }).catch(() => false);
  s.deciding = false;
  if (left) {
    // The browser moved on after the decision applied: decide again.
    if (here() !== s.shown) onPop();
    return;
  }
  // Staying: back to the shown entry, keeping the history intact. An entry
  // without the router's position cannot be measured; it shows the shown
  // address again in place.
  const target = positionOf();
  if (target === undefined)
    history.replaceState({ ...entry(), position: s.position }, '', s.shown);
  else if (target !== s.position) {
    s.undoing = true;
    history.go(s.position - target);
  }
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
 * `SempodsProvider`, and pass `nav` down.
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
    s.navigate = navigate;
    if (s.frames++ === 0) {
      addEventListener('popstate', onPop);
      addEventListener('hashchange', onHash);
    }
    return () => {
      if (--s.frames > 0) return;
      removeEventListener('popstate', onPop);
      removeEventListener('hashchange', onHash);
      s.navigate = undefined;
    };
  }, [navigate]);
  useEffect(() => {
    if (address !== canonical) replaceUrl(canonical);
  }, [address, canonical]);
  const go = useCallback(
    (next: P, options?: { readonly replace?: boolean }) => {
      const url = model.format(next);
      const s = current();
      if (url === s.shown) return;
      void navigate(() => {
        if (options?.replace)
          history.replaceState({ ...entry(), position: s.position }, '', url);
        else {
          const opener = s.shown;
          s.position += 1;
          history.pushState({ position: s.position, opener }, '', url);
        }
        show(here());
      });
    },
    [navigate, model],
  );
  const close = useCallback(
    (fallback: P) => {
      if (typeof entry().opener === 'string') history.back();
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
  return { place, go, close, link };
}
