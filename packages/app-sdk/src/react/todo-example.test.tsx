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
    language: 'English',
    reload: 'Reload',
    retry: 'Try again',
    failed: 'The pod reported an error. Try again later.',
    unavailable: 'This cannot be read right now.',
    empty: 'No tasks yet.',
    stale: 'What is shown may be out of date.',
    description: 'Tasks, stored in a Pod.',
  },
  de: {
    language: 'Deutsch',
    reload: 'Neu laden',
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

async function signedIn(language: 'en' | 'de', query: PodFetch) {
  const f = fixture();
  const session = await f.login();
  cleanups.push(() => session.runtime.dispose());
  f.setQuery(query);
  render(<TodoApp runtime={session.runtime} />);
  fireEvent.click(
    screen.getByRole('button', { name: text[language].language }),
  );
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
  'the TODO list keeps its rows while reloading and after a failed refresh (%s)',
  async (language) => {
    const t = text[language];
    const f = await signedIn(language, async () => Response.json([milk]));
    expect(await screen.findByText('Buy milk')).toBeTruthy();
    const held = deferred<Response>();
    f.setQuery(() => held.promise);
    await act(async () =>
      screen.getByRole('button', { name: t.reload }).click(),
    );
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

it('the TODO editor closes with its button and after a confirmed delete', async () => {
  const rows = new Map([[milk['@id'], milk]]);
  const f = await signedIn('en', async () => Response.json([...rows.values()]));
  f.setResource(async (url, init) => {
    const iri = resourceIri(url);
    if (init?.method === 'DELETE') {
      rows.delete(iri);
      return new Response(null, { status: 204 });
    }
    return rows.has(iri)
      ? Response.json(rows.get(iri), { headers: { etag: '"v1"' } })
      : new Response(null, { status: 404 });
  });
  const open = async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Buy milk' }));
    return screen.findByRole('button', { name: 'Close' });
  };
  fireEvent.click(await open());
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull(),
  );
  await open();
  const remove = screen.getByRole('button', { name: 'Delete' });
  await waitFor(() =>
    expect((remove as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(remove);
  const confirm = screen.getByRole('group', {
    name: 'Delete this from the pod? This cannot be undone.',
  });
  fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull(),
  );
  expect(await screen.findByText(text.en.empty)).toBeTruthy();
});

it.each(['en', 'de'] as const)(
  'the TODO sign-in describes the app (%s)',
  async (language) => {
    const f = fixture();
    cleanups.push(() => f.runtime.dispose());
    render(<TodoApp runtime={f.runtime} />);
    fireEvent.click(
      screen.getByRole('button', { name: text[language].language }),
    );
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
    fireEvent.click(
      screen.getByRole('button', { name: text[picked].language }),
    );
    expect(await screen.findByText(text[picked].description)).toBeTruthy();
    expect(screen.queryByText(text[initial].description)).toBeNull();
  },
);
