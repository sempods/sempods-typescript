// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SdkLocaleProvider, useSdkLocale } from './index.js';

afterEach(cleanup);
it('retranslates without replacing a child draft', () => {
  function Content() {
    const [draft, setDraft] = useState('');
    const { messages, format } = useSdkLocale();
    return (
      <>
        <input
          aria-label="draft"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <p>{messages.reviewAccess}</p>
        <p>{format.number(1234.5)}</p>
      </>
    );
  }
  const view = render(
    <SdkLocaleProvider locale="en-US">
      <Content />
    </SdkLocaleProvider>,
  );
  fireEvent.change(screen.getByLabelText('draft'), {
    target: { value: 'Unfinished' },
  });
  view.rerender(
    <SdkLocaleProvider locale="de-CH">
      <Content />
    </SdkLocaleProvider>,
  );
  expect(screen.getByDisplayValue('Unfinished')).toBeTruthy();
  expect(screen.getByText('Zugriff prüfen')).toBeTruthy();
  expect(screen.getByText(/^1['’]234\.5$/)).toBeTruthy();
});

function Shown() {
  const { locale, language, messages } = useSdkLocale();
  return (
    <p>
      {locale} {language} {messages.reviewAccess}
    </p>
  );
}
function shownWith(
  languages: readonly string[] | undefined,
  props: Parameters<typeof SdkLocaleProvider>[0] extends infer P
    ? Omit<P, 'children'>
    : never = {},
) {
  vi.unstubAllGlobals();
  if (languages === undefined) vi.stubGlobal('navigator', undefined);
  else
    vi.stubGlobal('navigator', {
      languages,
      language: languages[0] ?? '',
    });
  const view = render(
    <SdkLocaleProvider {...props}>
      <Shown />
    </SdkLocaleProvider>,
  );
  const text = view.container.textContent;
  view.unmount();
  vi.unstubAllGlobals();
  return text;
}

it('follows the browser languages when no locale or language is given', () => {
  expect(shownWith(['de-DE'])).toBe('de-DE de Zugriff prüfen');
  expect(shownWith(['en-GB'])).toBe('en-GB en Review access');
  expect(shownWith(['fr-CA', 'de-AT'])).toBe('de-AT de Zugriff prüfen');
  expect(shownWith([])).toBe('en en Review access');
  expect(shownWith(['bad_tag'])).toBe('en en Review access');
  expect(shownWith(undefined)).toBe('en en Review access');
});

it('keeps explicit locale, language and messages ahead of the browser', () => {
  expect(shownWith(['de-DE'], { locale: 'en', language: 'en' })).toBe(
    'en en Review access',
  );
  // A language alone keeps the default formatting locale.
  expect(shownWith(['de-DE'], { language: 'en' })).toBe('en en Review access');
  // A locale alone also chooses the language, as before.
  expect(shownWith(['de-DE'], { locale: 'en-US' })).toBe(
    'en-US en Review access',
  );
  expect(shownWith(['en-US'], { locale: 'en-GB', language: 'de' })).toBe(
    'en-GB de Zugriff prüfen',
  );
  expect(
    shownWith(['de-DE'], { messages: { reviewAccess: 'Freigabe ansehen' } }),
  ).toBe('de-DE de Freigabe ansehen');
});

it('reads the browser languages once for the provider lifetime', () => {
  let reads = 0;
  vi.stubGlobal('navigator', {
    get languages() {
      reads += 1;
      return ['de-DE'];
    },
  });
  const view = render(
    <SdkLocaleProvider>
      <Shown />
    </SdkLocaleProvider>,
  );
  view.rerender(
    <SdkLocaleProvider timeZone="Europe/Berlin">
      <Shown />
    </SdkLocaleProvider>,
  );
  expect(screen.getByText('de-DE de Zugriff prüfen')).toBeTruthy();
  expect(reads).toBe(1);
  view.unmount();
  vi.unstubAllGlobals();
});
