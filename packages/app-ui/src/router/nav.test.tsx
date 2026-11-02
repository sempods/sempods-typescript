// @vitest-environment jsdom
// The router's history bookkeeping with a stand-in for the SDK's navigate.
// The routing matrix of the packed UI gate (`pnpm test:ui`) checks it with
// the real SDK in Chromium, WebKit and Firefox.
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import type { AddressModel, Nav } from './nav.js';

/** The pending decision of the stand-in navigate, or none: leave at once. */
let ask: ((left: boolean) => void) | null = null;
let asking = false;
/** Resolves "left" without running the action, like a disposed runtime. */
let skipping = false;
const navigate = vi.fn((action: () => void) => {
  if (skipping) return Promise.resolve(true);
  if (!asking) {
    action();
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    ask = (left) => {
      ask = null;
      if (left) action();
      resolve(left);
    };
  });
});
/** The navigate the next mounted frame gets. */
let frameNavigate = navigate;
vi.mock('@sempods/app-sdk/react', () => ({
  useApp: () => ({ navigate: frameNavigate }),
}));

type Place = { readonly page: string };
const model: AddressModel<Place> = {
  parse(pathname, search) {
    const page = pathname.slice(1);
    // A legacy query link becomes canonical; unknown addresses keep theirs.
    if (page === '' && search.startsWith('?old='))
      return {
        place: { page: search.slice(5) },
        canonical: '/' + search.slice(5),
      };
    if (['', 'list', 'task', 'other'].includes(page))
      return { place: { page }, canonical: pathname + search };
    return { place: { page: 'missing' }, canonical: pathname + search };
  },
  format: (place) => '/' + place.page,
};

let nav: Nav<Place>;
function Frame() {
  nav = useNav(model);
  return (
    <a data-testid="link" {...nav.link({ page: 'other' })}>
      {nav.place.page}
    </a>
  );
}
let useNav: typeof import('./nav.js').useNav;
beforeAll(async () => {
  // The module keeps the document's history from its first use on.
  history.replaceState(null, '', '/?old=list');
  ({ useNav } = await import('./nav.js'));
});
afterEach(() => {
  cleanup();
  asking = false;
  skipping = false;
  ask = null;
  frameNavigate = navigate;
});

/** Runs `action` and waits for the history event it causes. */
async function after(event: 'popstate' | 'hashchange', action: () => void) {
  await act(async () => {
    const fired = new Promise((resolve) =>
      addEventListener(event, resolve, { once: true }),
    );
    action();
    await fired;
  });
}
/** Moves through the history and waits for its popstate. */
const traverse = (delta: number) => after('popstate', () => history.go(delta));
const shown = () => screen.getByTestId('link').textContent;
const address = () => location.pathname + location.search;
const state = () => history.state as { position?: number; from?: number };

it('replaces a known address by its canonical form in place', () => {
  const length = history.length;
  const { rerender } = render(<Frame />);
  expect(shown()).toBe('list');
  expect(address()).toBe('/list');
  expect(history.length).toBe(length);
  expect(state().position).toBe(0);
  // The same place keeps the same `nav`.
  const first = nav;
  rerender(<Frame />);
  expect(nav).toBe(first);
});

it('pushes a switch with its opener position and replaces in place', async () => {
  render(<Frame />);
  const length = history.length;
  act(() => nav.go({ page: 'task' }));
  expect([address(), shown(), history.length]).toEqual([
    '/task',
    'task',
    length + 1,
  ]);
  expect(state()).toEqual({ position: 1, from: 0 });
  act(() => nav.go({ page: 'other' }, { replace: true }));
  expect([address(), history.length]).toEqual(['/other', length + 1]);
  // The opener stays with the entry.
  expect(state()).toEqual({ position: 1, from: 0 });
  await traverse(-1);
  expect(shown()).toBe('list');
});

it('switches on a plain click and leaves modified clicks to the browser', () => {
  render(<Frame />);
  const link = screen.getByTestId('link');
  expect(link.getAttribute('href')).toBe('/other');
  expect(fireEvent.click(link, { ctrlKey: true })).toBe(true);
  expect(address()).toBe('/list');
  expect(fireEvent.click(link)).toBe(false);
  expect(address()).toBe('/other');
});

it('closes to the opener, or replaces with the fallback after a direct entry', async () => {
  render(<Frame />);
  expect(state().from).toBe(0);
  await after('popstate', () => nav.close({ page: '' }));
  expect([address(), shown()]).toEqual(['/list', 'list']);
  // The document's first entry has no opener.
  const length = history.length;
  act(() => nav.close({ page: '' }));
  expect([address(), shown(), history.length]).toEqual(['/', '', length]);
});

