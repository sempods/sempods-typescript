// @vitest-environment jsdom
/** `useMessages` picks the app's texts for the provider's language. */
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SdkLocaleProvider, useMessages } from './index.js';

afterEach(cleanup);
const text = {
  en: { add: 'Add', count: (n: number) => `${n} tasks` },
  de: { add: 'Hinzufügen', count: (n: number) => `${n} Aufgaben` },
};
function Texts() {
  const m = useMessages(text);
  return (
    <p>
      {m.add} · {m.count(2)}
    </p>
  );
}

it.each([
  ['en', 'Add · 2 tasks'],
  ['de', 'Hinzufügen · 2 Aufgaben'],
] as const)('uses the provider language (%s)', (language, shown) => {
  render(
    <SdkLocaleProvider language={language}>
      <Texts />
    </SdkLocaleProvider>,
  );
  expect(screen.getByText(shown)).toBeTruthy();
});

it('falls back to English without German texts, and German needs every key', () => {
  function EnglishOnly() {
    const m = useMessages({ en: { add: 'Add' } });
    return <p>{m.add}</p>;
  }
  render(
    <SdkLocaleProvider language="de">
      <EnglishOnly />
    </SdkLocaleProvider>,
  );
  expect(screen.getByText('Add')).toBeTruthy();
  // A German catalogue missing a key does not compile.
  void (() =>
    useMessages({
      en: { add: 'Add', count: 'n' },
      // @ts-expect-error `count` is missing in `de`.
      de: { add: 'A' },
    }));
});
