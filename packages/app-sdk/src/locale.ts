import { sdkFailure, type SdkFailure } from '@sempods/client-sdk';

export type Language = 'en' | 'de';
export type Direction = 'ltr' | 'rtl';

export function resolveLocale(
  explicit?: string,
  browserLanguages: readonly string[] = [],
) {
  function canonical(value: string) {
    try {
      return Intl.getCanonicalLocales(value)[0];
    } catch {
      return undefined;
    }
  }
  const requested = explicit ? canonical(explicit) : undefined;
  const browser = browserLanguages
    .map(canonical)
    .filter((value): value is string => Boolean(value));
  const supported = (value: string) =>
    ['en', 'de'].includes(value.split('-')[0]!);
  const locale = requested ?? browser.find(supported) ?? browser[0] ?? 'en';
  const language: Language = locale.split('-')[0] === 'de' ? 'de' : 'en';
  return { locale, language };
}

/** Regional formatting is independent of the translation catalog. */
export function createFormatters(locale: string, timeZone = 'UTC') {
  const numbers = new Intl.NumberFormat(locale);
  const plurals = new Intl.PluralRules(locale);
  const lists = new Intl.ListFormat(locale, {
    style: 'long',
    type: 'conjunction',
  });
  const instants = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  });
  const dates = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeZone: 'UTC',
  });
  return {
    number: (value: number) => numbers.format(value),
    list: (values: readonly string[]) => lists.format(values),
    plural: (
      count: number,
      forms: Partial<Record<Intl.LDMLPluralRule, string>> & {
        other: string;
      },
    ) => forms[plurals.select(count)] ?? forms.other,
    dateTime: (value: string | Date) => instants.format(new Date(value)),
    dateOnly(value: string) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
        throw new RangeError('Expected an ISO calendar date.');
      const date = new Date(`${value}T00:00:00Z`);
      if (
        !Number.isFinite(date.valueOf()) ||
        date.toISOString().slice(0, 10) !== value
      )
        throw new RangeError('Invalid calendar date.');
      return dates.format(date);
    },
  };
}
export type Formatters = ReturnType<typeof createFormatters>;

/**
 * One message per failure code. SDK catalogs cover every code; app overrides
 * are partial, so a new code in client-sdk never breaks an app's overrides.
 */
export type FailureMessages = {
  readonly [C in SdkFailure['code']]: (
    reason: Extract<SdkFailure, { readonly code: C }>,
  ) => string;
};

/** Functions receive typed values and return whole sentences; no message parser. */
export interface UiMessages {
  readonly loading: string;
  readonly connect: string;
  readonly podUrl: string;
  readonly signIn: string;
  /** Re-authorizes an active connection, for example to grant another context. */
  readonly updateAccess: string;
  readonly presetContextUnavailable: string;
  readonly disconnect: string;
  readonly refresh: string;
  readonly busy: string;
  readonly storage: string;
  readonly choosePod: string;
  readonly noTarget: string;
  readonly readOnly: string;
  readonly readLost: string;
  readonly save: string;
  readonly remove: string;
  readonly discard: string;
  readonly continueMine: string;
  readonly compare: string;
  readonly acknowledge: string;
  readonly saved: string;
  readonly removed: string;
  readonly created: string;
  readonly exists: string;
  readonly changed: string;
  readonly unconfirmed: string;
  readonly notSaved: string;
  readonly leaveTitle: string;
  readonly leaveBody: string;
  readonly leaveUnconfirmed: string;
  readonly stay: string;
  readonly leave: string;
  readonly retry: string;
  readonly cancel: string;
  readonly failure: string;
  readonly current: string;
  readonly notPresent: string;
  readonly yes: string;
  readonly no: string;
  readonly mine: string;
  readonly alongside: string;
}

export interface SdkMessages {
  readonly controls: UiMessages;
  readonly activePod: string;
  readonly dataContext: string;
  readonly chooseContext: string;
  readonly noContexts: string;
  readonly cataloguePending: string;
  readonly catalogueError: string;
  readonly reviewAccess: string;
  readonly missingScopes: (
    scopes: readonly string[],
    format: Formatters,
  ) => string;
  readonly errors: FailureMessages;
}

