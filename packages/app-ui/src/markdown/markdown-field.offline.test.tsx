// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MarkdownField } from './markdown-field.js';

// The writer's module cannot be loaded, as offline or after a deploy.
vi.mock('./rich-editor.js', () => {
  throw new Error('Failed to fetch dynamically imported module');
});

afterEach(cleanup);

it('writes Markdown when the formatted writer cannot load', async () => {
  const changed = vi.fn();
  render(
    <MarkdownField label="Notes" value="Buy **milk**" onChange={changed} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Edit text' }));
  const input = await screen.findByRole<HTMLTextAreaElement>('textbox', {
    name: 'Notes',
  });
  expect(input.tagName).toBe('TEXTAREA');
  expect(input.value).toBe('Buy **milk**');
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: 'Buy **oat milk**' } });
  expect(changed).toHaveBeenCalledWith('Buy **oat milk**');
});
