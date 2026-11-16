// @vitest-environment jsdom
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import {
  Cell,
  Column,
  Row,
  Table,
  TableBody,
  TableHeader,
} from 'react-aria-components';
import { expect, it, vi } from 'vitest';
import { SuggestField } from './suggest-field.js';

// In a file of its own: React Aria creates its announcer once per page, with
// its first message 100ms later outside React's act() (sempods-typescript#326),
// from a timer it sets in an effect after the field's.
it("keeps another component's announcement with the count's number as React Aria creates its announcer on a busy page", async () => {
  const column = 'Score 16';
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false);
  // A slow device (sempods-typescript#353): the page is busy for 60ms after
  // the field sets its 100ms timer, before React Aria sets its own.
  const later = globalThis.setTimeout;
  let busy = false;
  let delivered = false;
  vi.stubGlobal('setTimeout', ((run: () => void, ms?: number) => {
    const from = new Error().stack ?? '';
    // React Aria's first message, which the field leaves out.
    const first = ms === 100 && from.includes('LiveAnnouncer');
    const timer = later(
      first
        ? () => {
            run();
            delivered = true;
          }
        : run,
      ms,
    );
    if (ms === 100 && !busy && from.includes('aria-count')) {
      busy = true;
      const end = Date.now() + 60;
      while (Date.now() < end);
    }
    return timer;
  }) as typeof setTimeout);
  const items = Array.from({ length: 16 }, (_, i) => ({
    id: String(i),
    label: `Place ${i}`,
  }));
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  const page = (value: string, descending: boolean) => (
    <>
      <SuggestField
        label="Search"
        value={value}
        onChange={() => {}}
        items={items}
        onSelect={() => {}}
      />
      <Table
        aria-label="Results"
        sortDescriptor={
          descending ? { column: 'score', direction: 'descending' } : undefined
        }
      >
        <TableHeader>
          <Column id="score" isRowHeader allowsSorting>
            {column}
          </Column>
        </TableHeader>
        <TableBody>
          <Row id="row">
            <Cell>Example</Cell>
          </Row>
        </TableBody>
      </Table>
    </>
  );
  try {
    flushSync(() => root.render(page('', false)));
    flushSync(() => host.querySelector('input')?.focus());
    flushSync(() => root.render(page('x', false)));
    expect(host.querySelector('input')?.getAttribute('aria-expanded')).toBe(
      'true',
    );
    flushSync(() => root.render(page('x', true)));
    expect(busy).toBe(true);
    // Set after React Aria's 100ms timer, so it runs after its first message.
    await new Promise((done) => setTimeout(done, 100));
    expect(delivered).toBe(true);
    const said = [
      ...document.querySelectorAll(
        'body > [data-live-announcer] > [role="log"] > *',
      ),
    ].map((node) => node.textContent);
    expect(said).toEqual([`sorted by column ${column} in descending order`]);
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
