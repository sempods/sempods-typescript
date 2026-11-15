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
 * leave out one message with that number in it, as React Aria formats it,
 * that is not one of the field's option texts. Other messages, such as
 * VoiceOver's active option or another component's announcement, are kept.
 */

/** A count React Aria is about to announce for a field. */
interface Expected {
  /** The number as React Aria formats it in its locale. */
  readonly count: string;
  /** The field's option texts, which React Aria announces for VoiceOver. */
  readonly options: readonly string[];
}

/** Counts React Aria announces in the effects of the current commit. */
const now = new Set<Expected>();
/** Counts with which React Aria creates its region, adding them 100ms later. */
const first = new Set<Expected>();
/** The announcer logs guarded so far. */
const guarded = new WeakSet<Element>();
let watcher: MutationObserver | undefined;
/** Counts waiting for React Aria to create its region. */
let waiting = 0;

const digit = (char: string | undefined) =>
  char !== undefined && /\p{Nd}/u.test(char);

/** Whether `text` has `number` in it, not as part of a longer number. */
function hasNumber(text: string, number: string): boolean {
  for (
    let at = text.indexOf(number);
    at >= 0;
    at = text.indexOf(number, at + 1)
  )
    if (!digit(text[at - 1]) && !digit(text[at + number.length])) return true;
  return false;
}

/**
 * Whether `node` is an expected count, which it then uses up: one of the
 * current commit first, so that a later commit's count does not use up the
 * one React Aria still adds as its first message.
 */
function take(node: Node): boolean {
  const text = node.textContent?.trim() ?? '';
  for (const counts of [now, first])
    for (const count of counts) {
      if (count.options.includes(text) || !hasNumber(text, count.count))
        continue;
      counts.delete(count);
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
 * about to announce in this commit, in `locale`, for a field whose options
 * have the texts `options`. Called in the commit before React Aria's own
 * effect: what it announces in that commit's effects, or, the first time,
 * as it creates its region, is left out.
 */
export function expectAriaCount(
  count: number,
  locale: string,
  options: readonly string[],
) {
  const entry: Expected = {
    count: new Intl.NumberFormat(locale).format(count),
    options,
  };
  if (guardAll()) {
    now.add(entry);
    // React Aria announces in the effects of this commit, before this.
    queueMicrotask(() => now.delete(entry));
    return;
  }
  first.add(entry);
  // React Aria creates its region with its first message and adds that
  // message 100ms later.
  waiting++;
  watcher ??= new MutationObserver(guardAll);
  watcher.observe(document.body, { childList: true });
  setTimeout(() => {
    first.delete(entry);
    if (--waiting === 0) watcher?.disconnect();
  }, 1000);
}
