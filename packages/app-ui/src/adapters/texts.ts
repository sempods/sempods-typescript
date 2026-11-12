import { useMessages } from '@sempods/app-sdk/react';

/** The adapters' own texts, in the SDK provider's language. */
const texts = {
  en: {
    menu: 'Menu',
    context: 'Context',
    chooseContext: 'Choose a context',
    shareContexts: 'Share more contexts …',
    contextsLoading: 'Loading contexts …',
    contextsFailed: 'Contexts could not be loaded.',
    contextsEmpty: 'No readable contexts shared.',
    podRestoring: 'Reconnecting …',
    podLeaving: 'Opening sign-in …',
    podSignedOut: 'Sign in to use this Pod.',
    signInPod: 'Sign in',
    podActions: 'Pod actions',
    noPods: 'Connect a Pod to choose a context.',
    switchBlocked: 'Wait for the current change to finish, then try again.',
    switchUnavailable: 'This context is currently unavailable.',
    actionNotCompleted:
      'The action was not completed. Your current context is unchanged.',
    showAddresses: 'Show Pod and context addresses',
    hideAddresses: 'Hide addresses',
    addresses: 'Pod and context addresses',
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
    context: 'Kontext',
    chooseContext: 'Kontext auswählen',
    shareContexts: 'Weitere Kontexte freigeben …',
    contextsLoading: 'Kontexte werden geladen …',
    contextsFailed: 'Kontexte konnten nicht geladen werden.',
    contextsEmpty: 'Keine lesbaren Kontexte freigegeben.',
    podRestoring: 'Verbindung wird wiederhergestellt …',
    podLeaving: 'Anmeldung wird geöffnet …',
    podSignedOut: 'Melde dich an, um diesen Pod zu nutzen.',
    signInPod: 'Anmelden',
    podActions: 'Pod-Aktionen',
    noPods: 'Verbinde einen Pod, um einen Kontext auszuwählen.',
    switchBlocked:
      'Warte, bis die aktuelle Änderung abgeschlossen ist, und versuche es erneut.',
    switchUnavailable: 'Dieser Kontext ist gerade nicht verfügbar.',
    actionNotCompleted:
      'Die Aktion wurde nicht abgeschlossen. Dein aktueller Kontext bleibt unverändert.',
    showAddresses: 'Pod- und Kontextadressen anzeigen',
    hideAddresses: 'Adressen ausblenden',
    addresses: 'Pod- und Kontextadressen',
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
