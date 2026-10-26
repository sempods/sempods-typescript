import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { createLocale, resolveLocale, type LocaleOptions } from '../index.js';

const LocaleContext = createContext(createLocale());

/** The browser's language preferences, or none outside a browser. */
function browserLanguages(): readonly string[] {
  const browser = (
    globalThis as {
      readonly navigator?: {
        readonly languages?: readonly string[];
        readonly language?: string;
      };
    }
  ).navigator;
  const languages = browser?.languages;
  if (languages?.length) return languages;
  return browser?.language ? [browser.language] : [];
}

/**
 * Presentation only: changing locale does not replace children or mutate sessions.
 * Without `locale` and `language`, the browser's preferences, read once for the
 * provider's lifetime, choose both; an explicit option keeps its own precedence.
 */
export function SdkLocaleProvider({
  children,
  ...options
}: LocaleOptions & { readonly children: ReactNode }) {
  const { locale, language, timeZone, direction, messages } = options;
  const [preferred] = useState(
    () => resolveLocale(undefined, browserLanguages()).locale,
  );
  const value = useMemo(
    () =>
      createLocale(
        locale === undefined && language === undefined
          ? { ...options, locale: preferred }
          : options,
      ),
    // `options` is a new rest object on every render; its fields are listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [locale, language, timeZone, direction, messages, preferred],
  );
  return (
    <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
  );
}
export function useSdkLocale() {
  return useContext(LocaleContext);
}

/**
 * The app's own texts in the provider's language: English, and German when
 * given, with the same keys (the compiler names a missing one). Values may be
 * functions for texts with parts. Define the catalogue outside components:
 *
 * ```tsx
 * const text = { en: { add: 'Add' }, de: { add: 'Hinzufügen' } };
 * const m = useMessages(text); // m.add
 * ```
 */
export function useMessages<M extends object>(catalogue: {
  readonly en: M;
  readonly de?: NoInfer<M>;
}): M {
  const { language } = useSdkLocale();
  return (language === 'de' ? catalogue.de : undefined) ?? catalogue.en;
}
