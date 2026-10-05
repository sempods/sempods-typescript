// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NewVersionNotice } from '../../../../examples/todo/pwa/register.js';

// Minimal registration and worker doubles: event targets with the states the
// notice reads. Real browser behaviour is covered by the packed PWA flow.
class FakeWorker extends EventTarget {
  listeners = 0;
  override addEventListener(
    ...args: Parameters<EventTarget['addEventListener']>
  ) {
    this.listeners++;
    super.addEventListener(...args);
  }
  override removeEventListener(
    ...args: Parameters<EventTarget['removeEventListener']>
  ) {
    this.listeners--;
    super.removeEventListener(...args);
  }
}
class FakeRegistration extends EventTarget {
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
  /** The installing worker finishes and waits for all windows to close. */
  finish() {
    const worker = this.installing!;
    this.installing = null;
    this.waiting = worker;
    worker.dispatchEvent(new Event('statechange'));
  }
}
const text = /A new version is ready/;
function controlled(controller: object | null) {
  vi.stubGlobal('navigator', { ...navigator, serviceWorker: { controller } });
}
async function mount(registration: FakeRegistration) {
  const view = render(
    <NewVersionNotice
      registration={Promise.resolve(
        registration as unknown as ServiceWorkerRegistration,
      )}
    />,
  );
  await act(async () => {});
  return view;
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('announces an update that was already installing before the notice subscribed', async () => {
  controlled({});
  const registration = new FakeRegistration();
  // updatefound fired before mount: only `installing` shows the download.
  registration.installing = new FakeWorker();
  await mount(registration);
  expect(screen.queryByText(text)).toBeNull();
  act(() => registration.finish());
  expect(screen.getByText(text)).toBeTruthy();
});

it('announces an update found after mounting', async () => {
  controlled({});
  const registration = new FakeRegistration();
  await mount(registration);
  registration.installing = new FakeWorker();
  registration.dispatchEvent(new Event('updatefound'));
  act(() => registration.finish());
  expect(screen.getByText(text)).toBeTruthy();
});

it('stays silent for a first installation on an uncontrolled page', async () => {
  controlled(null);
  const registration = new FakeRegistration();
  registration.installing = new FakeWorker();
  await mount(registration);
  act(() => registration.finish());
  expect(screen.queryByText(text)).toBeNull();
});

it('announces a version that is already waiting and removes its listeners on unmount', async () => {
  controlled({});
  const registration = new FakeRegistration();
  const worker = new FakeWorker();
  registration.installing = worker;
  const view = await mount(registration);
  expect(worker.listeners).toBe(1);
  view.unmount();
  expect(worker.listeners).toBe(0);
  registration.installing = null;
  registration.waiting = worker;
  await mount(registration);
  expect(screen.getByText(text)).toBeTruthy();
});
