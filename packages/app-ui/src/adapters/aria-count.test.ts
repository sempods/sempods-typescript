// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
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
  document.body.innerHTML = '';
  // A count waiting for React Aria's first message ends 100ms after React
  // Aria creates its region.
  await new Promise((done) => setTimeout(done, 110));
});

it('leaves out the one expected count of this commit, nothing else', async () => {
  const [assertive, polite] = announcer();
  expectAriaCount(2, 'en-US');
  say(assertive, 'Flat 2');
  say(polite, '2 of 16 selected.');
  say(assertive, '12 options available.');
  say(assertive, 'sorted by column Score 2 in descending order');
  say(assertive, '2 options available.');
  say(assertive, '2 options available.');
  await tick();
  say(assertive, '2 options available.');
  expect(said(assertive)).toEqual([
    'Flat 2',
    '12 options available.',
    'sorted by column Score 2 in descending order',
    '2 options available.',
    '2 options available.',
  ]);
  expect(said(polite)).toEqual(['2 of 16 selected.']);
});

it('reads the count as React Aria formats it in its locale', () => {
  const [assertive] = announcer();
  expectAriaCount(1000, 'de-DE');
  say(assertive, '1000 Optionen verfügbar.');
  say(assertive, '1.000 Optionen verfügbar.');
  expect(said(assertive)).toEqual(['1000 Optionen verfügbar.']);
});

/** What React Aria adds from the 100ms timer it sets after creating its region. */
const later = (log: Element, text: string) =>
  new Promise<void>((done) =>
    setTimeout(() => {
      say(log, text);
      done();
    }, 100),
  );

it('leaves out a count with which React Aria creates its region', async () => {
  expectAriaCount(0, 'en-US');
  let [assertive] = announcer();
  // Under act() React Aria adds its first message with the region.
  say(assertive, '0 options available.');
  await tick();
  expect(said(assertive)).toEqual([]);
  document.body.innerHTML = '';
  // In a browser it adds it 100ms later; a later commit's count, announced
  // at once, does not use up its place.
  expectAriaCount(1, 'en-US');
  [assertive] = announcer();
  const first = later(assertive, '1 option available.');
  expectAriaCount(1, 'en-US');
  say(assertive, '1 option available.');
  await first;
  expect(said(assertive)).toEqual([]);
});

/** Keeps the page busy, as a slow device between two effects. */
const busy = (ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end);
};

it('leaves out the first count when the page is busy before React Aria creates its region', async () => {
  expectAriaCount(3, 'en-US');
  busy(60);
  const [assertive] = announcer();
  const first = later(assertive, '3 options available.');
  await first;
  expect(said(assertive)).toEqual([]);
});

it('leaves out the first count when its timers due together run in another order', async () => {
  // On a busy page Node ran the field's 0ms timer after its 100ms timer
  // (CI on PR 356): the 0ms one is set here only after the 100ms one.
  const set = globalThis.setTimeout;
  let zero: (() => void) | undefined;
  vi.stubGlobal('setTimeout', ((run: () => void, ms?: number) => {
    if (ms === 0 && !zero) {
      zero = run;
      return 0;
    }
    const timer = set(run, ms);
    if (ms === 100 && zero) set(zero, 100);
    return timer;
  }) as typeof setTimeout);
  try {
    expectAriaCount(4, 'en-US');
  } finally {
    vi.unstubAllGlobals();
  }
  expect(zero).toBeDefined();
  const [assertive] = announcer();
  await later(assertive, '4 options available.');
  expect(said(assertive)).toEqual([]);
});

it('expects no first count once React Aria did not create its region in that commit', async () => {
  expectAriaCount(5, 'en-US');
  await new Promise((done) => setTimeout(done, 110));
  const [assertive] = announcer();
  say(assertive, '5 options available.');
  await tick();
  expect(said(assertive)).toEqual(['5 options available.']);
});

it("keeps another message with the number while React Aria's first count waits", async () => {
  expectAriaCount(16, 'en-US');
  const [assertive, polite] = announcer();
  const first = later(assertive, '16 options available.');
  // Another component's announcement in the task that creates the region.
  say(assertive, 'sorted by column Score 16 in descending order');
  await new Promise((done) => setTimeout(done, 50));
  say(polite, 'Moved to row 16.');
  say(polite, 'Selected Date: Monday, November 16, 2026');
  await first;
  expect(said(assertive)).toEqual([
    'sorted by column Score 16 in descending order',
  ]);
  expect(said(polite)).toEqual([
    'Moved to row 16.',
    'Selected Date: Monday, November 16, 2026',
  ]);
});
