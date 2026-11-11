import type { ReactNode, Ref } from 'react';
import { Text } from 'react-aria-components';
import { EllipsisIcon, MenuIcon } from 'lucide-react';
import { Button } from '../components/button.js';
import {
  DropdownMenu,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../components/dropdown-menu.js';
import { useAdapterTexts } from './texts.js';

/** One choice of a group; exactly one of them is usually `checked`. */
export interface HeaderMenuChoice {
  /** Tells choices apart; defaults to `label`, so give one when labels repeat. */
  readonly id?: string;
  readonly label: string;
  readonly checked: boolean;
  readonly onSelect: () => void;
  /**
   * A second line below the label, such as the access to a list ("Can
   * read"). It describes the choice; `label` stays its name.
   */
  readonly description?: string;
  /**
   * Shown but not available: neither a press nor the keyboard reaches it,
   * and arrow keys skip it. A checked choice stays checked.
   */
  readonly disabled?: boolean;
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
  /** Shown but not available, as a disabled choice. */
  readonly disabled?: boolean;
}

/** A group of checked choices, as a submenu or as a section of the menu. */
export interface HeaderMenuChoices {
  readonly label: string;
  readonly choices: readonly HeaderMenuChoice[];
  /**
   * `submenu` (the default) opens the choices beside the menu; `section`
   * lists them in the menu under `label` as a heading, so two or three
   * choices show the current one at once, without a second layer on a phone.
   */
  readonly display?: 'submenu' | 'section';
  /** Groups take no icon; they line up with the actions' labels. */
  readonly icon?: never;
}

/** An action, a group of checked choices, or `null` for a separator. */
export type HeaderMenuEntry = HeaderMenuAction | HeaderMenuChoices | null;

export interface HeaderMenuProps {
  /** Names the icon button; defaults to "Menu". */
  readonly label?: string;
  readonly items: readonly HeaderMenuEntry[];
  /** `menu` (three lines) for a screen, `more` (three dots) for an item. */
  readonly icon?: 'menu' | 'more';
  /**
   * `secondary` (the default) fills the round button, for a screen's heading;
   * `ghost` shows only the icon until it is hovered, pressed or open, for
   * menus repeated on rows. Both keep the 44px target.
   */
  readonly variant?: 'secondary' | 'ghost';
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
 * decorative `icon`; choices show as a submenu or a section, with an optional
 * description, and actions and choices can be disabled. `ref` reaches the
 * button, for example as `AppAccess`'s `focusTarget`.
 */
export function HeaderMenu({
  label,
  items,
  icon = 'menu',
  variant = 'secondary',
  ref,
}: HeaderMenuProps) {
  const t = useAdapterTexts();
  // With an icon on any action, every row gets the icon's box, filled or
  // empty, so the labels share one column in both reading directions.
  const icons = items.some(
    (item) => item !== null && !('choices' in item) && Boolean(item.icon),
  );
  const choiceId = (choice: HeaderMenuChoice) => choice.id ?? choice.label;
  const selected = (group: HeaderMenuChoices) =>
    group.choices.filter((choice) => choice.checked).map(choiceId);
  // A choice with a description names itself by its label alone; the
  // description becomes its accessible description. In a section, choices
  // keep the actions' icon column.
  const choice = (choice: HeaderMenuChoice, inMenu: boolean) => (
    <DropdownMenuItem
      key={choiceId(choice)}
      id={choiceId(choice)}
      className="min-h-11"
      textValue={choice.label}
      onAction={choice.onSelect}
      isDisabled={choice.disabled}
    >
      {inMenu && lead()}
      {choice.description === undefined ? (
        choice.label
      ) : (
        <span className="grid min-w-0">
          <Text slot="label" className="wrap-anywhere">
            {choice.label}
          </Text>
          <Text
            slot="description"
            className="text-xs text-muted-foreground wrap-anywhere"
          >
            {choice.description}
          </Text>
        </span>
      )}
    </DropdownMenuItem>
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
        variant={variant}
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
          ) : 'choices' in item && item.display === 'section' ? (
            <DropdownMenuGroup
              key={i}
              selectionMode="single"
              selectedKeys={selected(item)}
            >
              <DropdownMenuLabel>{item.label}</DropdownMenuLabel>
              {item.choices.map((c) => choice(c, true))}
            </DropdownMenuGroup>
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
                selectedKeys={selected(item)}
              >
                {item.choices.map((c) => choice(c, false))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : (
            <DropdownMenuItem
              key={i}
              className="min-h-11"
              textValue={item.label}
              onAction={item.onSelect}
              isDisabled={item.disabled}
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
