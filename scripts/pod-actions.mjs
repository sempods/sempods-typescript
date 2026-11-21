/**
 * Opens the actions of the one Pod row in AppAccess management (#386):
 * **Change sharing** and **Sign out on this device** sit behind the Pod's
 * own button, named "Actions for" the Pod.
 */
export async function podActions(scope) {
  const more = scope.getByRole('button', {
    name: /^(Actions for|Aktionen für) /,
  });
  if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click();
}