export const englishMessages: SdkMessages = {
  controls: {
    loading: 'Loading…',
    connect: 'Connect',
    podUrl: 'Pod URL',
    signIn: 'Sign in',
    updateAccess: 'Update access',
    presetContextUnavailable:
      'The configured context is not readable on this Pod.',
    disconnect: 'Disconnect',
    refresh: 'Check again',
    busy: 'Open in another tab. Close that tab and reload here.',
    storage:
      'Session storage could not be opened. Reload the page to try again.',
    choosePod: 'Choose a pod',
    noTarget: 'Choose a pod and a context to continue.',
    readOnly: 'You can read this context, but cannot change it.',
    readLost: 'Access is unavailable. Your draft is kept.',
    save: 'Save',
    remove: 'Delete',
    discard: 'Discard changes',
    continueMine: 'Continue with my changes',
    compare: 'Check current version',
    acknowledge: 'I have checked the pod',
    saved: 'Saved.',
    removed: 'Deleted.',
    created: 'Created.',
    exists: 'This address is already in use.',
    changed: 'The pod has changed. Compare before continuing.',
    unconfirmed:
      'The result is unconfirmed. Check the pod before deciding; nothing is retried automatically.',
    notSaved: 'The change was not saved. Check access and try again.',
    leaveTitle: 'Discard unsaved changes?',
    leaveBody: 'Leaving will discard the affected draft.',
    leaveUnconfirmed:
      'A write is still unconfirmed and may already have changed the pod. Leaving discards its local recovery state and drafts, not the write. Check the pod before trying again.',
    stay: 'Keep editing',
    leave: 'Discard and continue',
    retry: 'Try again',
    cancel: 'Cancel',
    failure: 'The operation could not be completed.',
    current: 'Current on the pod',
    notPresent: 'This resource is not currently present on the pod.',
    yes: 'Yes',
    no: 'No',
    mine: 'Your draft',
    alongside: 'Saved alongside changes to other fields.',
  },
  activePod: 'Active pod',
  dataContext: 'Data context',
  chooseContext: 'Choose a context',
  noContexts: 'No readable contexts. Review access on this pod.',
  cataloguePending: 'Loading context catalogue… Access is unknown.',
  catalogueError: 'Context catalogue unavailable. Access is unknown.',
  reviewAccess: 'Review access',
  missingScopes: (scopes, format) =>
    `Review required feature access: ${format.list(scopes)}.`,
  errors: {
    'invalid-pod-url': () => 'Enter a valid pod URL.',
    'invalid-argument': () =>
      'The app created an invalid request. Try again or report the problem.',
    discovery(reason) {
      if (reason.problem === 'cancelled') return 'Pod discovery was cancelled.';
      if (reason.problem === 'network' || reason.problem === 'http')
        return 'The pod’s connection information could not be loaded. Try again.';
      if (reason.problem === 'unsupported-flow')
        return 'This pod does not advertise the required sign-in method.';
      return 'The pod’s connection information could not be verified.';
    },
    catalogue: () =>
      'The pod’s list of contexts could not be read. Access is unknown.',
    authentication: () => 'Signing in to the pod failed. Connect again.',
    transport: (reason) =>
      reason.problem === 'cancelled'
        ? 'The request was cancelled.'
        : 'The pod could not be reached. Check the connection and try again.',
    http: (reason) =>
      reason.status >= 500
        ? 'The pod reported an error. Try again later.'
        : reason.status >= 400
          ? 'The pod rejected the request.'
          : 'The result of the request is unconfirmed.',
    response: () => 'The pod’s answer could not be verified.',
    oauth: (reason) =>
      reason.problem === 'denied'
        ? 'Sign-in was cancelled.'
        : 'Sign-in failed. Try again.',
    unexpected: () => 'The operation failed. Try again.',
  },
};

