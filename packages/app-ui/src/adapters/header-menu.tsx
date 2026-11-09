import type { ReactNode, Ref } from 'react';
import { EllipsisIcon, MenuIcon } from 'lucide-react';
import { Button } from '../components/button.js';
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../components/dropdown-menu.js';
import { useAdapterTexts } from './texts.js';

/** One choice of a submenu; exactly one of them is usually `checked`. */
export interface HeaderMenuChoice {
  /** Tells choices apart; defaults to `label`, so give one when labels repeat. */
  readonly id?: string;
  readonly label: string;
  readonly checked: boolean;
  readonly onSelect: () => void;
}

/** An action: its label names it and leads typeahead. */
export interface HeaderMenuAction {
  readonly label: string;
  readonly onSelect: () => void;
  /**
   * A decorative leading icon, such as a lucide icon without a size of its
   * own: it is shown in a 16px box and hidden from assistive technology, so
   * `label` stays the whole accessible name. When an action has one, the other
   * rows of the menu keep an empty box, so all labels start in one column, in
   * either reading direction.
   */
  readonly icon?: ReactNode;
}

/** An action, a submenu of checked choices, or `null` for a separator. */
export type HeaderMenuEntry =
  | HeaderMenuAction
  | {
      readonly label: string;
      readonly choices: readonly HeaderMenuChoice[];
      /** Submenus take no icon; they line up with the actions' labels. */
      readonly icon?: never;
    }
  | null;

export interface HeaderMenuProps {
  /** Names the icon button; defaults to "Menu". */
  readonly label?: string;
  readonly items: readonly HeaderMenuEntry[];
  /** `menu` (three lines) for a screen, `more` (three dots) for an item. */
  readonly icon?: 'menu' | 'more';
  /**
   * The menu's button. Pass the same ref as `focusTarget` to a surface the menu
   * opens, such as `AppAccess` for Pods & sharing: the chosen item is gone by
   * the time that surface closes, so focus needs the button to return to.
   */
  readonly ref?: Ref<HTMLButtonElement>;
}

/**
 * A round icon button with a menu: Enter or a press opens it, arrow keys move,
 * ArrowRight opens a submenu and ArrowLeft returns, Escape closes one level and
 * focus returns to the button. Items are 44px high. An action can lead with a
 * decorative `icon`. `ref` reaches the button, for example as `AppAccess`'s
 * `focusTarget`.
 */
export function HeaderMenu({
  label,
  items,
  icon = 'menu',
  ref,
}: HeaderMenuProps) {
  const t = useAdapterTexts();
  // With an icon on any action, every row gets the icon's box, filled or
  // empty, so the labels share one column in both reading directions.
  const icons = items.some(
    (item) => item !== null && !('choices' in item) && Boolean(item.icon),
  );
  const lead = (icon?: ReactNode) =>
    icons ? (
      <span
        aria-hidden="true"
        className="flex size-4 shrink-0 items-center justify-center overflow-hidden"
      >
        {icon}
      </span>
    ) : null;
  return (
    <DropdownMenuTrigger>
      <Button
        ref={ref}
        variant="secondary"
        size="icon-lg"
        className="size-11 rounded-full"
        aria-label={label ?? t.menu}
      >
        {icon === 'menu' ? <MenuIcon /> : <EllipsisIcon />}
      </Button>
      <DropdownMenu placement="bottom end" className="min-w-48">
        {items.map((item, i) =>
          item === null ? (
            <DropdownMenuSeparator key={i} />
          ) : 'choices' in item ? (
            <DropdownMenuSub key={i}>
              <DropdownMenuSubTrigger
                className="min-h-11"
                textValue={item.label}
              >
                {lead()}
                {item.label}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent
                selectionMode="single"
                selectedKeys={item.choices
                  .filter((choice) => choice.checked)
                  .map((choice) => choice.id ?? choice.label)}
              >
                {item.choices.map((choice) => (
                  <DropdownMenuItem
                    key={choice.id ?? choice.label}
                    id={choice.id ?? choice.label}
                    className="min-h-11"
                    onAction={choice.onSelect}
                  >
                    {choice.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : (
            <DropdownMenuItem
              key={i}
              className="min-h-11"
              textValue={item.label}
              onAction={item.onSelect}
            >
              {lead(item.icon)}
              {item.label}
            </DropdownMenuItem>
          ),
        )}
      </DropdownMenu>
    </DropdownMenuTrigger>
  );
}
