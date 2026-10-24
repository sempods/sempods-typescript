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
