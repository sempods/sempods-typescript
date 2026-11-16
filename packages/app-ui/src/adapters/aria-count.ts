/**
 * Keeps a suggestion field's option count out of React Aria's announcer:
 * the field announces its suggestions itself, knowing whether the search
 * still runs or failed (sempods/sempods-typescript#326).
 *
 * React Aria speaks through one live region of its own, prepended to the
 * body with `data-live-announcer` and two `role="log"` children, shared by
 * all its components. Its combo box (`useComboBox`) adds the number of
 * options there ("2 options available.") in the commit in which its list
 * opens or that number changes while it is open, also "0 options
 * available." while the first results load. The announcer is internal to
 * React Aria and has no option for the count, so the field says in that
 * commit which count to expect (`expectAriaCount`), and the region's logs
 * leave out one message that is exactly that count as React Aria says it in
 * its locale (aria-count-text.ts). Such a message is expected only in that
 * commit's task, or, when React Aria creates its region with it, as its
 * delayed first message. Other messages, such as VoiceOver's active option
 * or another component's announcement, also one with the same number, are
 * kept.
 *
 * The delayed first message comes from a 100ms timer React Aria sets as it
 * creates its region, in an effect after the field's: on a slow device the
 * page can be busy for a while in between (sempods-typescript#353). A
 * browser runs timers of the same delay in the order they were set, so the
 * field waits for that message from a 100ms timer it sets before React
 * Aria's until one it sets once the region exists.
 */

import { ariaCountText } from './aria-count-text.js';

/** A count React Aria is about to announce for a field. */
interface Expected {
  /** React Aria announced it. */
  done?: boolean;
  /** The count as React Aria says it in its locale. */
  readonly text: string;
}

/** Counts React Aria announces in the effects of the current commit. */
const now = new Set<Expected>();
/**
 * Counts with which React Aria creates its region, while it may add them:
 * at once under React's act(), else from its 100ms timer.
 */
const first = new Set<Expected>();
/** The announcer logs guarded so far. */
const guarded = new WeakSet<Element>();
let watcher: MutationObserver | undefined;
/** Counts waiting for React Aria to create its region. */
const waiting = new Set<Expected>();

/**
 * Whether `node` is an expected count, which it then uses up: one of the
 * current commit first, so that a later commit's count does not use up the
 * one React Aria still adds as its first message.
 */
function take(node: Node): boolean {
  const text = node.textContent;
  for (const counts of [now, first])
    for (const count of counts) {
      if (text !== count.text) continue;
      counts.delete(count);
      count.done = true;
      return true;
    }
  return false;
}

function guard(log: Element) {
  if (guarded.has(log)) return;
  guarded.add(log);
  // A message React Aria added in the task that created the region (the
  // first under React's act()) is taken out before the page renders.
  for (const node of [...log.childNodes]) if (take(node)) node.remove();
  const append = log.appendChild.bind(log);
  Object.defineProperty(log, 'appendChild', {
    configurable: true,
    value: <T extends Node>(node: T): T => (take(node) ? node : append(node)),
  });
}

/** Guards the logs of React Aria's region; whether it exists. */
function guardAll(): boolean {
  const logs = document.querySelectorAll(
    'body > [data-live-announcer] > [role="log"]',
  );
  for (const log of logs) guard(log);
  return logs.length > 0;
}

/**
 * Leaves out of React Aria's announcer the count of `count` options it is
 * about to announce in this commit, in `locale`. Called in the commit
 * before React Aria's own effect: what it announces in that commit's
 * effects, or, the first time, as it creates its region, is left out.
 */
export function expectAriaCount(count: number, locale: string) {
  const entry: Expected = { text: ariaCountText(count, locale) };
  if (guardAll()) {
    now.add(entry);
    // React Aria announces in the effects of this commit, before this.
    queueMicrotask(() => now.delete(entry));
    return;
  }
  // React Aria creates its region with its first message: it adds that
  // message at once under React's act(), else from a 100ms timer it sets
  // in this commit's effects, after the one set here, and maybe much later
  // than this on a slow device.
  waiting.add(entry);
  watcher ??= new MutationObserver(created);
  watcher.observe(document.body, { childList: true });
  first.add(entry);
  setTimeout(() => first.delete(entry), 0);
  setTimeout(() => {
    // React Aria did not create its region in that commit: it does not
    // announce the count.
    if (waiting.delete(entry)) stopWatching();
    else if (!entry.done) first.add(entry);
  }, 100);
}

/**
 * Once React Aria has created its region, ends the wait for the first
 * message of the counts waiting for it: React Aria set its 100ms timer as
 * it created the region, before this, so the same delay set now ends after
 * that message.
 */
function created() {
  if (!guardAll()) return;
  const counts = [...waiting];
  waiting.clear();
  stopWatching();
  setTimeout(() => {
    for (const count of counts) first.delete(count);
  }, 100);
}

function stopWatching() {
  if (waiting.size === 0) watcher?.disconnect();
}
