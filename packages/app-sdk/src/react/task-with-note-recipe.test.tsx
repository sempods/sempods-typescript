// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { TaskWithNoteExample } from '../../../../examples/todo/recipes/task-with-note.js';
import type { BrowserRuntime } from '../runtime/types.js';
import {
  catalogue,
  fixture,
  personal,
  resourceIri,
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

const about = 'https://schema.org/about';
type Put = { context: string; iri: string; body: Record<string, unknown> };
async function setup() {
  const f = fixture();
  f.setCatalogue(async () => catalogue([work, personal], [work, personal]));
  const session = await f.login();
  runtimes.push(session.runtime);
  const puts: Put[] = [];
  let refuse = '';
  f.setResource(async (url, init) => {
    if (init?.method !== 'PUT') return new Response(null, { status: 404 });
    const context = new URL(url).searchParams.get('context') ?? '';
    puts.push({
      context,
      iri: resourceIri(url),
      body: JSON.parse(init.body as string) as Record<string, unknown>,
    });
    return new Response(null, { status: context === refuse ? 403 : 201 });
  });
  render(
    <TaskWithNoteExample
      runtime={session.runtime}
      shared={work}
      personal={personal}
    />,
  );
  return {
    puts,
    refuse: (context: string) => {
      refuse = context;
    },
  };
}
const field = (name: string) =>
  screen.getByLabelText(name) as HTMLInputElement | HTMLTextAreaElement;
async function fill(title: string, text: string) {
  await waitFor(() => expect(field('Task').disabled).toBe(false));
  fireEvent.change(field('Task'), { target: { value: title } });
  fireEvent.change(field('Private note'), { target: { value: text } });
}
const linkOf = (put: Put) =>
  (put.body[about] as { '@id': string }[] | undefined)?.[0]?.['@id'];

it('creates the task in the shared and its linked note in the personal Context', async () => {
  const s = await setup();
  await fill('Buy milk', 'Oat, not cow');
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(s.puts).toHaveLength(2));
  expect(s.puts.map((put) => put.context)).toEqual([work, personal]);
  expect(linkOf(s.puts[1]!)).toBe(s.puts[0]!.iri);
  await waitFor(() => expect(field('Task').value).toBe(''));
  expect(field('Private note').value).toBe('');
});

it('keeps the task when the note is refused and retries only the note', async () => {
  const s = await setup();
  s.refuse(personal);
  await fill('Call mum', 'Ask about the weekend');
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(
    await screen.findByText('The task is saved; its private note is not yet.'),
  ).toBeTruthy();
  expect(s.puts.map((put) => put.context)).toEqual([work, personal]);
  expect(field('Private note').value).toBe('Ask about the weekend');
  s.refuse('');
  fireEvent.click(screen.getByRole('button', { name: 'Save the note again' }));
  await waitFor(() => expect(s.puts).toHaveLength(3));
  // Only the note again, still linked to the one task.
  expect(s.puts[2]!.context).toBe(personal);
  expect(linkOf(s.puts[2]!)).toBe(s.puts[0]!.iri);
  await waitFor(() => expect(field('Private note').value).toBe(''));
});
