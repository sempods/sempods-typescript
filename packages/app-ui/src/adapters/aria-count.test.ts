// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { expectAriaCount } from './aria-count.js';

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

const tick = () => new Promise((done) => setTimeout(done, 0));

afterEach(async () => {
  // Expectations still waiting for a region end after 1s.
  document.body.innerHTML = '';
  await tick();
});

it('leaves out the one expected count of this commit, nothing else', async () => {
  const [assertive, polite] = announcer();
  expectAriaCount(2, 'en-US', ['Flat 2']);
  say(assertive, 'Flat 2');
  say(polite, 'Selected Date: Monday, November 16, 2026');
  say(assertive, '12 options available.');
  say(assertive, '2 options available.');
  say(assertive, '2 options available.');
  await tick();
  say(assertive, '2 options available.');
  expect(said(assertive)).toEqual([
    'Flat 2',
    '12 options available.',
    '2 options available.',
    '2 options available.',
  ]);
  expect(said(polite)).toEqual(['Selected Date: Monday, November 16, 2026']);
});

it('keeps a waiting first count for the message React Aria adds later', async () => {
  // React Aria creates its region with "0 options available.", adds it
  // 100ms later, and announces a later commit's count at once.
  expectAriaCount(0, 'en-US', []);
  const [assertive] = announcer();
  expectAriaCount(0, 'en-US', []);
  say(assertive, '0 options available.');
  await tick();
  say(assertive, '0 options available.');
  expect(said(assertive)).toEqual([]);
});

it('reads the count as React Aria formats it in its locale', () => {
  const [assertive] = announcer();
  expectAriaCount(1000, 'de-DE', []);
  say(assertive, '1000 Optionen verfügbar.');
  say(assertive, '1.000 Optionen verfügbar.');
  expect(said(assertive)).toEqual(['1000 Optionen verfügbar.']);
});

it('leaves out a count with which React Aria creates its region', async () => {
  expectAriaCount(0, 'en-US', []);
  let [assertive] = announcer();
  // Under act() React Aria adds its first message with the region.
  say(assertive, '0 options available.');
  await tick();
  expect(said(assertive)).toEqual([]);
  document.body.innerHTML = '';
  expectAriaCount(1, 'en-US', []);
  [assertive] = announcer();
  await tick();
  // In a browser it adds it 100ms later.
  say(assertive, '1 option available.');
  expect(said(assertive)).toEqual([]);
});
