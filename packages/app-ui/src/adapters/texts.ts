import { useMessages } from '@sempods/app-sdk/react';

/** The adapters' own texts, in the SDK provider's language. */
const texts = {
  en: {
    menu: 'Menu',
    noDate: 'No date',
    apply: 'Apply',
    removeDate: 'Remove date',
    searching: 'Searching …',
    searchingMore: 'Searching for more …',
    searchFailed: 'The search failed.',
    searchPartial: 'Some sources could not be searched.',
    noSuggestions: 'No suggestions.',
    oneSuggestion: '1 suggestion.',
    suggestions: '{count} suggestions.',
  },
  de: {
    menu: 'Menü',
    noDate: 'Kein Datum',
    apply: 'Übernehmen',
    removeDate: 'Datum entfernen',
    searching: 'Suche läuft …',
    searchingMore: 'Weitere werden gesucht …',
    searchFailed: 'Die Suche ist fehlgeschlagen.',
    searchPartial: 'Einige Quellen konnten nicht durchsucht werden.',
    noSuggestions: 'Keine Vorschläge.',
    oneSuggestion: '1 Vorschlag.',
    suggestions: '{count} Vorschläge.',
  },
};

export type AdapterTexts = (typeof texts)['en'];

export function useAdapterTexts(): AdapterTexts {
  return useMessages(texts);
}
