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

/** An action, a submenu of checked choices, or `null` for a separator. */
export type HeaderMenuEntry =
  | { readonly label: string; readonly onSelect: () => void }
  | { readonly label: string; readonly choices: readonly HeaderMenuChoice[] }
  | null;

export interface HeaderMenuProps {
  /** Names the icon button; defaults to "Menu". */
  readonly label?: string;
  readonly items: readonly HeaderMenuEntry[];
  /** `menu` (three lines) for a screen, `more` (three dots) for an item. */
  readonly icon?: 'menu' | 'more';
}

/**
 * A round icon button with a menu: Enter or a press opens it, arrow keys move,
 * ArrowRight opens a submenu and ArrowLeft returns, Escape closes one level and
 * focus returns to the button. Items are 44px high.
 */
export function HeaderMenu({ label, items, icon = 'menu' }: HeaderMenuProps) {
  const t = useAdapterTexts();
  return (
    <DropdownMenuTrigger>
      <Button
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
              <DropdownMenuSubTrigger className="min-h-11">
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
              onAction={item.onSelect}
            >
              {item.label}
            </DropdownMenuItem>
          ),
        )}
      </DropdownMenu>
    </DropdownMenuTrigger>
  );
}
