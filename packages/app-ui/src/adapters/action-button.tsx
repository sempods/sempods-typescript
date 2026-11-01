import type { ButtonProps } from 'react-aria-components';
import { cn } from 'cn';
import { Button } from '../components/button.js';

const variants = {
  primary: 'default',
  secondary: 'secondary',
  ghost: 'ghost',
  destructive: 'destructive',
} as const;

const shapes = {
  pill: 'h-14 rounded-full px-6 text-base',
  round: 'size-14 rounded-full [&_svg:not([class*=size-])]:size-5',
  'round-lg': 'size-18 rounded-full [&_svg:not([class*=size-])]:size-7',
} as const;

export interface ActionButtonProps extends Omit<
  ButtonProps,
  'className' | 'aria-label'
> {
  /**
   * `primary` and `secondary` follow the theme's action variants
   * (`data-actions`, `data-secondary`); `ghost` and `destructive` do not.
   */
  readonly variant?: keyof typeof variants;
  /** `pill` (56px high, text), `round` (56px) or `round-lg` (72px) for icons. */
  readonly shape?: keyof typeof shapes;
  /** The accessible name; required when the button shows only an icon. */
  readonly label?: string;
  readonly className?: string;
}

/** An app's own action: a large pressable target in the theme's variants. */
export function ActionButton({
  variant = 'primary',
  shape = 'pill',
  label,
  className,
  ...props
}: ActionButtonProps) {
  return (
    <Button
      variant={variants[variant]}
      className={cn(shapes[shape], className)}
      aria-label={label}
      {...props}
    />
  );
}
