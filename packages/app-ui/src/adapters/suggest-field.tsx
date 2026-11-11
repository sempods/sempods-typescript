import {
  useContext,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { ComboBoxStateContext, Label, Text } from 'react-aria-components';
import { cn } from 'cn';
import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '../components/combobox.js';
import { useAdapterTexts, type AdapterTexts } from './texts.js';

/** One suggestion: what it is called, its exact value and where it is from. */
export interface Suggestion {
  /**
   * Its identity while results arrive, change and reorder, for example the
   * resource's IRI; the keyboard's active suggestion follows it.
   */
  readonly id: string;
  /** Shown on up to two lines; it names the suggestion and leads typeahead. */
  readonly label: string;
  /** The exact value, such as an IRI: one line, cut off visually only. */
  readonly detail?: string;
  /** Where it was found, in a few words, such as a Pod's name. */
  readonly source?: string;
}

export interface SuggestFieldProps<T extends Suggestion> {
  /** Names the field; with `labelHidden`, for assistive technology only. */
  readonly label: string;
  readonly labelHidden?: boolean;
  readonly placeholder?: string;
  /** The typed text, controlled: the app's search runs on it. */
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** The suggestions for `value`, in the order to show them. */
  readonly items: readonly T[];
  /** The app's search for `value` has not settled. */
  readonly loading?: boolean;
  /**
   * Searches that failed: `some` of the sources (the others' suggestions
   * show), or `all` of them.
   */
  readonly failed?: 'some' | 'all';
  /** A suggestion was chosen with Enter or a press. */
  readonly onSelect: (item: T) => void;
  /**
   * Enter (or a phone's Go) with no suggestion active submits the text as
   * typed, for example an address to open. Without it Enter only closes the
   * suggestions.
   */
  readonly onSubmit?: (value: string) => void;
  readonly className?: string;
}

/** What the field says about its suggestions, also to assistive technology. */
function statusText<T extends Suggestion>(
  t: AdapterTexts,
  { value, items, loading, failed }: SuggestFieldProps<T>,
): string {
  if (value.trim() === '') return '';
  if (failed === 'all') return t.searchFailed;
  const partial = failed === 'some' ? ` ${t.searchPartial}` : '';
  if (items.length === 0)
    return loading ? t.searching : t.noSuggestions + partial;
  const count = (items.length === 1 ? t.oneSuggestion : t.suggestions).replace(
    '{count}',
    String(items.length),
  );
  return (loading ? `${count} ${t.searchingMore}` : count) + partial;
}

/**
 * A text field with asynchronous suggestions, such as a search or address
 * bar, on React Aria's combo box: the input keeps the focus, arrow keys move
 * through the suggestions (`aria-activedescendant`), Enter or a press
 * chooses one, Escape closes them. The app searches: it passes the
 * suggestions for `value` with `loading` and `failed`, and cancels a search
 * whose text has changed. The field announces their number, a search that
 * is still running, that failed or found nothing.
 */
export function SuggestField<T extends Suggestion>(
  props: SuggestFieldProps<T>,
) {
  const {
    label,
    labelHidden = false,
    placeholder,
    value,
    onChange,
    items,
    onSelect,
    onSubmit,
    className,
  } = props;
  const t = useAdapterTexts();
  // React Aria keeps rendered suggestions while their objects stay the same,
  // so a choice calls the latest onSelect through this reference, not the
  // one of the render that first showed the suggestion.
  const select = useRef(onSelect);
  useLayoutEffect(() => {
    select.current = onSelect;
  });
  const status = statusText(t, props);
  const typed = value.trim() !== '';
  return (
    <Combobox
      data-slot="suggest-field"
      aria-label={labelHidden ? label : undefined}
      className={cn('grid min-w-0 gap-1.5', className)}
      inputValue={value}
      onInputChange={onChange}
      items={items}
      // Suggestions are actions, not a selection the field keeps.
      selectedKey={null}
      allowsCustomValue
      // The suggestions open as soon as there is text, also while the first
      // results are still loading.
      allowsEmptyCollection={typed}
      menuTrigger="input"
    >
      {labelHidden ? null : <Label>{label}</Label>}
      <SubmitOnEnter onSubmit={onSubmit}>
        <ComboboxInput
          placeholder={placeholder}
          showTrigger={false}
          enterKeyHint={onSubmit ? 'go' : 'search'}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          // The outline around the field is its one focus cue (styles.css).
          className="h-11 w-full has-[[data-slot=input-group-control]:focus-visible]:border-input has-[[data-slot=input-group-control]:focus-visible]:ring-0"
        />
      </SubmitOnEnter>
      <ComboboxContent placement="bottom start" offset={4}>
        <ComboboxList<T>
          renderEmptyState={() =>
            typed ? (
              <p
                aria-hidden="true"
                className="px-3 py-3 text-sm text-muted-foreground"
              >
                {status}
              </p>
            ) : null
          }
        >
          {(item) => (
            <ComboboxItem
              id={item.id}
              textValue={item.label}
              onAction={() => select.current(item)}
              className="grid min-h-11 gap-0.5 py-1.5 pr-2"
            >
              <Text slot="label" className="line-clamp-2 wrap-anywhere">
                {item.label}
              </Text>
              {item.detail || item.source ? (
                <Text
                  slot="description"
                  className="flex min-w-0 gap-2 text-xs text-muted-foreground"
                >
                  {item.detail ? (
                    <span className="min-w-0 flex-1 truncate">
                      {item.detail}
                    </span>
                  ) : null}
                  {item.source ? (
                    <span className="max-w-[40%] shrink-0 truncate">
                      {item.source}
                    </span>
                  ) : null}
                </Text>
              ) : null}
            </ComboboxItem>
          )}
        </ComboboxList>
        {items.length > 0 && (props.loading || props.failed) ? (
          <p
            aria-hidden="true"
            className="border-t px-3 py-2 text-xs text-muted-foreground"
          >
            {status}
          </p>
        ) : null}
      </ComboboxContent>
      {/* One polite announcement for every state, open or closed. While the
          suggestions show, React Aria hides everything outside the field
          from assistive technology except live regions it marks with
          data-live-announcer, as its own announcer does. */}
      <span role="status" data-live-announcer="true" className="sr-only">
        {status}
      </span>
    </Combobox>
  );
}

/**
 * Submits the typed text on Enter when no suggestion is active, before the
 * combo box handles the key; never while an input method composes text.
 */
function SubmitOnEnter({
  onSubmit,
  children,
}: {
  readonly onSubmit?: (value: string) => void;
  readonly children: ReactNode;
}) {
  const state = useContext(ComboBoxStateContext);
  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!onSubmit || !state || event.key !== 'Enter') return;
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const active = state.isOpen ? state.selectionManager.focusedKey : null;
    const text = state.inputValue.trim();
    if (active == null && text !== '') onSubmit(text);
  };
  return (
    <div className="contents" onKeyDownCapture={onKeyDownCapture}>
      {children}
    </div>
  );
}
