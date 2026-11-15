/**
 * Keeps React Aria's option count out of its announcer while a suggestion
 * field has the focus: the field announces its suggestions itself, knowing
 * whether the search still runs or failed (sempods/sempods-typescript#326).
 *
 * React Aria speaks through one live region of its own, prepended to the
 * body with `data-live-announcer` and two `role="log"` children. Its combo
 * box (`useComboBox`) adds the number of options there ("2 options
 * available.") whenever its list opens without an active option or that
 * number changes while it is open, also "0 options available." while the
 * first results load. On Apple devices it adds the active option's text
 * too, for VoiceOver. The announcer is internal to React Aria and has no
 * option for the count, so the logs are guarded instead: while a field has
 * the focus, a message with a number in it that is not the text of one of
 * that field's options is not added. The active option's text, and any
 * message without a number, still is.
 */

/** The option texts of each field that has the focus. */
const focused = new Set<() => readonly string[]>();
/** The announcer logs guarded so far. */
const guarded = new WeakSet<Element>();
let watcher: MutationObserver | undefined;

function isCount(node: Node): boolean {
  const text = node.textContent?.trim() ?? '';
  if (!/\p{Nd}/u.test(text)) return false;
  for (const options of focused) if (options().includes(text)) return false;
  return true;
}

function guard(log: Element) {
  if (guarded.has(log)) return;
  guarded.add(log);
  // A message React Aria added in the task that created the region (a
  // second one in a browser, which delays its first by 100ms; the first
  // under React's act()) is taken out before the page renders.
  for (const node of [...log.childNodes])
    if (focused.size > 0 && isCount(node)) node.remove();
  const append = log.appendChild.bind(log);
  Object.defineProperty(log, 'appendChild', {
    configurable: true,
    value: <T extends Node>(node: T): T =>
      focused.size > 0 && isCount(node) ? node : append(node),
  });
}

function guardAll() {
  for (const log of document.querySelectorAll(
    'body > [data-live-announcer] > [role="log"]',
  ))
    guard(log);
}

/**
 * Keeps React Aria's count quiet from now on, for a field with the focus
 * whose options have the texts `options()`; the result ends that.
 */
export function quietAriaCount(options: () => readonly string[]): () => void {
  focused.add(options);
  guardAll();
  // React Aria creates its region with its first message.
  watcher ??= new MutationObserver(guardAll);
  watcher.observe(document.body, { childList: true });
  return () => {
    focused.delete(options);
    if (focused.size === 0) watcher?.disconnect();
  };
}
