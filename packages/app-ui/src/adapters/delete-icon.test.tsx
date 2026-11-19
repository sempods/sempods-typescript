// @vitest-environment jsdom
/** The shared delete glyph and the SDK's `RemoveButton` default (#389). */
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { RemoveButton } from '@sempods/app-sdk/react';
import { ActionButton } from './action-button.js';
import { DeleteIcon } from './delete-icon.js';

afterEach(cleanup);

/** What draws the outline and its size, without classes or React keys. */
const outline = (svg: SVGSVGElement | null) => ({
  attributes: Object.fromEntries(
    [
      'width',
      'height',
      'viewBox',
      'fill',
      'stroke',
      'stroke-width',
      'stroke-linecap',
      'stroke-linejoin',
      'aria-hidden',
    ].map((name) => [name, svg?.getAttribute(name)]),
  ),
  paths: [...(svg?.querySelectorAll('*') ?? [])].map((el) => [
    el.tagName,
    el.getAttribute('d'),
  ]),
});

it('is decorative, 1rem by default, with an explicit size kept', () => {
  const view = render(<DeleteIcon />);
  const svg = view.container.querySelector('svg')!;
  expect(svg.getAttribute('aria-hidden')).toBe('true');
  expect(svg.getAttribute('width')).toBe('1rem');
  expect(svg.getAttribute('height')).toBe('1rem');
  view.rerender(<DeleteIcon size={24} className="text-destructive" />);
  expect(svg.getAttribute('width')).toBe('24');
  expect(svg.getAttribute('class')).toContain('text-destructive');
});

it("draws the same outline at the same size as RemoveButton's default", () => {
  const view = render(
    <>
      <RemoveButton label="Delete: Milk" onRemove={() => {}} />
      <ActionButton variant="secondary">
        <DeleteIcon />
        Clear done tasks
      </ActionButton>
    </>,
  );
  const row = screen.getByRole('button', { name: 'Delete: Milk' });
  const bulk = screen.getByRole('button', { name: 'Clear done tasks' });
  const own = outline(row.querySelector('svg'));
  expect(own.paths).toHaveLength(5);
  expect(own).toEqual(outline(bulk.querySelector('svg')));
  // The glyph adds nothing to either name.
  expect(row.textContent).toBe('');
  view.unmount();
});

it('leaves custom RemoveButton children as they are', () => {
  render(
    <RemoveButton label="Remove Milk" onRemove={() => {}}>
      <DeleteIcon size="1.25rem" />
      Remove
    </RemoveButton>,
  );
  const button = screen.getByRole('button', { name: 'Remove Milk' });
  expect(button.textContent).toBe('Remove');
  expect(button.querySelectorAll('svg')).toHaveLength(1);
  expect(button.querySelector('svg')!.getAttribute('width')).toBe('1.25rem');
});
