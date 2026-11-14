/** Page chrome follows the app's resolved background. Installed native bars
 * may instead use the manifest's static theme_color; this does not control them. */
export function syncBrowserTheme() {
  const probe = document.createElement('span');
  probe.style.color = 'var(--sempods-bg)';
  document.body.append(probe);
  const background = getComputedStyle(probe).color;
  probe.remove();
  for (const meta of document.querySelectorAll<HTMLMetaElement>(
    'meta[name="theme-color"][data-sempods-theme]',
  ))
    meta.content = background;
}

syncBrowserTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener(
  'change',
  syncBrowserTheme,
);
