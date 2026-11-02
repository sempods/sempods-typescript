import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  evaluateTheme,
  formatThemeReport,
  themePairs,
  type ThemeSample,
  type Variant,
} from './index.js';
import { actionMapping } from './pairs.js';

const active: Variant = { actions: 'solid', secondary: 'tonal' };
function sample(variant = active): ThemeSample {
  const colours: Record<string, string> = {
    canvas: '#ffffff',
    transparent: '#00000000',
  };
  for (const pair of themePairs) {
    colours[pair.surface] ??= '#ffffff';
    colours[pair.foreground] ??= '#000000';
  }
  Object.assign(colours, {
    secondary: '#ffffff',
    'secondary-foreground': '#000000',
    primary: '#000000',
    'primary-foreground': '#ffffff',
  });
  for (const [role, palette] of Object.entries(actionMapping(variant)))
    colours[role] = colours[palette]!;
  colours['action-hover'] = colours.action!;
  colours['action-secondary-hover'] = colours['action-secondary']!;
  return { variant, scheme: 'light', colours };
}

describe('theme contract', () => {
  it('keeps the theme-check runtime exports deliberate', async () => {
    expect(Object.keys(await import('./index.js')).sort()).toEqual([
      'checkTheme',
      'evaluateTheme',
      'formatThemeReport',
      'readTheme',
      'themePairs',
    ]);
  });
  it.each(themePairs)(
    '$variant $name $state checks every backdrop at the declared threshold',
    (pair) => {
      const variant = { ...active };
      if (pair.variant === 'inverted') variant.actions = pair.variant;
      if (pair.variant === 'outline' || pair.variant === 'text')
        variant.secondary = pair.variant;
      const data = sample(variant);
      const colours = { ...data.colours, [pair.foreground]: '#00000000' };
      const failures = evaluateTheme(
        [{ ...data, colours }],
        active,
      ).failures.filter((f) => f.pair === pair.name && f.state === pair.state);
      expect(failures.map((f) => [f.backdrop, f.ratio, f.required])).toEqual(
        pair.backdrops.map((b) => [b, 1, pair.required]),
      );
    },
  );
  it('composites the resolved hover over the dialog and reports an overridden surface', () => {
    const data = sample({ actions: 'inverted', secondary: 'text' });
    const colours = {
      ...data.colours,
      'action-secondary': '#00000040',
      'action-secondary-hover': '#00000080',
      'action-secondary-foreground': '#333333',
      popover: '#888888',
    };
    const result = evaluateTheme([{ ...data, colours }], active);
    const f = result.failures.find(
      (f) =>
        f.pair === 'secondary action text' &&
        f.state === 'hover' &&
        f.backdrop === 'popover',
    )!;
    expect(f.surface.colour).toBe('#444444');
    expect(f.foreground.override).toBe(true);
    expect(f.adjust).toEqual([
      'action-secondary-foreground',
      'action-secondary',
      'popover',
    ]);
    expect(f.alsoReads.popover).toContain(
      'inverted / text / popover text / background / rest',
    );
    expect(f.active).toBe(false);
    expect(formatThemeReport(result)).toContain(
      'secondary action text on popover (hover)',
    );
  });
  it('attributes equivalent opaque hex values to their palette role', () => {
    const data = sample();
    const colours = {
      ...data.colours,
      'action-foreground': '#FF0000FF',
      'primary-foreground': '#ff0000',
      primary: '#ff0000',
      action: '#ff0000',
    };
    const failure = evaluateTheme([{ ...data, colours }], active).failures.find(
      (f) => f.pair === 'primary action text',
    )!;
    expect(failure.foreground.override).toBe(false);
    expect(failure.adjust).toContain('primary-foreground');
  });
  it('uses unrounded ratios at the text threshold', () => {
    const data = sample();
    for (const [foreground, fails] of [
      ['#767676', false],
      ['#777777', true],
    ] as const) {
      const report = evaluateTheme(
        [{ ...data, colours: { ...data.colours, foreground } }],
        active,
      );
      expect(report.failures.some((f) => f.pair === 'background text')).toBe(
        fails,
      );
    }
  });
  it('keeps the README pair table in sync with the data', () => {
    const readme = readFileSync(
      new URL('../../README.md', import.meta.url),
      'utf8',
    );
    const rows = readme
      .split('<!-- theme-pairs -->')[1]!
      .split('<!-- /theme-pairs -->')[0]!
      .trim()
      .split('\n')
      .slice(2);
    expect(
      rows.map((row) =>
        row
          .split('|')
          .slice(1, -1)
          .map((cell) => cell.trim()),
      ),
    ).toEqual(
      themePairs.map((p) => [
        p.variant,
        p.foreground,
        p.surface,
        p.backdrops.join(', '),
        p.state,
        String(p.required),
      ]),
    );
  });
});
