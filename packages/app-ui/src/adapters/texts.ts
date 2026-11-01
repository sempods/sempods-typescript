import { useMessages } from '@sempods/app-sdk/react';

/** The adapters' own texts, in the SDK provider's language. */
const texts = {
  en: {
    menu: 'Menu',
    noDate: 'No date',
    apply: 'Apply',
    removeDate: 'Remove date',
  },
  de: {
    menu: 'Menü',
    noDate: 'Kein Datum',
    apply: 'Übernehmen',
    removeDate: 'Datum entfernen',
  },
};

export type AdapterTexts = (typeof texts)['en'];

export function useAdapterTexts(): AdapterTexts {
  return useMessages(texts);
}
