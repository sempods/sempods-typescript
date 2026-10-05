import { afterEach, expect, it, vi } from 'vitest';
import {
  createResourceEditor,
  fields,
  text,
  type ResourceSource,
} from './index.js';
afterEach(() => vi.restoreAllMocks());
it('throwing subscribers cannot strand loaded, skip other listeners or hide an applied save', async () => {
  const reported: VoidFunction[] = [];
  vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((fn) =>
    reported.push(fn),
  );
  let body = { '@id': 'urn:item', 'urn:name': [{ '@value': 'Before' }] };
  let version = 1;
  let fail = false;
  const source: ResourceSource = {
    subjects: {
      get: async () => ({ kind: 'ok', body, etag: `"${version}"` }),
      patch: async (_id, patch) => {
        if (fail) return { kind: 'refused', status: 403 };
        body = { ...body, ...patch };
        version++;
        return { kind: 'applied', status: 204 };
      },
      put: async () => ({ kind: 'not-sent', reason: 'stopped' }),
      delete: async () => ({ kind: 'precondition-failed' }),
    },
  };
  const editor = createResourceEditor(
    source,
    'urn:item',
    fields({ title: text('urn:name', { language: null }) }),
  );
  editor.subscribe(() => {
    throw new Error('consumer bug');
  });
  const later = vi.fn();
  editor.subscribe(later);
  await expect(editor.loaded).resolves.toMatchObject({ phase: 'ready' });
  expect(later).toHaveBeenCalled();
  editor.change({ title: 'After' });
  await expect(editor.save()).resolves.toEqual({ kind: 'saved' });
  expect(editor.state).toMatchObject({ phase: 'ready', dirty: false });
  fail = true;
  editor.change({ title: 'Not saved' });
  await expect(editor.save()).resolves.toMatchObject({ kind: 'not-saved' });
  expect(editor.state.phase).not.toBe('saving');
  await expect(editor.remove()).resolves.toEqual({ kind: 'review' });
  expect(editor.state.phase).toBe('review');
  expect(reported.length).toBeGreaterThan(0);
  for (const report of reported) expect(report).toThrow('consumer bug');
  editor.dispose();
});
