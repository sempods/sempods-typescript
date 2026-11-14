import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useSdkLocale } from './locale.js';

interface Choice {
  readonly key: string;
  readonly url: string;
  readonly label: string;
}
/** Presentation only; selected keys are connection identities, never display names. */
export function PodAddressField({
  value,
  choices,
  selectedKey,
  editable,
  disabled,
  hiddenAddress,
  onChange,
  onChoose,
  children,
  descriptionId,
}: {
  readonly value: string;
  readonly choices: readonly Choice[];
  readonly selectedKey?: string | undefined;
  readonly editable: boolean;
  readonly disabled: boolean;
  readonly hiddenAddress: boolean;
  readonly onChange: (value: string) => void;
  readonly onChoose: (key: string) => void;
  readonly children?: ReactNode;
  readonly descriptionId?: string | undefined;
}) {
  const { messages: m } = useSdkLocale();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const visible = choices.filter(
    (c) =>
      !filter ||
      `${c.label} ${c.url}`
        .toLocaleLowerCase()
        .includes(value.toLocaleLowerCase()),
  );
  const selected = choices.find((c) => c.key === selectedKey);
  const expanded = open;
  const activeIndex = visible.findIndex((c) => c.key === active);
  useEffect(() => {
    if (active)
      list.current
        ?.querySelector('[data-active]')
        ?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);
  const label = hiddenAddress ? (selected?.label ?? '') : value;
  const close = () => {
    setOpen(false);
    setActive(null);
  };
  const choose = (key: string) => {
    onChoose(key);
    close();
    input.current?.focus();
  };
  if (hiddenAddress && choices.length === 1)
    return (
      <>
        {selected?.label && <p>{selected.label}</p>}
        {children}
      </>
    );
  return (
    <div
      className="sp-pod-field"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && expanded) {
          event.preventDefault();
          event.stopPropagation();
          close();
          input.current?.focus();
        }
      }}
      onBlur={(event) => {
        if (!disabled && !event.currentTarget.contains(event.relatedTarget))
          close();
      }}
    >
      <label htmlFor={id}>{m.controls.yourPod}</label>
      <div className="sp-pod-input">
        <input
          ref={input}
          id={id}
          role="combobox"
          type="text"
          inputMode="url"
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          aria-describedby={descriptionId}
          aria-autocomplete={editable ? 'list' : 'none'}
          aria-expanded={expanded}
          aria-controls={`${id}-choices`}
          aria-activedescendant={
            expanded && activeIndex >= 0 ? `${id}-${activeIndex}` : undefined
          }
          readOnly={!editable || hiddenAddress}
          disabled={disabled}
          value={label}
          placeholder={m.controls.podPlaceholder}
          onChange={(event) => {
            onChange(event.target.value);
            setFilter(true);
            setOpen(choices.length > 0);
            setActive(null);
          }}
          onClick={() => {
            if (!editable) {
              setFilter(false);
              setOpen(true);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && expanded) {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
            if (
              choices.length > 0 &&
              (event.key === 'ArrowDown' || event.key === 'ArrowUp')
            ) {
              event.preventDefault();
              if (!expanded) {
                setFilter(false);
                setOpen(true);
                setActive(
                  choices[event.key === 'ArrowDown' ? 0 : choices.length - 1]
                    ?.key ?? null,
                );
              } else if (visible.length)
                setActive(
                  visible[
                    activeIndex < 0
                      ? event.key === 'ArrowDown'
                        ? 0
                        : visible.length - 1
                      : (activeIndex +
                          (event.key === 'ArrowDown' ? 1 : -1) +
                          visible.length) %
                        visible.length
                  ]!.key,
                );
            }
            if (event.key === 'Enter' && expanded && activeIndex >= 0) {
              event.preventDefault();
              choose(visible[activeIndex]!.key);
            }
          }}
        />
        {editable && value && (
          <button
            type="button"
            className="sp-pod-icon"
            disabled={disabled}
            aria-label={m.controls.clearPodAddress}
            onClick={() => {
              onChange('');
              setFilter(false);
              close();
              input.current?.focus();
            }}
          >
            ×
          </button>
        )}
        {choices.length > 0 && (
          <button
            type="button"
            className="sp-pod-icon"
            disabled={disabled}
            aria-label={m.controls.choosePod}
            aria-expanded={expanded}
            aria-controls={`${id}-choices`}
            onClick={() => {
              setFilter(false);
              setOpen(!expanded);
              setActive(null);
              input.current?.focus();
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m7 10 5 5 5-5" />
            </svg>
          </button>
        )}
      </div>
      {expanded && (
        <div className="sp-pod-popover">
          <div
            ref={list}
            id={`${id}-choices`}
            role="listbox"
            aria-label={m.controls.choosePod}
          >
            {visible.map((choice, index) => (
              <button
                type="button"
                role="option"
                tabIndex={-1}
                id={`${id}-${index}`}
                key={choice.key}
                aria-selected={choice.key === selectedKey}
                disabled={disabled}
                data-active={choice.key === active || undefined}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(choice.key)}
              >
                <span>{choice.label}</span>
                {!hiddenAddress &&
                  !choice.label.includes(choice.url) &&
                  choice.label !== choice.url.replace(/^https?:\/\//, '') && (
                    <span className="sp-access-address">{choice.url}</span>
                  )}
              </button>
            ))}
          </div>
          {children}
        </div>
      )}
    </div>
  );
}