export const germanMessages: SdkMessages = {
  controls: {
    loading: 'Wird geladen…',
    connect: 'Verbinden',
    podUrl: 'Pod-URL',
    signIn: 'Anmelden',
    updateAccess: 'Zugriff ändern',
    presetContextUnavailable:
      'Der konfigurierte Kontext ist auf diesem Pod nicht lesbar.',
    disconnect: 'Trennen',
    refresh: 'Erneut prüfen',
    busy: 'In einem anderen Tab geöffnet. Schließe diesen Tab und lade hier neu.',
    storage:
      'Der Sitzungsspeicher konnte nicht geöffnet werden. Lade die Seite neu, um es erneut zu versuchen.',
    choosePod: 'Pod auswählen',
    noTarget: 'Wähle einen Pod und einen Kontext aus.',
    readOnly: 'Du kannst diesen Kontext lesen, aber nicht ändern.',
    readLost: 'Der Zugriff ist nicht verfügbar. Dein Entwurf bleibt erhalten.',
    save: 'Speichern',
    remove: 'Löschen',
    discard: 'Änderungen verwerfen',
    continueMine: 'Mit meinen Änderungen fortfahren',
    compare: 'Aktuellen Stand prüfen',
    acknowledge: 'Ich habe den Pod geprüft',
    saved: 'Gespeichert.',
    removed: 'Gelöscht.',
    created: 'Erstellt.',
    exists: 'Diese Adresse ist bereits belegt.',
    changed: 'Der Pod wurde geändert. Vergleiche vor dem Fortfahren.',
    unconfirmed:
      'Das Ergebnis ist unbestätigt. Prüfe den Pod vor deiner Entscheidung; es wird nichts automatisch wiederholt.',
    notSaved:
      'Die Änderung wurde nicht gespeichert. Prüfe den Zugriff und versuche es erneut.',
    leaveTitle: 'Ungespeicherte Änderungen verwerfen?',
    leaveBody: 'Beim Verlassen wird der betroffene Entwurf verworfen.',
    leaveUnconfirmed:
      'Eine Schreibaktion ist noch unbestätigt und kann den Pod bereits geändert haben. Beim Verlassen werden ihr lokaler Wiederherstellungsstand und die Entwürfe verworfen, nicht die Schreibaktion. Prüfe den Pod, bevor du es erneut versuchst.',
    stay: 'Weiter bearbeiten',
    leave: 'Verwerfen und fortfahren',
    retry: 'Erneut versuchen',
    cancel: 'Abbrechen',
    failure: 'Die Aktion konnte nicht abgeschlossen werden.',
    current: 'Aktuell auf dem Pod',
    notPresent: 'Diese Ressource ist aktuell nicht auf dem Pod vorhanden.',
    yes: 'Ja',
    no: 'Nein',
    mine: 'Dein Entwurf',
    alongside: 'Zusammen mit Änderungen an anderen Feldern gespeichert.',
  },
  activePod: 'Aktiver Pod',
  dataContext: 'Datenkontext',
  chooseContext: 'Kontext auswählen',
  noContexts: 'Keine lesbaren Kontexte. Prüfe den Zugriff auf diesen Pod.',
  cataloguePending:
    'Kontextkatalog wird geladen… Der Zugriff ist noch unbekannt.',
  catalogueError:
    'Kontextkatalog nicht verfügbar. Der Zugriff ist noch unbekannt.',
  reviewAccess: 'Zugriff prüfen',
  missingScopes: (scopes, format) =>
    `Prüfe den Zugriff auf benötigte Funktionen: ${format.list(scopes)}.`,
  errors: {
    'invalid-pod-url': () => 'Gib eine gültige Pod-URL ein.',
    'invalid-argument': () =>
      'Die App hat eine ungültige Anfrage erzeugt. Versuche es erneut oder melde das Problem.',
    discovery(reason) {
      if (reason.problem === 'cancelled')
        return 'Die Pod-Erkennung wurde abgebrochen.';
      if (reason.problem === 'network' || reason.problem === 'http')
        return 'Die Verbindungsinformationen des Pods konnten nicht geladen werden. Versuche es erneut.';
      if (reason.problem === 'unsupported-flow')
        return 'Dieser Pod bietet das benötigte Anmeldeverfahren nicht an.';
      return 'Die Verbindungsinformationen des Pods konnten nicht bestätigt werden.';
    },
    catalogue: () =>
      'Die Kontextliste des Pods konnte nicht gelesen werden. Der Zugriff ist unbekannt.',
    authentication: () =>
      'Die Anmeldung beim Pod ist fehlgeschlagen. Verbinde dich erneut.',
    transport: (reason) =>
      reason.problem === 'cancelled'
        ? 'Die Anfrage wurde abgebrochen.'
        : 'Der Pod ist nicht erreichbar. Prüfe die Verbindung und versuche es erneut.',
    http: (reason) =>
      reason.status >= 500
        ? 'Der Pod hat einen Fehler gemeldet. Versuche es später erneut.'
        : reason.status >= 400
          ? 'Der Pod hat die Anfrage abgelehnt.'
          : 'Das Ergebnis der Anfrage ist unbestätigt.',
    response: () => 'Die Antwort des Pods konnte nicht überprüft werden.',
    oauth: (reason) =>
      reason.problem === 'denied'
        ? 'Die Anmeldung wurde abgebrochen.'
        : 'Die Anmeldung ist fehlgeschlagen. Versuche es erneut.',
    unexpected: () => 'Die Aktion ist fehlgeschlagen. Versuche es erneut.',
  },
};

export interface LocaleOptions {
  readonly locale?: string;
  readonly language?: Language;
  readonly timeZone?: string;
  readonly direction?: Direction;
  /** Partial overrides; `errors` overrides individual failure codes only. */
  readonly messages?: Partial<Omit<SdkMessages, 'errors' | 'controls'>> & {
    readonly errors?: Partial<FailureMessages>;
    readonly controls?: Partial<UiMessages>;
  };
}

/** Pure presentation factory; no browser globals, storage or request side effects. */
export function createLocale({
  locale: requested,
  language: selected,
  timeZone = 'UTC',
  direction = 'ltr',
  messages,
}: LocaleOptions = {}) {
  const resolved = resolveLocale(requested);
  const { locale } = resolved;
  const language = selected ?? resolved.language;
  const defaults = language === 'de' ? germanMessages : englishMessages;
  const catalog: SdkMessages = {
    ...defaults,
    ...messages,
    errors: { ...defaults.errors, ...messages?.errors },
    controls: { ...defaults.controls, ...messages?.controls },
  };
  const format = createFormatters(locale, timeZone);
  return {
    locale,
    language,
    timeZone,
    direction,
    messages: catalog,
    format,
    error: (cause: unknown) =>
      describeFailure(catalog.errors, sdkFailure(cause)),
  };
}
export type LocalePresentation = ReturnType<typeof createLocale>;

/** Presentation text for a structured failure; diagnostics are never shown. */
export function describeFailure(
  errors: FailureMessages,
  reason: SdkFailure,
): string {
  // TypeScript cannot correlate a union member with its keyed handler; the map type guarantees it.
  const handler = errors[reason.code] as (reason: SdkFailure) => string;
  return handler(reason);
}
