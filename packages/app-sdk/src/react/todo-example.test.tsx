// @vitest-environment jsdom
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
import { TodoApp } from '../../../../examples/todo/src/app.js';
import type { PodFetch } from '@sempods/client-sdk';
import {
  catalogue,
  deferred,
  fixture,
  resourceIri,
  work,
} from '../runtime/fixture.test.js';

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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const text = {
  en: {
    language: /^(English|Englisch)$/,
    retry: 'Try again',
    failed: 'The pod reported an error. Try again later.',
    unavailable: 'This cannot be read right now.',
    empty: 'No tasks yet.',
    stale: 'What is shown may be out of date.',
    description: 'Tasks, stored in a Pod.',
  },
  de: {
    language: /^(German|Deutsch)$/,
    retry: 'Erneut versuchen',
    failed: 'Der Pod hat einen Fehler gemeldet. Versuche es später erneut.',
    unavailable: 'Das kann gerade nicht gelesen werden.',
    empty: 'Noch keine Aufgaben.',
    stale: 'Die Anzeige ist vielleicht nicht aktuell.',
    description: 'Aufgaben, gespeichert in einem Pod.',
  },
} as const;
/** No list state message of the example may promise a draft that might not exist. */
const promisesDraft = (language: 'en' | 'de') =>
  /draft is kept|Entwurf bleibt/.test(
    screen.getByRole('region', {
      name: language === 'en' ? 'Tasks' : 'Aufgaben',
    }).textContent ?? '',
  );

/**
 * Picks a language from the header menu. jsdom does not open popovers, so the
 * closed menu's item is found although hidden.
 */
function pick(language: 'en' | 'de') {
  fireEvent.click(
    screen.getByRole('button', { name: text[language].language, hidden: true }),
  );
}

async function signedIn(language: 'en' | 'de', query: PodFetch) {
  const f = fixture();
  const session = await f.login();
  cleanups.push(() => session.runtime.dispose());
  f.setQuery(query);
  render(<TodoApp runtime={session.runtime} />);
  pick(language);
  return { ...f, ...session };
}

it.each(['en', 'de'] as const)(
  'the TODO list names a failed read and retries it (%s)',
  async (language) => {
    const t = text[language];
    const f = await signedIn(
      language,
      async () => new Response(null, { status: 500 }),
    );
    const reload = await screen.findByRole('button', { name: t.retry });
    expect((await screen.findByRole('alert')).textContent).toBe(t.failed);
    expect(promisesDraft(language)).toBe(false);
    f.setQuery(async () => Response.json([]));
    await act(async () => reload.click());
    expect(await screen.findByText(t.empty)).toBeTruthy();
    expect(screen.queryByText(t.failed)).toBeNull();
  },
);

it.each(['en', 'de'] as const)(
  'the TODO list names lost read access without promising a draft (%s)',
  async (language) => {
    const t = text[language];
    const f = await signedIn(language, async () => Response.json([]));
    expect(await screen.findByText(t.empty)).toBeTruthy();
    f.setCatalogue(async () => catalogue([], []));
    await act(() => f.runtime.loadContexts(f.id));
    expect(await screen.findByText(t.unavailable)).toBeTruthy();
    expect(promisesDraft(language)).toBe(false);
    f.setCatalogue(async () => catalogue([work]));
    await act(() => f.runtime.loadContexts(f.id));
    expect(await screen.findByText(t.empty)).toBeTruthy();
  },
);

const schema = 'https://schema.org/';
const milk = {
  '@id': 'urn:task:milk',
  '@type': [schema + 'Action'],
  [schema + 'name']: [{ '@value': 'Buy milk' }],
  [schema + 'actionStatus']: [{ '@id': schema + 'PotentialActionStatus' }],
};

