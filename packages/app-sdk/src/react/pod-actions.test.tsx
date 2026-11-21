// Helpers for Pods & sharing management (#386), shared by its test suites:
// a module of their own, so importing them registers no Pod row tests.
import { expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { englishMessages, germanMessages } from '../locale.js';

const actionsName = /^(Actions for|Aktionen für) /;

/**
 * The ⋯ button of a Pod row in management: of the Pod named `pod`, else of
 * the only row that has one.
 */
export async function podActions(pod?: string) {
  return waitFor(() => {
    const all = screen
      .getAllByRole('button', { name: actionsName })
      .filter(
        (button) =>
          pod === undefined ||
          button.getAttribute('aria-label')!.replace(actionsName, '') === pod,
      );
    expect(all).toHaveLength(1);
    return all[0]!;
  });
}

/**
 * Opens a Pod row's actions (unless open) and returns the one named
 * `action`, for example "Sign out on this device".
 */
export async function podAction(action: string | RegExp, pod?: string) {
  const trigger = await podActions(pod);
  if (trigger.getAttribute('aria-expanded') !== 'true')
    fireEvent.click(trigger);
  const menu = document.getElementById(trigger.getAttribute('aria-controls')!)!;
  return within(menu).getByRole('button', { name: action });
}

/** The names of a Pod row's actions, opening them. */
export async function podActionNames(pod?: string) {
  const trigger = await podActions(pod);
  if (trigger.getAttribute('aria-expanded') !== 'true')
    fireEvent.click(trigger);
  const menu = document.getElementById(trigger.getAttribute('aria-controls')!)!;
  return within(menu)
    .getAllByRole('button')
    .map((button) => button.textContent);
}

it('finds the Pod actions by the label of each shipped locale', () => {
  for (const messages of [englishMessages, germanMessages]) {
    const label = messages.podActions!('pod.example/alice');
    expect(label.replace(actionsName, '')).toBe('pod.example/alice');
  }
});
