import type { ComponentProps, ReactNode } from 'react';
import type { ButtonProps } from 'react-aria-components';
import { cn } from 'cn';
import { Button, buttonVariants } from '../components/button.js';

const variants = {
  primary: 'default',
  secondary: 'secondary',
  ghost: 'ghost',
  destructive: 'destructive',
} as const;

const shapes = {
  pill: 'h-14 rounded-full px-6 text-base',
  'round-sm': 'size-11 rounded-full',
  round: 'size-14 rounded-full [&_svg:not([class*=size-])]:size-5',
  'round-lg': 'size-18 rounded-full [&_svg:not([class*=size-])]:size-7',
} as const;

interface ActionLook {
  /**
   * `primary` and `secondary` follow the theme's action variants
   * (`data-actions`, `data-secondary`); `ghost` and `destructive` do not.
   */
  readonly variant?: keyof typeof variants;
  /**
   * `pill` (56px high, text), or for icons `round-sm` (44px, as
   * `HeaderMenu`'s button, for a heading), `round` (56px) or `round-lg`
   * (72px).
   */
  readonly shape?: keyof typeof shapes;
  /** The accessible name; required when the action shows only an icon. */
  readonly label?: string;
  readonly className?: string;
}

export interface ActionButtonProps
  extends Omit<ButtonProps, 'className' | 'aria-label'>, ActionLook {}

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
      data-shape={shape}
      className={cn(shapes[shape], className)}
      aria-label={label}
      {...props}
    />
  );
}

export interface ActionLinkProps
  extends Omit<ComponentProps<'a'>, 'className' | 'aria-label'>, ActionLook {}

/**
 * An action that is a real link, for example `{...nav.link(place)}`: it can
 * be opened in a new tab or copied. Looks like `ActionButton`.
 */
export function ActionLink({
  variant = 'primary',
  shape = 'pill',
  label,
  className,
  ...props
}: ActionLinkProps) {
  return (
    <a
      data-slot="button"
      data-variant={variants[variant]}
      data-shape={shape}
      className={cn(
        buttonVariants({ variant: variants[variant] }),
        shapes[shape],
        className,
      )}
      aria-label={label}
      {...props}
    />
  );
}

export interface ActionGroupProps {
  /** Names the group, for example "Task actions". */
  readonly label: string;
  readonly className?: string;
  readonly children?: ReactNode;
}

/**
 * A row of actions: the full width on phones, at most 26rem wide and
 * centred above. `pill` actions share the free width, round ones keep their
 * size. Each action stays its own Tab stop. A main action usually stands
 * alone above the group.
 */
export function ActionGroup({ label, className, children }: ActionGroupProps) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        'mx-auto flex w-full max-w-[26rem] items-center justify-center gap-3 *:data-[shape=pill]:min-w-0 *:data-[shape=pill]:flex-1',
        className,
      )}
    >
      {children}
    </div>
  );
}