it.each(['en', 'de'] as const)(
  'the TODO list reloads when the page is visible again, keeping its rows (%s)',
  async (language) => {
    const t = text[language];
    const f = await signedIn(language, async () => Response.json([milk]));
    expect(await screen.findByText('Buy milk')).toBeTruthy();
    const held = deferred<Response>();
    f.setQuery(() => held.promise);
    // Back on the page: the list reads again without a reload button.
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    // No empty frame: the row stays and no loading status replaces it.
    expect(screen.getByText('Buy milk')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
    await act(async () => held.resolve(new Response(null, { status: 500 })));
    expect((await screen.findByRole('alert')).textContent).toBe(
      `${t.failed} ${t.stale}`,
    );
    expect(screen.getByText('Buy milk')).toBeTruthy();
    expect(promisesDraft(language)).toBe(false);
  },
);

it('the TODO row becomes its editor: Escape cancels, Enter saves, delete closes', async () => {
  const rows = new Map<string, Record<string, unknown>>([[milk['@id'], milk]]);
  const f = await signedIn('en', async () => Response.json([...rows.values()]));
  const writes: string[] = [];
  f.setResource(async (url, init) => {
    const iri = resourceIri(url);
    const method = init?.method ?? 'GET';
    if (method === 'GET')
      return rows.has(iri)
        ? Response.json(rows.get(iri), { headers: { etag: '"v1"' } })
        : new Response(null, { status: 404 });
    writes.push(method);
    if (method === 'DELETE') rows.delete(iri);
    else
      rows.set(iri, {
        ...rows.get(iri),
        ...(JSON.parse(init!.body as string) as Record<string, unknown>),
      });
    return new Response(null, { status: 204 });
  });
  const edit = async (title: string) => {
    fireEvent.click(await screen.findByRole('button', { name: title }));
    return (await screen.findByLabelText('Task')) as HTMLInputElement;
  };
  // Keys of an active IME composition belong to it: the draft stays.
  let field = await edit('Buy milk');
  fireEvent.change(field, { target: { value: 'Oat milk' } });
  fireEvent.keyDown(field, { key: 'Escape', isComposing: true });
  fireEvent.keyDown(field, { key: 'Enter', isComposing: true });
  expect((screen.getByLabelText('Task') as HTMLInputElement).value).toBe(
    'Oat milk',
  );
  expect(writes).toEqual([]);
  // Escape discards the change and shows the row again; nothing is written.
  fireEvent.keyDown(field, { key: 'Escape' });
  expect(await screen.findByRole('button', { name: 'Buy milk' })).toBeTruthy();
  expect(screen.queryByLabelText('Task')).toBeNull();
  // Enter saves; the confirmed save closes the editor and the row shows it.
  field = await edit('Buy milk');
  fireEvent.change(field, { target: { value: 'Oat milk' } });
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.keyDown(field, { key: 'Enter' });
  expect(await screen.findByRole('button', { name: 'Oat milk' })).toBeTruthy();
  expect(screen.queryByLabelText('Task')).toBeNull();
  expect(writes).toEqual(['PATCH']);
  // A confirmed delete closes it too.
  await edit('Oat milk');
  const remove = screen.getByRole('button', { name: 'Delete' });
  await waitFor(() =>
    expect((remove as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(remove);
  const confirm = screen.getByRole('alertdialog', {
    name: 'Delete this from the pod? This cannot be undone.',
  });
  fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
  expect(await screen.findByText(text.en.empty)).toBeTruthy();
  expect(screen.queryByLabelText('Task')).toBeNull();
});

it.each(['en', 'de'] as const)(
  'the TODO sign-in describes the app (%s)',
  async (language) => {
    const f = fixture();
    cleanups.push(() => f.runtime.dispose());
    render(<TodoApp runtime={f.runtime} />);
    pick(language);
    expect(await screen.findByText(text[language].description)).toBeTruthy();
  },
);

it.each([
  [['de-DE', 'en'], 'de', 'en'],
  [['en-GB'], 'en', 'de'],
  [['fr-CA'], 'en', 'de'],
] as const)(
  'the TODO example follows the browser languages %j until a language is picked',
  async (languages, initial, picked) => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue([...languages]);
    const f = fixture();
    cleanups.push(() => f.runtime.dispose());
    render(<TodoApp runtime={f.runtime} />);
    expect(await screen.findByText(text[initial].description)).toBeTruthy();
    pick(picked);
    expect(await screen.findByText(text[picked].description)).toBeTruthy();
    expect(screen.queryByText(text[initial].description)).toBeNull();
  },
);
