// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { quietAriaCount } from './aria-count.js';

/** A region shaped like React Aria's announcer, with its two logs. */
function announcer(): readonly [Element, Element] {
  const region = document.createElement('div');
  region.dataset.liveAnnouncer = 'true';
  const log = (live: string) => {
    const node = document.createElement('div');
    node.setAttribute('role', 'log');
    node.setAttribute('aria-live', live);
    return region.appendChild(node);
  };
  const logs = [log('assertive'), log('polite')] as const;
  document.body.prepend(region);
  return logs;
}

const say = (log: Element, text: string) => {
  const node = document.createElement('div');
  node.textContent = text;
  log.appendChild(node);
};

const said = (log: Element) => [...log.children].map((n) => n.textContent);

afterEach(() => {
  document.body.innerHTML = '';
});

it('keeps counts out while a field has the focus, its options and other messages in', () => {
  const [assertive, polite] = announcer();
  const stop = quietAriaCount(() => ['Flat 3']);
  say(assertive, '2 options available.');
  say(polite, '٢ خيارات متاحة.');
  say(assertive, 'Flat 3');
  say(assertive, 'Saved.');
  stop();
  say(assertive, '3 options available.');
  expect(said(assertive)).toEqual(['Flat 3', 'Saved.', '3 options available.']);
  expect(said(polite)).toEqual([]);
});

it('guards a region React Aria creates later, also its first message', async () => {
  const stop = quietAriaCount(() => []);
  const [assertive] = announcer();
  // Under act() React Aria adds its first message with the region.
  say(assertive, '0 options available.');
  await Promise.resolve();
  expect(said(assertive)).toEqual([]);
  say(assertive, '1 option available.');
  expect(said(assertive)).toEqual([]);
  stop();
});
