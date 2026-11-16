/**
 * The app's appearance: the system's light or dark mode, or one of them
 * fixed. A device-local presentation choice, kept in this browser only.
 */
export type Appearance = 'system' | 'light' | 'dark';

const key = 'todo-appearance';

/** The stored choice; `system` when none was made or storage is blocked. */
export function readAppearance(): Appearance {
  try {
    const stored = localStorage.getItem(key);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // Storage can be unavailable (a private window, blocked site data).
  }
  return 'system';
}

/**
 * Applies a choice to the page and keeps it. `style.css` maps
 * `data-appearance` on `<html>` to `color-scheme` and Tailwind's `dark:`
 * variant; `browser-theme.ts` follows it with the marked theme-color metas.
 */
export function applyAppearance(appearance: Appearance) {
  const root = document.documentElement;
  if (appearance === 'system') delete root.dataset.appearance;
  else root.dataset.appearance = appearance;
  try {
    if (appearance === 'system') localStorage.removeItem(key);
    else localStorage.setItem(key, appearance);
  } catch {
    // The choice still applies to this page.
  }
}
