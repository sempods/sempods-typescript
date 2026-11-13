// @vitest-environment jsdom
/**
 * The startup screen (#304): staged starts with the real runtime, every DOM
 * change recorded, in the shapes of Explorer (on demand, no TargetScreen),
 * Focus (on demand with a TargetScreen) and Konsum (required, several Pods).
 */
import {
  createContext,
  StrictMode,
  useContext,
  type CSSProperties,
} from 'react';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import {
  AppAccess,
  AppStartup,
  ContextAccess,
  SdkLocaleProvider,
  SempodsProvider,
  TargetScreen,
  useAppState,
} from './index.js';
import {
  catalogue,
  deferred,
  fixture,
  memoryStorage,
  settleLease,
  twoPods,
  without,
} from '../runtime/fixture.test.js';
import { createBrowserRuntime } from '../runtime/runtime.js';
import type {
  BrowserRuntime,
  BrowserRuntimeOptions,
} from '../runtime/types.js';
import type { PodFetch } from '@sempods/client-sdk';

const cleanups: (() => void)[] = [];
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal(
    'ArrayBuffer',
    (await webcrypto.subtle.digest('SHA-256', new Uint8Array())).constructor,
  );
});
afterEach(() => {
  cleanup();
  cleanups.splice(0).forEach((fn) => fn());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const keep = (r: BrowserRuntime) => cleanups.push(() => r.dispose());

/** What the page shows, recorded at every DOM change. */
interface Frame {
  readonly startup: boolean;
  readonly status: string;
  readonly access: boolean;
  readonly gate: boolean;
  readonly controls: number;
  readonly inert: boolean;
}
function record() {
  const frames: Frame[] = [];
  const take = () => {
    const layer = document.querySelector('[data-sempods-startup]');
    const section = document.querySelector('[data-sempods-access]');
    const frame: Frame = {
      startup: layer !== null,
      status: layer?.querySelector('[role="status"]')?.textContent ?? '',
      access: section !== null && !section.hasAttribute('hidden'),
      gate: document.querySelector('[data-sempods-ui="gate"]') !== null,
      controls:
        layer?.querySelectorAll('button, a, input, select, textarea').length ??
        0,
      inert: document.querySelector('[data-app-content]')?.closest('[inert]')
        ? true
        : false,
    };
    const last = frames.at(-1);
    if (!last || JSON.stringify(last) !== JSON.stringify(frame))
      frames.push(frame);
  };
  const observer = new MutationObserver(take);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  cleanups.push(() => observer.disconnect());
  return frames;
}

/** A saved session, reloaded with its discovery and catalogue held. */
async function staged(overrides: Partial<BrowserRuntimeOptions> = {}) {
  const f = fixture({ preferences: memoryStorage(), ...overrides });
  const signed = await f.login();
  signed.runtime.dispose();
  await settleLease();
  const discovery = deferred<void>();
  const contexts = deferred<void>();
  f.setCatalogue(async () => {
    await contexts.promise;
    return catalogue();
  });
  const fetch: PodFetch = async (url, init) => {
    if (url.endsWith('/.well-known/oauth-protected-resource'))
      await discovery.promise;
    return f.fetch(url, init);
  };
  const runtime = createBrowserRuntime({ ...f.options, fetch });
  keep(runtime);
  return { f, runtime, discovery, contexts };
}
function Content() {
  const { startup } = useAppState();
  return (
    <main data-app-content="">
      <h2>My header</h2>
      <output>{startup ? 'started' : ''}</output>
    </main>
  );
}

it.each(['on-demand', 'required'] as const)(
  'covers records, restoring and the first catalogue with one calm screen (%s, TargetScreen)',
  async (mode) => {
    const s = await staged();
    const frames = record();
    render(
      <StrictMode>
        <SempodsProvider runtime={s.runtime} contextSelection={mode}>
          <AppAccess appName="Shopping" icon={<img src="/icon.png" alt="" />} />
          <Content />
          <TargetScreen>
            <p>Context screen</p>
          </TargetScreen>
        </SempodsProvider>
      </StrictMode>,
    );
    // The first frame already shows the startup screen, without a status.
    expect(
      document.querySelector('[data-sempods-startup] h1')?.textContent,
    ).toBe('Shopping');
    expect(
      document.querySelector('[data-sempods-startup] [role="status"]')
        ?.textContent,
    ).toBe('');
    await screen.findByText('started');
    expect(s.runtime.getSnapshot()[0]?.session.kind).toBe('restoring');
    // After the delay, progress and a polite status.
    await waitFor(() =>
      expect(
        document.querySelector('[data-sempods-startup] [role="status"]')
          ?.textContent,
      ).toBe('Starting…'),
    );
    await act(async () => s.discovery.resolve());
    await waitFor(() =>
      expect(s.runtime.getSnapshot()[0]?.catalogue.kind).toBe('loading'),
    );
    expect(document.querySelector('[data-sempods-startup]')).not.toBeNull();
    await act(async () => s.contexts.resolve());
    await screen.findByText('Context screen');
    await waitFor(() =>
      expect(document.querySelector('[data-sempods-startup]')).toBeNull(),
    );
    // Never an access card, a chooser, a gate or a control while starting,
    // and the content stayed inert behind the screen.
    const starting = frames.filter((f) => f.startup);
    expect(starting.length).toBeGreaterThan(0);
    for (const frame of starting)
      expect(frame).toMatchObject({
        access: false,
        gate: false,
        controls: 0,
        inert: true,
      });
    expect(frames.at(-1)).toMatchObject({
      startup: false,
      access: false,
      inert: false,
    });
  },
);

it('ends at the readable Pod on demand without a TargetScreen (Explorer)', async () => {
  const s = await staged();
  render(
    <SempodsProvider runtime={s.runtime} contextSelection="on-demand">
      <AppAccess appName="Explorer" />
      <Content />
    </SempodsProvider>,
  );
  await screen.findByText('started');
  expect(document.querySelector('[data-sempods-startup]')).not.toBeNull();
  await act(async () => s.discovery.resolve());
  await waitFor(() =>
    expect(document.querySelector('[data-sempods-startup]')).toBeNull(),
  );
  // No catalogue was read for it.
  expect(s.runtime.getSnapshot()[0]?.catalogue.kind).toBe('unknown');
});

it('announces nothing for a fast start', async () => {
  const s = await staged();
  s.discovery.resolve();
  s.contexts.resolve();
  const frames = record();
  render(
    <SempodsProvider runtime={s.runtime}>
      <AppAccess appName="Shopping" />
      <Content />
      <TargetScreen>
        <p>Context screen</p>
      </TargetScreen>
    </SempodsProvider>,
  );
  await screen.findByText('Context screen');
  await waitFor(() =>
    expect(document.querySelector('[data-sempods-startup]')).toBeNull(),
  );
  expect(frames.every((f) => f.status === '')).toBe(true);
});

it('gives way to the gate and shows no sign-in controls before it', async () => {
  const f = fixture({ preferences: null });
  keep(f.runtime);
  const frames = record();
  render(
    <SempodsProvider runtime={f.runtime}>
      <AppAccess appName="Shopping" />
      <Content />
    </SempodsProvider>,
  );
  await waitFor(() =>
    expect(document.querySelector('[data-sempods-ui="gate"]')).not.toBeNull(),
  );
  expect(document.querySelector('[data-sempods-startup]')).toBeNull();
  expect(frames.some((f) => f.startup && f.gate)).toBe(false);
});

it('leaves the startup to the app with startup="none"; the Context surface still waits', async () => {
  const s = await staged();
  const frames = record();
  render(
    <SempodsProvider runtime={s.runtime}>
      <AppAccess appName="Shopping" startup="none" />
      <Content />
      <TargetScreen>
        <p>Context screen</p>
      </TargetScreen>
    </SempodsProvider>,
  );
  await screen.findByText('started');
  await act(async () => s.discovery.resolve());
  await waitFor(() =>
    expect(s.runtime.getSnapshot()[0]?.catalogue.kind).toBe('loading'),
  );
  await act(async () => s.contexts.resolve());
  await screen.findByText('Context screen');
  expect(frames.some((f) => f.startup || f.access || f.inert)).toBe(false);
});

it('shows one startup screen from parts composed by the app', async () => {
  const s = await staged();
  render(
    <SempodsProvider runtime={s.runtime}>
      <AppStartup appName="Shopping" />
      <AppStartup appName="Other" />
      <ContextAccess appName="Shopping" />
      <Content />
    </SempodsProvider>,
  );
  await screen.findByText('started');
  expect(document.querySelectorAll('[data-sempods-startup]')).toHaveLength(1);
  expect(document.querySelector('[data-sempods-startup] h1')?.textContent).toBe(
    'Shopping',
  );
  expect(
    document.querySelector('[data-app-content]')?.closest('[inert]'),
  ).not.toBeNull();
});

it('keeps prompts about other Pods until startup ends, and never shows the Pod chooser (Konsum)', async () => {
  // Alice and Bob signed in; Bob's catalogue is held on the reload.
  const pods = await twoPods(keep, {
    ...without('preset'),
    preferences: memoryStorage(),
  });
  const bob = pods.other.id;
  pods.runtime.dispose();
  await settleLease();
  const contexts = deferred<void>();
  const fetch: PodFetch = async (url, init) => {
    // Alice's Pod refuses her saved session: an ended Pod beside Bob.
    if (url.startsWith('https://pod.example/alice/.well-known/oauth-protected'))
      return new Response(null, { status: 404 });
    if (url.endsWith('/_system/contexts')) await contexts.promise;
    return pods.f.fetch(url, init);
  };
  const runtime = createBrowserRuntime({
    ...pods.f.options,
    ...without('preset'),
    preferences: memoryStorage(),
    location: () => 'https://app.example/',
    fetch,
  });
  keep(runtime);
  const frames = record();
  render(
    <SempodsProvider runtime={runtime}>
      <AppAccess appName="Konsum" />
      <Content />
      <TargetScreen>
        <p>Context screen</p>
      </TargetScreen>
    </SempodsProvider>,
  );
  await waitFor(() =>
    expect(
      runtime.getSnapshot().find((c) => c.id === bob)?.catalogue.kind,
    ).toBe('loading'),
  );
  expect(document.querySelector('[data-sempods-startup]')).not.toBeNull();
  expect(document.querySelector('[data-sempods-ui="prompts"] li')).toBeNull();
  await act(async () => contexts.resolve());
  await waitFor(() =>
    expect(document.querySelector('[data-sempods-startup]')).toBeNull(),
  );
  await waitFor(() =>
    expect(
      document.querySelector('[data-sempods-ui="prompts"] li'),
    ).not.toBeNull(),
  );
  expect(frames.some((f) => f.startup && f.access)).toBe(false);
  expect(frames.some((f) => f.gate)).toBe(false);
});

it('speaks the language of a nested locale provider around AppAccess', async () => {
  const s = await staged();
  render(
    <SempodsProvider runtime={s.runtime} language="en">
      <SdkLocaleProvider language="de" direction="rtl">
        <AppAccess appName="Einkauf" />
      </SdkLocaleProvider>
      <Content />
    </SempodsProvider>,
  );
  await screen.findByText('started');
  const layer = document.querySelector('[data-sempods-startup]')!;
  expect(layer.getAttribute('dir')).toBe('rtl');
  await waitFor(() =>
    expect(layer.querySelector('[role="status"]')?.textContent).toBe(
      'Wird gestartet…',
    ),
  );
});

const Brand = createContext<string | null>(null);
function BrandIcon() {
  // An icon whose hook requires the app's provider, as in the access gate.
  const brand = useContext(Brand);
  if (!brand) throw new Error('BrandIcon needs its provider.');
  return <span data-testid="brand-icon">{brand}</span>;
}

it('keeps the React context around AppAccess for its icon', async () => {
  const s = await staged();
  render(
    <SempodsProvider runtime={s.runtime}>
      <Brand.Provider value="blue">
        <AppAccess appName="Shopping" icon={<BrandIcon />} />
      </Brand.Provider>
      <Content />
    </SempodsProvider>,
  );
  await screen.findByText('started');
  const layer = document.querySelector('[data-sempods-startup]')!;
  expect(layer.querySelector('[data-testid="brand-icon"]')?.textContent).toBe(
    'blue',
  );
  // The layer is outside the inert content; the content is inert.
  expect(layer.closest('[inert]')).toBeNull();
  expect(
    document.querySelector('[data-app-content]')?.closest('[inert]'),
  ).not.toBeNull();
});

it('carries the theme set on an ancestor of AppAccess into the startup screen', async () => {
  const s = await staged();
  render(
    <SempodsProvider runtime={s.runtime}>
      <div
        style={
          {
            '--sempods-bg': 'rgb(1, 2, 3)',
            '--sempods-text': 'rgb(250, 250, 250)',
            colorScheme: 'dark',
          } as CSSProperties
        }
      >
        <AppAccess
          appName="Shopping"
          style={{ '--sempods-text': 'rgb(9, 9, 9)' } as CSSProperties}
        />
      </div>
      <Content />
    </SempodsProvider>,
  );
  await screen.findByText('started');
  const layer = document.querySelector<HTMLElement>('[data-sempods-startup]')!;
  expect(layer.style.getPropertyValue('--sempods-bg')).toBe('rgb(1, 2, 3)');
  expect(layer.style.colorScheme).toBe('dark');
  // The component's own style wins over the inherited theme.
  expect(layer.style.getPropertyValue('--sempods-text')).toBe('rgb(9, 9, 9)');
});
