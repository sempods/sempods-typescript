// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MarkdownField } from './markdown-field.js';

// Tiptap creates the editor after the first render, as on a server or in
// Next.js, where `useEditor` first returns `null`.
vi.mock('@tiptap/react', async (original) => {
  const tiptap = await original<typeof import('@tiptap/react')>();
  // The same deferred options for the same options, as the field keeps them.
  const deferred = new WeakMap<object, object>();
  return {
    ...tiptap,
    useEditor: (options: Parameters<typeof tiptap.useEditor>[0]) => {
      if (!deferred.has(options))
        deferred.set(options, { ...options, immediatelyRender: false });
      return tiptap.useEditor(
        deferred.get(options) as Parameters<typeof tiptap.useEditor>[0],
      );
    },
  };
});

Range.prototype.getClientRects = () =>
  ({
    length: 0,
    item: () => null,
    [Symbol.iterator]: [][Symbol.iterator],
  }) as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();

afterEach(cleanup);

it('writes once Tiptap has created its editor after the first render', async () => {
  render(
    <MarkdownField
      label="Notes"
      value="Buy **milk**"
      onChange={() => {}}
      defaultPresentation="write"
    />,
  );
  const input = await screen.findByRole(
    'textbox',
    { name: 'Notes' },
    { timeout: 5000 },
  );
  expect(input.querySelector('strong')?.textContent).toBe('milk');
  expect(screen.getByRole('button', { name: 'Bold' })).toBeTruthy();
});
