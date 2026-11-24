/**
 * The public runtime surface, as an explicit budget: any addition or removal
 * is an API decision and must update this list (and the package README).
 * Types are reviewed with the declarations.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';

it('exports the adapters, the router and the shadcn/ui components', async () => {
  expect(Object.keys(await import('./index.js')).sort()).toEqual([
    'ActionButton',
    'ActionGroup',
    'ActionLink',
    'Badge',
    'Button',
    'Calendar',
    'Checkbox',
    'Chip',
    'ChipGroup',
    'Combobox',
    'ComboboxCollection',
    'ComboboxContent',
    'ComboboxEmpty',
    'ComboboxGroup',
    'ComboboxInput',
    'ComboboxItem',
    'ComboboxLabel',
    'ComboboxList',
    'ComboboxSeparator',
    'ComboboxTrigger',
    'ContextSwitch',
    'DateChoice',
    'DateChooser',
    'DeleteIcon',
    'Dialog',
    'DialogClose',
    'DialogDescription',
    'DialogFooter',
    'DialogHeader',
    'DialogOverlay',
    'DialogTitle',
    'DialogTrigger',
    'DropdownMenu',
    'DropdownMenuGroup',
    'DropdownMenuItem',
    'DropdownMenuLabel',
    'DropdownMenuSeparator',
    'DropdownMenuShortcut',
    'DropdownMenuSub',
    'DropdownMenuSubContent',
    'DropdownMenuSubTrigger',
    'DropdownMenuTrigger',
    'HeaderMenu',
    'I18nProvider',
    'InlineTextEdit',
    'Input',
    'InputGroup',
    'InputGroupAddon',
    'InputGroupButton',
    'InputGroupInput',
    'InputGroupText',
    'InputGroupTextarea',
    'LinkButton',
    'Popover',
    'PopoverDescription',
    'PopoverHeader',
    'PopoverTitle',
    'PopoverTrigger',
    'RangeCalendar',
    'ScreenDialog',
    'Select',
    'SelectContent',
    'SelectEmpty',
    'SelectGroup',
    'SelectInput',
    'SelectItem',
    'SelectLabel',
    'SelectList',
    'SelectPopover',
    'SelectSeparator',
    'SelectTrigger',
    'SelectValue',
    'SuggestField',
    'Textarea',
    'Toggle',
    'ToggleGroup',
    'ToggleGroupItem',
    'WorkspacePanel',
    'badgeVariants',
    'buttonVariants',
    'replaceUrl',
    'toggleVariants',
    'useComboboxAnchor',
    'useNav',
  ]);
});

it('exports the Markdown view and field from their own entry', async () => {
  expect(Object.keys(await import('./markdown/index.js')).sort()).toEqual([
    'MarkdownField',
    'MarkdownView',
  ]);
});

it('keeps the optional react-markdown out of the root entry', () => {
  // Every module the root entry reaches through relative imports.
  const seen = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const code = readFileSync(file, 'utf8');
    for (const [, target] of code.matchAll(/from '([^']+)'/g)) {
      if (!target!.startsWith('.')) {
        packages.add(target!);
        continue;
      }
      const base = join(dirname(file), target!.replace(/\.js$/, ''));
      visit(existsSync(base + '.tsx') ? base + '.tsx' : base + '.ts');
    }
  };
  visit(join(import.meta.dirname, 'index.ts'));
  expect(packages.has('react-markdown')).toBe(false);
  expect([...seen].some((file) => file.includes('/markdown/'))).toBe(false);
  expect(packages.has('react-aria-components')).toBe(true);
});
