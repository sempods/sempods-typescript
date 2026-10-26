// @vitest-environment jsdom
/** An app-owned Context switch (`useContexts`), as a list app's header has it. */
import { useState } from 'react';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import {
  AppAccess,
  SempodsProvider,
  TargetScreen,
  useContexts,
  useDraftGuard,
} from './index.js';
import type { BrowserRuntime } from '../runtime/types.js';
import {
  catalogue,
  fixture,
  personal,
  pod,
  returnedSession,
  work,
} from '../runtime/fixture.test.js';

const runtimes: BrowserRuntime[] = [];
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal(
    'ArrayBuffer',
    (await webcrypto.subtle.digest('SHA-256', new Uint8Array())).constructor,
  );
});
afterEach(() => {
  cleanup();
  runtimes.splice(0).forEach((r) => r.dispose());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const keep = (runtime: BrowserRuntime) => void runtimes.push(runtime);
const descriptions = (f: ReturnType<typeof fixture>) =>
  f.fetch.mock.calls.filter(([url]) =>
    /\/_system\/contexts\/[^/]+$/.test(new URL(url).pathname),
  ).length;
const labelled = (labels: Record<string, string>) => async (url: string) =>
  Response.json({
    '@id': url,
    '@type': ['http://www.w3.org/ns/sparql-service-description#NamedGraph'],
    'http://www.w3.org/ns/sparql-service-description#name': [{ '@id': url }],
    'https://schema.sempods.org/public': [{ '@value': false }],
    ...(labels[url]
      ? {
          'http://www.w3.org/2000/01/rdf-schema#label': [
            { '@value': labels[url] },
          ],
        }
      : {}),
  });

const outcomes: boolean[] = [];
/** The switch as an app renders it, plus a draft that asks before leaving. */
function Switch() {
  const lists = useContexts();
  const [dirty, setDirty] = useState(false);
  useDraftGuard(dirty, () => setDirty(false));
  return (
    <>
      <output aria-label="selected">{lists.selected?.name ?? ''}</output>
      <output aria-label="state">
        {lists.loading ? 'loading' : lists.failed ? 'failed' : 'known'}
      </output>
      <ul aria-label="Lists">
        {lists.contexts.map((c) => (
          <li key={c.iri}>
            <button
              onClick={() =>
                void lists.select(c.iri).then((ok) => outcomes.push(ok))
              }
            >
              {c.name}
            </button>
            {c.writable ? 'can change' : 'read only'}
          </li>
        ))}
      </ul>
      <button
        onClick={() =>
          void lists
            .select(pod + '/_system/contexts/missing')
            .then((ok) => outcomes.push(ok))
        }
      >
        Unknown
      </button>
      <button onClick={() => void lists.retry()}>Retry</button>
      <button onClick={() => setDirty(true)}>Edit</button>
    </>
  );
}
function App({
  runtime,
  mode,
  open = false,
}: {
  readonly runtime: BrowserRuntime;
  readonly mode?: 'required' | 'on-demand';
  readonly open?: boolean;
}) {
  return (
    <SempodsProvider
      runtime={runtime}
      {...(mode ? { contextSelection: mode } : {})}
    >
      <AppAccess appName="Lists" open={open} />
      <Switch />
      <TargetScreen>
        <p>Content</p>
      </TargetScreen>
    </SempodsProvider>
  );
}
const items = () =>
  within(screen.getByRole('list', { name: 'Lists' }))
    .queryAllByRole('listitem')
    .map((item) => item.textContent);
const selected = () => screen.getByLabelText('selected').textContent;

it.each(['required', 'on-demand'] as const)(
  'lists readable Contexts with labels and access and selects the first writable one (%s)',
  async (mode) => {
    outcomes.length = 0;
    const f = await returnedSession(keep);
    f.setCatalogue(async () => catalogue([personal, work], [work]));
    f.setDescriptions(labelled({ [work]: 'Work', [personal]: 'Home' }));
    render(<App runtime={f.runtime} mode={mode} />);
    await screen.findByText('Content');
    expect(selected()).toBe('Work');
    await waitFor(() =>
      expect(items()).toEqual(['Homeread only', 'Workcan change']),
    );
    // The app's switch selects: AppAccess offers no chooser of its own.
    expect(screen.queryByRole('combobox', { name: 'Data context' })).toBeNull();
    // One label read per Context, not one per render or reload.
    expect(descriptions(f)).toBe(2);
    await act(() => f.runtime.loadContexts(f.id));
    expect(descriptions(f)).toBe(2);
  },
);

it('tells equal labels apart by their short names', async () => {
  const f = await returnedSession(keep);
  f.setDescriptions(labelled({ [work]: 'Tasks', [personal]: 'Tasks' }));
  render(<App runtime={f.runtime} />);
  await waitFor(() =>
    expect(items()).toEqual([
      'Tasks · workcan change',
      'Tasks · personalread only',
    ]),
  );
});

it('keeps a preset Context and offers only that one', async () => {
  const f = await returnedSession(
    keep,
    fixture({
      preferences: null,
      preset: { podUrl: pod, contextIri: personal },
    }),
  );
  render(<App runtime={f.runtime} />);
  await screen.findByText('Content');
  expect(selected()).toBe('personal');
  expect(items()).toEqual(['personalread only']);
});

it('switches under the leave policy and refuses an unknown Context', async () => {
  outcomes.length = 0;
  const f = await returnedSession(keep);
  render(<App runtime={f.runtime} />);
  await screen.findByText('Content');
  expect(selected()).toBe('work');
  // A draft started in the selected list asks before another list replaces it.
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  fireEvent.click(screen.getByRole('button', { name: 'personal' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Keep editing' }));
  await waitFor(() => expect(outcomes).toEqual([false]));
  expect(selected()).toBe('work');
  fireEvent.click(screen.getByRole('button', { name: 'personal' }));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Discard and continue' }),
  );
  await waitFor(() => expect(selected()).toBe('personal'));
  fireEvent.click(screen.getByRole('button', { name: 'Unknown' }));
  await waitFor(() => expect(outcomes).toEqual([false, true, false]));
  expect(selected()).toBe('personal');
});

it('reports a failed catalogue and recovers with retry', async () => {
  const f = await returnedSession(keep);
  f.setCatalogue(async () => new Response(null, { status: 503 }));
  render(<App runtime={f.runtime} mode="on-demand" />);
  await waitFor(() =>
    expect(screen.getByLabelText('state').textContent).toBe('failed'),
  );
  expect(items()).toEqual([]);
  f.setCatalogue(async () => catalogue());
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByText('Content');
  expect(screen.getByLabelText('state').textContent).toBe('known');
  expect(selected()).toBe('work');
});

it('names only the selected Context in management when the app switches', async () => {
  const f = await returnedSession(keep);
  render(<App runtime={f.runtime} open />);
  const region = await screen.findByRole('region', { name: 'Pods & sharing' });
  await within(region).findByText('This app can read and change');
  expect(within(region).getByText('work', { exact: false })).toBeTruthy();
  expect(
    within(region).queryByRole('combobox', { name: 'Data context' }),
  ).toBeNull();
});
