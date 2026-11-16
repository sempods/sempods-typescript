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
// its first message 100ms later outside React's act() (sempods-typescript#326).
it("keeps another component's announcement with the count's number as React Aria creates its announcer", async () => {
  const column = 'Score 16';
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false);
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
    await new Promise((done) => setTimeout(done, 160));
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
