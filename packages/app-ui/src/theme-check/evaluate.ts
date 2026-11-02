import {
  actionMapping,
  derivedFrom,
  themePairs,
  type Scheme,
  type Variant,
} from './pairs.js';

/** Resolved sRGB colours in #rrggbb or #rrggbbaa form, including derived
 * hover/tint surfaces. Canvas is the UA page colour behind translucent roles. */
export interface ThemeSample {
  /** True for the page as loaded, including omitted variant attributes. */
  active?: boolean;
  variant: Variant;
  scheme: Scheme;
  colours: Readonly<Record<string, string>>;
}
export interface SkippedScheme {
  variant: Variant;
  scheme: Scheme;
  reason: string;
}
type RGB = readonly [number, number, number];
function parse(value: string | undefined, role: string) {
  if (!value || !/^#[\da-f]{6}([\da-f]{2})?$/i.test(value))
    throw new Error('Missing or invalid resolved colour for ' + role);
  const channel = (index: number) =>
    parseInt(value.slice(index, index + 2), 16);
  return {
    rgb: [channel(1), channel(3), channel(5)] as RGB,
    alpha: value.length === 9 ? channel(7) / 255 : 1,
  };
}
function over({ rgb, alpha }: ReturnType<typeof parse>, under: RGB): RGB {
  return [
    rgb[0] * alpha + under[0] * (1 - alpha),
    rgb[1] * alpha + under[1] * (1 - alpha),
    rgb[2] * alpha + under[2] * (1 - alpha),
  ];
}
function hex(rgb: RGB) {
  return (
    '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
  );
}
function luminance(rgb: RGB) {
  const linear = (n: number) =>
    (n /= 255) <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  return (
    0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2])
  );
}

function measure({ variant, scheme, colours, active }: ThemeSample) {
  const colour = (role: string) => parse(colours[role], role);
  const mapping = actionMapping(variant);
  const source = (role: string) => {
    const mapped = mapping[role];
    if (!mapped) return role;
    const component = colour(role),
      palette = colour(mapped);
    return component.alpha === palette.alpha &&
      component.rgb.every((v, i) => v === palette.rgb[i])
      ? mapped
      : role;
  };
  const roles = (role: string) =>
    (derivedFrom[role] ?? [role])
      .map(source)
      .filter((r) => r !== 'transparent');
  const describe = (role: string, painted: RGB) => ({
    role,
    palette: roles(role),
    override: (derivedFrom[role] ?? [role]).some(
      (r) => !!mapping[r] && source(r) === r,
    ),
    colour: hex(painted),
  });
  const canvas = colour('canvas').rgb;
  const page = over(colour('background'), canvas);
  return themePairs
    .filter(
      (p) =>
        p.variant === 'all' ||
        p.variant === variant.actions ||
        p.variant === variant.secondary,
    )
    .flatMap((p) =>
      p.backdrops.map((backdrop) => {
        const surface = colour(p.surface);
        // When the pair itself reads the page, paint its background just once.
        const under =
          p.surface === 'background'
            ? canvas
            : backdrop === 'background'
              ? page
              : over(colour(backdrop), page);
        const painted = over(surface, under);
        const ink = over(colour(p.foreground), painted);
        const a = luminance(ink),
          b = luminance(painted);
        const dependencies = [...roles(p.foreground), ...roles(p.surface)];
        if (surface.alpha < 1 && p.surface !== 'background') {
          dependencies.push(backdrop);
          if (colour(backdrop).alpha < 1) dependencies.push('background');
        }
        return {
          scheme,
          variant,
          active,
          pair: p.name,
          state: p.state,
          backdrop,
          foreground: describe(p.foreground, ink),
          surface: describe(p.surface, painted),
          adjust: [...new Set(dependencies)],
          ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
          required: p.required,
        };
      }),
    );
}

/** Evaluate resolved samples without a DOM. Compare unrounded WCAG ratios
 * and report the other pairs in the same scheme affected by each adjustment. */
export function evaluateTheme(
  samples: readonly ThemeSample[],
  active: Variant,
  skipped: readonly SkippedScheme[] = [],
) {
  const measured = samples.flatMap(measure);
  const failures = measured
    .filter((p) => p.ratio < p.required)
    .map((failure) => ({
      ...failure,
      active:
        failure.active ??
        (failure.variant.actions === active.actions &&
          failure.variant.secondary === active.secondary),
      alsoReads: Object.fromEntries(
        failure.adjust.map((role) => [
          role,
          measured
            .filter(
              (p) =>
                p !== failure &&
                p.scheme === failure.scheme &&
                p.adjust.includes(role),
            )
            .map((p) =>
              [
                p.variant.actions,
                p.variant.secondary,
                p.pair,
                p.backdrop,
                p.state,
              ].join(' / '),
            ),
        ]),
      ),
    }));
  return {
    pass: measured.length > 0 && failures.length === 0,
    active,
    failures,
    skipped,
  };
}
export type ThemeReport = ReturnType<typeof evaluateTheme>;

/** One line per failure or skipped scheme for command-line tooling. */
export function formatThemeReport(report: ThemeReport): string {
  return (
    [
      ...report.failures.map(
        (f) =>
          `${f.scheme} ${f.variant.actions}/${f.variant.secondary}${f.active ? ' (active)' : ''} ${f.pair} on ${f.backdrop} (${f.state}): ${f.foreground.colour} on ${f.surface.colour}, ${f.ratio.toFixed(2)}:1 requires ${f.required}:1. Adjust ${f.adjust.join(', ')}.`,
      ),
      ...report.skipped.map(
        (s) =>
          `${s.scheme} ${s.variant.actions}/${s.variant.secondary} skipped: ${s.reason}`,
      ),
    ].join('\n') ||
    (report.pass ? 'Theme contrast passed.' : 'No theme samples checked.')
  );
}
