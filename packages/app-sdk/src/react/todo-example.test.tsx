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
  // In place, the editor is the SDK's quiet card.
  expect(
    field.closest('[data-sempods-ui="editor"]')?.hasAttribute('data-inline'),
  ).toBe(true);
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

it('the TODO header switches lists and marks a read-only one', async () => {
  await signedIn('en', async () => Response.json([]));
  expect(await screen.findByText(text.en.empty)).toBeTruthy();
  const heading = screen.getByRole('heading', { level: 1 });
  expect(heading.textContent).toBe('work');
  const menu = document.getElementById('list-menu')!;
  const personalList = within(menu).getByRole('button', {
    name: /^personal/,
    hidden: true,
  });
  expect(personalList.textContent).toContain('read only');
  expect(
    within(menu)
      .getByRole('button', { name: /^work/, hidden: true })
      .getAttribute('aria-pressed'),
  ).toBe('true');
  fireEvent.click(personalList);
  await waitFor(() =>
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'personal',
    ),
  );
  expect(
    await screen.findByText('You can read this context, but cannot change it.'),
  ).toBeTruthy();
});

it('the TODO header names a single list without a switch', async () => {
  const f = fixture();
  f.setCatalogue(async () => catalogue([work], [work]));
  const session = await f.login();
  cleanups.push(() => session.runtime.dispose());
  f.setQuery(async () => Response.json([]));
  render(<TodoApp runtime={session.runtime} />);
  expect(await screen.findByText(text.en.empty)).toBeTruthy();
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('work');
  expect(document.getElementById('list-menu')).toBeNull();
});

it('the TODO header says when sharing more lists cannot reach the Pod', async () => {
  const f = await signedIn('en', async () => Response.json([]));
  expect(await screen.findByText(text.en.empty)).toBeTruthy();
  const share = within(document.getElementById('list-menu')!).getByRole(
    'button',
    { name: 'Share more lists', hidden: true },
  );
  // Preparing the consent fails before the page leaves: the session stays.
  const navigations = f.navigate.mock.calls.length;
  f.fetch.mockRejectedValueOnce(new TypeError('offline'));
  fireEvent.click(share);
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(f.navigate).toHaveBeenCalledTimes(navigations);
  expect(screen.getByText(text.en.empty)).toBeTruthy();
});

it('the TODO list locks only the row whose tick is being saved', async () => {
  const bread = {
    ...milk,
    '@id': 'urn:task:bread',
    [schema + 'name']: [{ '@value': 'Buy bread' }],
  };
  const rows = new Map<string, Record<string, unknown>>([
    [milk['@id'], milk],
    [bread['@id'], bread],
  ]);
  const f = await signedIn('en', async () => Response.json([...rows.values()]));
  const held = deferred<Response>();
  f.setResource(async (url, init) => {
    const iri = resourceIri(url);
    if ((init?.method ?? 'GET') === 'GET')
      return Response.json(rows.get(iri), { headers: { etag: '"v1"' } });
    return held.promise;
  });
  const box = (name: string) =>
    screen.getByRole('checkbox', { name: `Done: ${name}` }) as HTMLInputElement;
  await screen.findByRole('checkbox', { name: 'Done: Buy milk' });
  await waitFor(() => expect(box('Buy milk').disabled).toBe(false));
  fireEvent.click(box('Buy milk'));
  await waitFor(() => expect(box('Buy milk').disabled).toBe(true));
  // Another task is a separate resource: it stays usable meanwhile.
  expect(box('Buy bread').disabled).toBe(false);
  await act(async () => held.resolve(new Response(null, { status: 204 })));
  await waitFor(() => expect(box('Buy milk').disabled).toBe(false));
});

it('the TODO list keeps the recovery of an unconfirmed tick whose task was deleted', async () => {
  const rows = new Map<string, Record<string, unknown>>([[milk['@id'], milk]]);
  const f = await signedIn('en', async () => Response.json([...rows.values()]));
  f.setResource(async (url, init) => {
    const iri = resourceIri(url);
    if ((init?.method ?? 'GET') === 'GET')
      return rows.has(iri)
        ? Response.json(rows.get(iri), { headers: { etag: '"v1"' } })
        : new Response(null, { status: 404 });
    return new Response(null, { status: 202 });
  });
  const box = await screen.findByRole('checkbox', { name: 'Done: Buy milk' });
  await waitFor(() => expect((box as HTMLInputElement).disabled).toBe(false));
  fireEvent.click(box);
  expect(await screen.findByText(/The result is unconfirmed/)).toBeTruthy();
  // Deleted elsewhere: the check finds it absent, and the row leaves the list.
  rows.delete(milk['@id']);
  fireEvent.click(
    screen.getByRole('button', { name: 'Check current version' }),
  );
  expect(await screen.findByText(text.en.empty)).toBeTruthy();
  // The recovery stays reachable without the row.
  fireEvent.click(
    await screen.findByRole('button', { name: 'I have checked the pod' }),
  );
  await waitFor(() =>
    expect(screen.queryByText(/The result is unconfirmed/)).toBeNull(),
  );
});

