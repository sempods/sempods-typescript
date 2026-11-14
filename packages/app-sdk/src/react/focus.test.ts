// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { returnFocusAfterCommit } from './focus.js';

afterEach(() => document.body.replaceChildren());

/** A page with an opener, a focus target inside a dialog and another button. */
function page() {
  // jsdom focuses nothing inside a closed <dialog>: an element with its role
  // stands in.
  const around = document.createElement('div');
  around.setAttribute('role', 'dialog');
  around.tabIndex = -1;
  const [opener, target, other] = ['Opener', 'Target', 'Other'].map((name) => {
    const button = document.createElement('button');
    button.textContent = name;
    return button;
  }) as [HTMLButtonElement, HTMLButtonElement, HTMLButtonElement];
  around.append(target);
  document.body.append(opener, around, other);
  return { around, opener, target, other };
}

const afterCommit = () => new Promise<void>((done) => queueMicrotask(done));

it('moves the focus to the target only after the commit', async () => {
  const { target } = page();
  returnFocusAfterCommit(target);
  expect(document.activeElement).toBe(document.body);
  await afterCommit();
  expect(document.activeElement).toBe(target);
});

it('moves it from where the closing dialog left it: its opener or a dialog around', async () => {
  // A native dialog's close() restores the focus to its opener; WebKit
  // focuses an enclosing dialog. An explicit target still gets it.
  const { around, opener, target } = page();
  opener.focus();
  returnFocusAfterCommit(target);
  await afterCommit();
  expect(document.activeElement).toBe(target);
  around.focus();
  returnFocusAfterCommit(target);
  await afterCommit();
  expect(document.activeElement).toBe(target);
});

it('moves it away and back when it is on the target already, so React sees it arrive', async () => {
  const { target } = page();
  target.focus();
  const seen: string[] = [];
  target.addEventListener('blur', () => seen.push('blur'));
  target.addEventListener('focus', () => seen.push('focus'));
  returnFocusAfterCommit(target);
  await afterCommit();
  expect(document.activeElement).toBe(target);
  expect(seen).toEqual(['blur', 'focus']);
});

it('leaves the focus where something else moved it meanwhile', async () => {
  const { opener, target, other } = page();
  opener.focus();
  returnFocusAfterCommit(target);
  other.focus();
  await afterCommit();
  expect(document.activeElement).toBe(other);
});

it('does nothing for a target that has gone', async () => {
  const { opener, target } = page();
  opener.focus();
  returnFocusAfterCommit(target);
  target.remove();
  await afterCommit();
  expect(document.activeElement).toBe(opener);
});
