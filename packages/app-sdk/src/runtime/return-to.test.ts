/**
 * `returnTo` as a function: the address the person is on when a sign-in starts
 * is where the callback returns, with the same safety checks as a string.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { createBrowserRuntime } from './runtime.js';
import type { BrowserRuntime } from './types.js';
import { callback, fixture, pod, settleLease } from './fixture.test.js';

const runtimes: BrowserRuntime[] = [];
afterEach(() => runtimes.splice(0).forEach((r) => r.dispose()));

it('returns to the address current when the sign-in started, after in-app navigation', async () => {
  let address = '/';
  const returnTo = vi.fn(() => address);
  const f = fixture({ preferences: null, returnTo });
  runtimes.push(f.runtime);
  await f.runtime.initialize();
  const connection = await f.runtime.connect(pod);
  expect(returnTo).not.toHaveBeenCalled();
  address = '/items/add?list=groceries#new';
  await f.runtime.beginAuthorization(connection.id);
  expect(returnTo).toHaveBeenCalledTimes(1);
  f.runtime.dispose();
  await settleLease();
  // On the callback route the stored address counts; the function is not used.
  address = new URL(callback).pathname;
  const back = f.returned();
  runtimes.push(back);
  expect(await back.initialize()).toMatchObject({ interaction: 'completed' });
  expect(f.replaceUrl).toHaveBeenLastCalledWith(
    '/items/add?list=groceries#new',
  );
  expect(returnTo).toHaveBeenCalledTimes(1);
});

it.each([
  ['the callback path', new URL(callback).pathname],
  ['another origin', '//elsewhere.example/items'],
  ['an OAuth parameter', '/items?state=forged'],
  ['a relative path', 'items/add'],
])(
  'rejects a sign-in whose current address is %s, before any request',
  async (_name, address) => {
    const f = fixture({ preferences: null, returnTo: () => address });
    runtimes.push(f.runtime);
    await f.runtime.initialize();
    const connection = await f.runtime.connect(pod);
    const requests = f.fetch.mock.calls.length;
    await expect(
      f.runtime.beginAuthorization(connection.id),
    ).rejects.toMatchObject({ problem: 'configuration' });
    expect(f.fetch.mock.calls.length).toBe(requests);
    expect(f.navigate).not.toHaveBeenCalled();
    expect(f.runtime.getSnapshot()[0]?.session.kind).toBe('signed-out');
  },
);

it('scrubs a callback without a matching attempt to / and never calls the function', async () => {
  const returnTo = vi.fn(() => '/items/add');
  const f = fixture({ preferences: null, returnTo });
  f.runtime.dispose();
  const stray = createBrowserRuntime({
    ...f.options,
    location: () => `${callback}?code=stray&state=unknown`,
  });
  runtimes.push(stray);
  expect(await stray.initialize()).toMatchObject({ interaction: 'failed' });
  expect(f.replaceUrl).toHaveBeenLastCalledWith('/');
  expect(returnTo).not.toHaveBeenCalled();
});

it('keeps a string returnTo checked at construction', () => {
  const f = fixture({ preferences: null });
  f.runtime.dispose();
  expect(() =>
    createBrowserRuntime({ ...f.options, returnTo: '/items?code=1' }),
  ).toThrow();
});
