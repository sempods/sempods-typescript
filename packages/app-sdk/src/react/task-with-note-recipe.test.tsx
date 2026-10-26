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
  // Lands the next task, but its answer is lost (202: not a confirmation).
  let loseTask = false;
  const stored = new Map<string, Record<string, unknown>>();
  f.setResource(async (url, init) => {
    const iri = resourceIri(url);
    if (init?.method !== 'PUT')
      return stored.has(iri)
        ? Response.json(stored.get(iri), { headers: { etag: '"v1"' } })
        : new Response(null, { status: 404 });
    const context = new URL(url).searchParams.get('context') ?? '';
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    puts.push({ context, iri, body });
    if (context === refuse) return new Response(null, { status: 403 });
    stored.set(iri, { ...body, '@id': iri });
    if (loseTask && context === work) {
      loseTask = false;
      return new Response(null, { status: 202 });
    }
    return new Response(null, { status: 201 });
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
    loseTask: () => {
      loseTask = true;
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

it('sends nothing until the note has text', async () => {
  const s = await setup();
  await waitFor(() => expect(field('Task').disabled).toBe(false));
  fireEvent.change(field('Task'), { target: { value: 'Only a title' } });
  const save = screen.getByRole('button', {
    name: 'Save',
  }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.change(field('Private note'), { target: { value: '   ' } });
  expect(save.disabled).toBe(true);
  expect(s.puts).toEqual([]);
});

it('links the note to an unconfirmed task once it is checked, without a second task', async () => {
  const s = await setup();
  s.loseTask();
  await fill('Pay rent', 'Before the 3rd');
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText(/The result is unconfirmed/)).toBeTruthy();
  expect(s.puts.map((put) => put.context)).toEqual([work]);
  // The note waits for the task's check; the person checks and acknowledges.
  expect(
    (
      screen.getByRole('button', {
        name: 'Save the note again',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.click(
    screen.getByRole('button', { name: 'Check current version' }),
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'I have checked the pod' }),
  );
  await screen.findByText('The task is saved; its private note is not yet.');
  fireEvent.click(screen.getByRole('button', { name: 'Save the note again' }));
  await waitFor(() => expect(s.puts).toHaveLength(2));
  expect(s.puts.map((put) => put.context)).toEqual([work, personal]);
  expect(linkOf(s.puts[1]!)).toBe(s.puts[0]!.iri);
});

it('sends a refused task again before its note, and never links the refused one', async () => {
  const s = await setup();
  s.refuse(work);
  await fill('Water plants', 'The big one too');
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(s.puts).toHaveLength(1));
  expect(
    await screen.findByText(
      'The change was not saved. Check access and try again.',
    ),
  ).toBeTruthy();
  // Not linked: the task stays editable and nothing claims it is saved.
  expect(field('Task').disabled).toBe(false);
  expect(
    screen.queryByText('The task is saved; its private note is not yet.'),
  ).toBeNull();
  s.refuse('');
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(s.puts).toHaveLength(3));
  expect(s.puts.map((put) => put.context)).toEqual([work, work, personal]);
  expect(linkOf(s.puts[2]!)).toBe(s.puts[1]!.iri);
});
