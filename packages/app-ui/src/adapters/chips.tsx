import type { ReactNode } from 'react';
import { CheckIcon } from 'lucide-react';
import {
  composeRenderProps,
  type ToggleButtonGroupProps,
  type ToggleButtonProps,
} from 'react-aria-components';
import { cn } from 'cn';
import { ToggleGroup, ToggleGroupItem } from '../components/toggle-group.js';

export interface ChipGroupProps extends Omit<
  ToggleButtonGroupProps,
  'className' | 'children' | 'orientation' | 'aria-label'
> {
  /** Names the group, for example "Filter". */
  readonly label: string;
  readonly className?: string;
  readonly children?: ReactNode;
}

/**
 * Filter chips: a labelled group of toggle chips that wraps on narrow
 * screens. `selectionMode` is React Aria's (`single` by default, or
 * `multiple`); `selectedKeys` and `onSelectionChange` hold the chips' `id`s.
 * Tab reaches the group once, arrow keys move between chips and Space or
 * Enter toggles one.
 */
export function ChipGroup({ label, className, ...props }: ChipGroupProps) {
  return (
    <ToggleGroup
      aria-label={label}
      className={cn('w-full flex-wrap', className)}
      {...props}
    />
  );
}

export interface ChipProps extends Omit<
  ToggleButtonProps,
  'className' | 'children'
> {
  /** Identifies the chip in its group's selection. */
  readonly id: string;
  readonly className?: string;
  readonly children?: ReactNode;
}

/**
 * One chip of a `ChipGroup`: 44px high, outlined at rest; selected, it is
 * filled and shows a check mark, so its state does not rest on colour alone.
 */
export function Chip({ className, children, ...props }: ChipProps) {
  return (
    <ToggleGroupItem
      variant="outline"
      // A chip is aria-pressed in a multiple selection and aria-checked (a
      // radio) in a single one; the registry's muted selection is replaced.
      className={cn(
        'h-11 min-w-11 gap-1.5 rounded-full px-4 text-sm aria-checked:border-primary aria-checked:bg-primary aria-checked:text-primary-foreground aria-checked:hover:bg-primary aria-checked:hover:text-primary-foreground aria-pressed:border-primary aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary aria-pressed:hover:text-primary-foreground',
        className,
      )}
      {...props}
    >
      {composeRenderProps(children, (children, { isSelected }) => (
        <>
          {isSelected && <CheckIcon aria-hidden="true" />}
          {children}
        </>
      ))}
    </ToggleGroupItem>
  );
}
