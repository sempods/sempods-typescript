export const actions = ['solid', 'inverted'] as const;
export const secondaries = ['tonal', 'outline', 'text'] as const;
export const schemes = ['light', 'dark'] as const;
export type Scheme = (typeof schemes)[number];
export interface Variant {
  actions: (typeof actions)[number];
  secondary: (typeof secondaries)[number];
}

const surfaces = ['background', 'card', 'popover'] as const;
type Surface = (typeof surfaces)[number];

/** Each entry checks one foreground against its painted surface on each backdrop. */
export interface ThemePair {
  name: string;
  variant: 'all' | Variant[keyof Variant];
  foreground: string;
  surface: string;
  backdrops: readonly Surface[];
  state: 'rest' | 'hover';
  required: number;
}

function pair(
  name: string,
  foreground: string,
  surface: string,
  options: Partial<Omit<ThemePair, 'name' | 'foreground' | 'surface'>> = {},
): ThemePair {
  return {
    name,
    foreground,
    surface,
    variant: 'all',
    backdrops: ['background'],
    state: 'rest',
    required: 4.5,
    ...options,
  };
}

/** Contrast contract for the package palette and action variants. Derived surfaces
 * are resolved by the browser alongside the palette and component roles. */
export const themePairs: readonly ThemePair[] = [
  ...['background', 'card', 'popover', 'accent'].map((surface) =>
    pair(
      surface + ' text',
      surface === 'background' ? 'foreground' : surface + '-foreground',
      surface,
    ),
  ),
  ...['background', 'muted', 'card', 'popover'].map((surface) =>
    pair('muted text on ' + surface, 'muted-foreground', surface),
  ),
  pair('selected day', 'primary-foreground', 'primary'),
  pair('destructive action', 'destructive', 'destructive-tint'),
  pair('destructive action', 'destructive', 'destructive-hover', {
    state: 'hover',
  }),
  ...['input', 'ring'].flatMap((role) =>
    surfaces.map((surface) =>
      pair(role + ' on ' + surface, role, surface, { required: 3 }),
    ),
  ),
  ...[...actions, ...secondaries].flatMap((variant) => {
    const primary = variant === 'solid' || variant === 'inverted';
    const role = primary ? 'action' : 'action-secondary';
    const name = primary ? 'primary action text' : 'secondary action text';
    const backdrops =
      variant === 'outline' || variant === 'text'
        ? surfaces
        : (['background'] as const);
    return [
      pair(name, role + '-foreground', role, { variant, backdrops }),
      pair(name, role + '-foreground', role + '-hover', {
        variant,
        backdrops,
        state: 'hover',
      }),
      ...(variant === 'outline'
        ? [
            pair(
              'secondary action boundary',
              'action-secondary-border',
              'transparent',
              { variant, backdrops, required: 3 },
            ),
          ]
        : []),
    ];
  }),
];

export function actionMapping({
  actions,
  secondary,
}: Variant): Record<string, string> {
  return {
    action: actions === 'solid' ? 'primary' : 'background',
    'action-foreground': actions === 'solid' ? 'primary-foreground' : 'primary',
    'action-border': 'primary',
    'action-secondary': secondary === 'tonal' ? 'secondary' : 'transparent',
    'action-secondary-foreground': {
      tonal: 'secondary-foreground',
      outline: 'foreground',
      text: 'primary',
    }[secondary],
    'action-secondary-border':
      secondary === 'outline' ? 'input' : 'transparent',
  };
}

export const derivedFrom: Record<string, readonly string[]> = {
  'action-hover': ['action', 'action-foreground'],
  'action-secondary-hover': ['action-secondary', 'action-secondary-foreground'],
  'destructive-tint': ['destructive'],
  'destructive-hover': ['destructive'],
};