it('the TODO list deletes a done task from its row after asking', async () => {
  const done = {
    ...milk,
    [schema + 'actionStatus']: [{ '@id': schema + 'CompletedActionStatus' }],
  };
  const bread = {
    ...milk,
    '@id': 'urn:task:bread',
    [schema + 'name']: [{ '@value': 'Buy bread' }],
  };
  const rows = new Map<string, Record<string, unknown>>([
    [done['@id'], done],
    [bread['@id'], bread],
  ]);
  const f = await signedIn('en', async () => Response.json([...rows.values()]));
  const writes: string[] = [];
  f.setResource(async (url, init) => {
    const iri = resourceIri(url);
    const method = init?.method ?? 'GET';
    if (method === 'GET')
      return Response.json(rows.get(iri), { headers: { etag: '"v1"' } });
    writes.push(`${method} ${iri}`);
    rows.delete(iri);
    return new Response(null, { status: 204 });
  });
  const remove = (await screen.findByRole('button', {
    name: 'Delete: Buy milk',
  })) as HTMLButtonElement;
  // Only a done task offers it in its row.
  expect(
    screen.queryByRole('button', { name: 'Delete: Buy bread' }),
  ).toBeNull();
  await waitFor(() => expect(remove.disabled).toBe(false));
  // Cancel sends nothing.
  fireEvent.click(remove);
  const question = 'Delete this from the pod? This cannot be undone.';
  fireEvent.click(
    within(screen.getByRole('alertdialog', { name: question })).getByRole(
      'button',
      { name: 'Cancel' },
    ),
  );
  expect(writes).toEqual([]);
  // The dialog's Delete sends one DELETE; the row leaves, the other stays.
  fireEvent.click(remove);
  fireEvent.click(
    within(screen.getByRole('alertdialog', { name: question })).getByRole(
      'button',
      { name: 'Delete' },
    ),
  );
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Buy milk' })).toBeNull(),
  );
  expect(writes).toEqual(['DELETE urn:task:milk']);
  expect(screen.getByRole('button', { name: 'Buy bread' })).toBeTruthy();
});

it('the TODO row waits for a fresh read after a confirmed tick, so a second tick is no conflict', async () => {
  const rows = new Map<string, Record<string, unknown>>([[milk['@id'], milk]]);
  let held: ReturnType<typeof deferred<Response>> | null = null;
  let version = 1;
  const f = await signedIn('en', async () =>
    held ? held.promise : Response.json([...rows.values()]),
  );
  const patches: string[] = [];
  f.setResource(async (url, init) => {
    const iri = resourceIri(url);
    if ((init?.method ?? 'GET') === 'GET')
      return Response.json(rows.get(iri), {
        headers: { etag: `"v${version}"` },
      });
    patches.push(init!.body as string);
    rows.set(iri, {
      ...rows.get(iri),
      ...(JSON.parse(init!.body as string) as Record<string, unknown>),
    });
    version++;
    held = deferred<Response>();
    return new Response(null, { status: 204 });
  });
  const box = () =>
    screen.getByRole('checkbox', {
      name: 'Done: Buy milk',
    }) as HTMLInputElement;
  await screen.findByRole('checkbox', { name: 'Done: Buy milk' });
  await waitFor(() => expect(box().disabled).toBe(false));
  fireEvent.click(box());
  await waitFor(() => expect(patches).toHaveLength(1));
  // Saved, but the list has not read again: the shown row is spent.
  await act(async () => {});
  expect(box().disabled).toBe(true);
  fireEvent.click(box());
  expect(patches).toHaveLength(1);
  // The fresh read shows the change and frees the row; the next tick saves.
  const read = held!;
  held = null;
  await act(async () => read.resolve(Response.json([...rows.values()])));
  await waitFor(() => expect(box().checked).toBe(true));
  await waitFor(() => expect(box().disabled).toBe(false));
  fireEvent.click(box());
  await waitFor(() => expect(patches).toHaveLength(2));
  const again = held!;
  held = null;
  await act(async () => again.resolve(Response.json([...rows.values()])));
  await waitFor(() => expect(box().checked).toBe(false));
  expect(screen.queryByText(/The pod has changed/)).toBeNull();
});
