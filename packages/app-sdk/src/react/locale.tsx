import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { createLocale, type LocaleOptions } from '../index.js';

const LocaleContext = createContext(createLocale());

/** Presentation only: changing locale does not replace children or mutate sessions. */
export function SdkLocaleProvider({
  children,
  ...options
}: LocaleOptions & { readonly children: ReactNode }) {
  const { locale, language, timeZone, direction, messages } = options;
  const value = useMemo(
    () => createLocale(options),
    [locale, language, timeZone, direction, messages],
  );
  return (
    <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
  );
}
export function useSdkLocale() {
  return useContext(LocaleContext);
}