it('undoes a declined Back and decides once for moves during the question', async () => {
  render(<Frame />);
  act(() => nav.go({ page: 'task' }));
  const at = state().position!;
  asking = true;
  navigate.mockClear();
  await traverse(-1);
  expect(navigate).toHaveBeenCalledTimes(1);
  // Forward and Back again while the question is open: no second question.
  await traverse(1);
  await traverse(-1);
  expect(navigate).toHaveBeenCalledTimes(1);
  expect(shown()).toBe('task');
  // Staying returns to the shown entry; its popstate asks nothing.
  await after('popstate', () => ask!(false));
  expect([address(), shown(), state().position]).toEqual(['/task', 'task', at]);
  expect(navigate).toHaveBeenCalledTimes(1);
  // Leaving applies to where the browser is when the answer comes.
  await traverse(-1);
  await traverse(1);
  await act(async () => ask!(true));
  expect([address(), shown(), state().position]).toEqual(['/task', 'task', at]);
  expect(navigate).toHaveBeenCalledTimes(2);
});

it('keeps unknown addresses and shows the address again on a foreign entry', async () => {
  render(<Frame />);
  act(() => nav.go({ page: 'nowhere' } as Place));
  expect([address(), shown()]).toEqual(['/nowhere', 'missing']);
  // An entry the router did not write, declined: the shown address returns.
  await act(async () => history.pushState(null, '', '/list'));
  asking = true;
  await traverse(-1);
  await traverse(1);
  await act(async () => ask!(false));
  expect([address(), shown(), state().position]).toEqual([
    '/nowhere',
    'missing',
    expect.any(Number),
  ]);
});

it('counts a fragment entry, so a declined Back returns to the shown entry', async () => {
  render(<Frame />);
  act(() => nav.go({ page: 'list' }));
  const list = state().position!;
  // A fragment link: a new entry at the same address, without a position.
  await after('hashchange', () => (location.hash = 'section'));
  expect(state().position).toBe(list + 1);
  act(() => nav.go({ page: 'task' }));
  expect(state().position).toBe(list + 2);
  asking = true;
  await traverse(-2);
  await after('popstate', () => ask!(false));
  expect([address(), shown(), state().position]).toEqual([
    '/task',
    'task',
    list + 2,
  ]);
});

it('closes to the opener past a fragment entry of the screen', async () => {
  render(<Frame />);
  act(() => nav.go({ page: 'list' }));
  act(() => nav.go({ page: 'task' }));
  const task = state();
  await after('hashchange', () => (location.hash = 'notes'));
  expect(state()).toEqual({ ...task, position: task.position! + 1 });
  await after('popstate', () => nav.close({ page: '' }));
  expect([address(), shown(), state().position]).toEqual([
    '/list',
    'list',
    task.position! - 1,
  ]);
});

it('follows moves made while no frame was mounted', () => {
  render(<Frame />);
  cleanup();
  act(() => history.pushState({ position: 40 }, '', '/task'));
  render(<Frame />);
  expect([shown(), address()]).toEqual(['task', '/task']);
  act(() => nav.go({ page: 'list' }));
  expect(state()).toEqual({ position: 41, from: 40 });
});

it('compares addresses as the browser keeps them', () => {
  render(<Frame />);
  act(() => nav.go({ page: 'li st' }));
  expect(address()).toBe('/li%20st');
  const length = history.length;
  act(() => nav.go({ page: 'li st' }));
  expect(history.length).toBe(length);
});

it("asks a remaining frame's navigate after another frame unmounts", async () => {
  render(<Frame />);
  act(() => nav.go({ page: 'task' }));
  const other = vi.fn((action: () => void) => navigate(action));
  frameNavigate = other;
  const second = render(<Frame />);
  second.unmount();
  navigate.mockClear();
  await traverse(-1);
  expect(other).not.toHaveBeenCalled();
  expect(navigate).toHaveBeenCalledTimes(1);
});

it('decides once when navigate leaves without running the move', async () => {
  render(<Frame />);
  act(() => nav.go({ page: 'task' }));
  skipping = true;
  navigate.mockClear();
  await traverse(-1);
  await act(async () => {});
  expect(navigate).toHaveBeenCalledTimes(1);
  expect(shown()).toBe('task');
});
