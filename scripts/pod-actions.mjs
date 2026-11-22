/** The name of a Pod's own button in the shipped locales. */
export const actionsName = /^(Actions for|Aktionen für) /;

/**
 * The button of a Pod row in AppAccess management (#386) that holds its
 * actions, such as **Change sharing** and **Sign out on this device**: of the
 * Pod named `pod`, else of the only row.
 */
export function podActionsButton(scope, pod) {
  return scope.getByRole('button', {
    name:
      pod === undefined
        ? actionsName
        : new RegExp(actionsName.source + '.*' + pod),
  });
}

/** Opens the actions of a Pod row (see `podActionsButton`), unless open. */
export async function podActions(scope, pod) {
  const more = podActionsButton(scope, pod);
  if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click();
}
