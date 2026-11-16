import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type TouchEvent,
} from 'react';
import {
  ComboBoxStateContext,
  Label,
  Text,
  useLocale,
} from 'react-aria-components';
import { cn } from 'cn';
import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '../components/combobox.js';
import { expectAriaCount } from './aria-count.js';
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
  /**
   * Whether `value` is a search the app runs (default true). False for text
   * the app treats otherwise, such as an exact address, an invalid one or
   * text too short to search: the suggestions stay closed (and close if
   * they are open), neither the arrow keys nor a touch open them, `items`,
   * `loading` and `failed` are ignored, and nothing is announced, also not
   * by React Aria. The same input stays
   * mounted with its focus, caret and input method composition, and Enter
   * submits the text (`onSubmit`).
   */
  readonly suggest?: boolean;
  /** The input element, for example to focus and select it on Ctrl/Cmd-K. */
  readonly ref?: Ref<HTMLInputElement>;
  readonly className?: string;
}

/** The suggestions while the field does not suggest: always the same. */
const none: readonly never[] = [];

/** What the field says about its suggestions, also to assistive technology. */
function statusText<T extends Suggestion>(
  t: AdapterTexts,
  { value, items, loading, failed, suggest = true }: SuggestFieldProps<T>,
): string {
  if (!suggest || value.trim() === '') return '';
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
 * is still running, that failed or found nothing, and React Aria's own
 * count of the options stays silent. With `suggest` false,
 * for an address or text too short to search, it is a plain text field
 * that submits with Enter, without suggestions or announcements.
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
    suggest = true,
    ref,
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
  // Suggestions show only for text the app searches.
  const typed = suggest && value.trim() !== '';
  const loading = suggest && props.loading;
  const failed = suggest ? props.failed : undefined;
  return (
    <Combobox
      data-slot="suggest-field"
      aria-label={labelHidden ? label : undefined}
      className={cn('grid min-w-0 gap-1.5', className)}
      inputValue={value}
      onInputChange={onChange}
      items={suggest ? items : none}
      // Suggestions are actions, not a selection the field keeps.
      selectedKey={null}
      allowsCustomValue
      // The suggestions open as soon as there is text, also while the first
      // results are still loading.
      allowsEmptyCollection={typed}
      menuTrigger="input"
    >
      {labelHidden ? null : <Label>{label}</Label>}
      <FollowSuggest suggest={suggest} />
      <QuietCount />
      <FieldKeys onSubmit={onSubmit} suggest={suggest}>
        <ComboboxInput
          ref={ref}
          placeholder={placeholder}
          showTrigger={false}
          enterKeyHint={onSubmit ? 'go' : 'search'}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          // The outline around the field is its one focus cue (styles.css).
          className="h-11 w-full has-[[data-slot=input-group-control]:focus-visible]:border-input has-[[data-slot=input-group-control]:focus-visible]:ring-0"
        />
      </FieldKeys>
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
        {items.length > 0 && (loading || failed) ? (
          <p
            aria-hidden="true"
            className="border-t px-3 py-2 text-xs text-muted-foreground"
          >
            {status}
          </p>
        ) : null}
      </ComboboxContent>
      {/* One polite announcement for every state, open or closed, and the
          only count (QuietCount). While the suggestions show, React Aria
          hides everything outside the field from assistive technology
          except live regions it marks with data-live-announcer, as its own
          announcer does. */}
      <span role="status" data-live-announcer="true" className="sr-only">
        {status}
      </span>
    </Combobox>
  );
}

/**
 * Closes the suggestions when the field stops suggesting, and opens them
 * when it starts to suggest for text that is already typed, for example
 * once the text becomes searchable, as typing it would have; the combo box
 * itself opens only when the text changes.
 *
 * The close comes in the same commit that empties `items`, before React
 * Aria's collection follows them one render later: otherwise the list
 * closes only once it is empty, and React Aria announces "0 options
 * available" while it is still open.
 */
function FollowSuggest({ suggest }: { readonly suggest: boolean }) {
  const state = useContext(ComboBoxStateContext);
  const before = useRef(suggest);
  useEffect(() => {
    const started = suggest && !before.current;
    before.current = suggest;
    if (!state) return;
    if (!suggest && state.isOpen) state.close();
    else if (started && !state.isOpen && state.isFocused)
      if (state.inputValue.trim() !== '') state.open(null, 'input');
  });
  return null;
}

/**
 * Keeps React Aria's count of the options ("0 options available." while the
 * first results load, "2 options available.") out of its announcer: in each
 * commit in which the list opens or the number of options changes while it
 * is open, it tells aria-count.ts the count React Aria announces in that
 * commit's effects, which run after this one's. The field's status says how
 * many there are; the active option's text, which React Aria announces for
 * VoiceOver, and other components' announcements still reach the announcer.
 */
function QuietCount() {
  const state = useContext(ComboBoxStateContext);
  const { locale } = useLocale();
  const open = state?.isOpen ?? false;
  const options = [...(state?.collection ?? [])].filter(
    (node) => node.type === 'item',
  );
  const before = useRef({ open, count: options.length });
  useEffect(() => {
    const last = before.current;
    before.current = { open, count: options.length };
    if (open && (!last.open || last.count !== options.length))
      expectAriaCount(options.length, locale);
  });
  return null;
}

/**
 * Submits the typed text on Enter when no suggestion is active, before the
 * combo box handles the key; never while an input method composes text.
 * While the field does not suggest, neither the arrow keys nor a touch on
 * the input's centre (an iPad's virtual click) open the suggestions.
 */
function FieldKeys({
  onSubmit,
  suggest,
  children,
}: {
  readonly onSubmit?: (value: string) => void;
  readonly suggest: boolean;
  readonly children: ReactNode;
}) {
  const state = useContext(ComboBoxStateContext);
  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!suggest && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      // The combo box would open its empty list for a moment.
      event.stopPropagation();
      return;
    }
    if (!onSubmit || !state || event.key !== 'Enter') return;
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const active = state.isOpen ? state.selectionManager.focusedKey : null;
    const text = state.inputValue.trim();
    if (active == null && text !== '') onSubmit(text);
  };
  const onTouchEndCapture = (event: TouchEvent<HTMLDivElement>) => {
    // React Aria would toggle the empty list and announce it; the touch
    // still focuses the input as on any text field.
    if (!suggest) event.stopPropagation();
  };
  return (
    <div
      className="contents"
      onKeyDownCapture={onKeyDownCapture}
      onTouchEndCapture={onTouchEndCapture}
    >
      {children}
    </div>
  );
}
