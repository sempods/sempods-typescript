import {
  actions,
  secondaries,
  schemes,
  themePairs,
  actionMapping,
  derivedFrom,
  type Scheme,
  type Variant,
} from './pairs.js';
import {
  evaluateTheme,
  type SkippedScheme,
  type ThemeSample,
} from './evaluate.js';
export { themePairs };
export type { Scheme, ThemePair, Variant } from './pairs.js';
export { evaluateTheme, formatThemeReport } from './evaluate.js';
export type { ThemeReport, ThemeSample, SkippedScheme } from './evaluate.js';

function resolver(probe: HTMLElement) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const paint = canvas.getContext('2d', { willReadFrequently: true });
  if (!paint) throw new Error('Theme check requires a 2D canvas');
  paint.globalCompositeOperation = 'copy';
  return (css: string, role: string) => {
    if (/\bcurrentcolor\b/i.test(css))
      throw new Error('Context-dependent currentColor in ' + role);
    if (!CSS.supports('color', css))
      throw new Error('Missing or invalid CSS colour for ' + role);
    probe.style.setProperty('background-color', css, 'important');
    paint.fillStyle = getComputedStyle(probe).backgroundColor;
    paint.fillRect(0, 0, 1, 1);
    const pixel = paint.getImageData(0, 0, 1, 1).data;
    return (
      '#' +
      Array.from(pixel.slice(0, pixel[3] === 255 ? 3 : 4), (n) =>
        n.toString(16).padStart(2, '0'),
      ).join('')
    );
  };
}

function readColours(
  root: HTMLElement,
  variant: Variant,
  scheme: Scheme,
  resolve: ReturnType<typeof resolver>,
) {
  const style = getComputedStyle(root);
  const mapping = actionMapping(variant);
  const roles = new Set([
    ...Object.keys(mapping),
    ...Object.values(mapping),
    'secondary',
    'secondary-foreground',
    'border',
  ]);
  for (const pair of themePairs) {
    roles.add(pair.foreground);
    roles.add(pair.surface);
    for (const backdrop of pair.backdrops) roles.add(backdrop);
  }
  const css: Record<string, string> = {};
  const colours: Record<string, string> = {};
  for (const role of roles) {
    if (role in derivedFrom) continue;
    css[role] =
      role === 'transparent'
        ? role
        : style.getPropertyValue('--' + role).trim();
    colours[role] = resolve(css[role], role);
  }
  colours.canvas = resolve('Canvas', 'canvas');
  for (const [role, foreground, percent] of [
    ['action', 'action-foreground', 12],
    ['action-secondary', 'action-secondary-foreground', 8],
  ] as const)
    colours[role + '-hover'] = resolve(
      `color-mix(in oklch, ${css[role]}, ${css[foreground]} ${percent}%)`,
      role + '-hover',
    );
  const tint = scheme === 'light' ? 10 : 20;
  for (const [role, percent] of [
    ['destructive-tint', tint],
    ['destructive-hover', tint + 10],
  ] as const)
    colours[role] = resolve(
      `color-mix(in oklab, ${css.destructive} ${percent}%, transparent)`,
      role,
    );
  return colours;
}

/** Sample the root theme for every action combination and supported colour
 * scheme. Restores root attributes even when an invalid role throws. CSS media
 * queries retain the browser's preference; emulate that separately in a runner.
 * Supply onlyScheme to sample the matching emulated preference in each run.
 * The snapshots can be replayed with evaluateTheme in Node. */
export function readTheme(onlyScheme?: Scheme) {
  const root = document.documentElement;
  const original = new Map(
    ['data-actions', 'data-secondary', 'style'].map(
      (name) => [name, root.getAttribute(name)] as const,
    ),
  );
  function restore(name: string) {
    const value = original.get(name);
    if (value == null) root.removeAttribute(name);
    else root.setAttribute(name, value);
  }
  const active: Variant = {
    actions: root.dataset.actions === 'inverted' ? 'inverted' : 'solid',
    secondary: secondaries.find((v) => v === root.dataset.secondary) ?? 'tonal',
  };
  const probe = document.createElement('span');
  probe.style.setProperty('all', 'initial', 'important');
  probe.style.setProperty('color-scheme', 'inherit', 'important');
  probe.hidden = true;
  const resolve = resolver(probe);
  const samples: ThemeSample[] = [],
    skipped: SkippedScheme[] = [];
  function sample(variant: Variant, isActive: boolean) {
    restore('style');
    const declared = getComputedStyle(root).colorScheme.split(/\s+/);
    for (const scheme of onlyScheme ? [onlyScheme] : schemes) {
      const sameCase = (s: ThemeSample | SkippedScheme) =>
        s.scheme === scheme &&
        s.variant.actions === variant.actions &&
        s.variant.secondary === variant.secondary;
      if (
        !declared.includes(scheme) &&
        (declared.includes('light') || declared.includes('dark'))
      ) {
        const reason = 'Root color-scheme is ' + declared.join(' ');
        if (!skipped.some((s) => sameCase(s) && s.reason === reason))
          skipped.push({ variant, scheme, reason });
        continue;
      }
      root.style.setProperty('color-scheme', scheme, 'important');
      const colours = readColours(root, variant, scheme, resolve);
      // The implicit default may have different CSS selectors than an explicit
      // solid/tonal choice. Keep both when they actually paint differently.
      if (
        !samples.some(
          (s) =>
            sameCase(s) &&
            Object.keys(colours).every(
              (role) => s.colours[role] === colours[role],
            ),
        )
      ) {
        samples.push({ variant, scheme, colours, active: isActive });
      }
    }
  }
  root.append(probe);
  try {
    sample(active, true);
    for (const actionsValue of actions)
      for (const secondary of secondaries) {
        root.dataset.actions = actionsValue;
        root.dataset.secondary = secondary;
        sample({ actions: actionsValue, secondary }, false);
      }
  } finally {
    probe.remove();
    for (const name of original.keys()) restore(name);
  }
  return { samples, active, skipped };
}

/** Check the loaded app stylesheet. Failures in inactive variants also fail the report. */
export function checkTheme(onlyScheme?: Scheme) {
  const { samples, active, skipped } = readTheme(onlyScheme);
  return evaluateTheme(samples, active, skipped);
}
