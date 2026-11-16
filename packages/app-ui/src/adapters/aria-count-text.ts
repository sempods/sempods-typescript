/**
 * React Aria's combo box count ("2 options available."), as React Aria 1.22
 * (react-aria 3.53) says it: its `countAnnouncement` strings for
 * `@react-aria/combobox`, Apache-2.0, with `#` for the number, and its way
 * of choosing them for a locale (`@internationalized/string`). React Aria
 * does not export them; aria-count.test.ts compares this with the installed
 * React Aria for every locale it has and for locales it falls back from.
 */

/** Per locale: the count for the plural categories `one` and `other`. */
const counts: Readonly<Record<string, readonly [string, string]>> = {
  'ar-AE': ['# خيار متاحة.', '# خيارات متاحة.'],
  'bg-BG': ['# опция на разположение.', '# опции на разположение.'],
  'cs-CZ': ['K dispozici je # možnost.', 'K dispozici jsou/je # možnosti/-í.'],
  'da-DK': ['# mulighed tilgængelig.', '# muligheder tilgængelige.'],
  'de-DE': ['# Option verfügbar.', '# Optionen verfügbar.'],
  'el-GR': ['# επιλογή διαθέσιμες.', '# επιλογές  διαθέσιμες.'],
  'en-US': ['# option available.', '# options available.'],
  'es-ES': ['# opción disponible(s).', '# opciones disponible(s).'],
  'et-EE': ['# valik saadaval.', '# valikud saadaval.'],
  'fi-FI': ['# vaihtoehto saatavilla.', '# vaihtoehtoa saatavilla.'],
  'fr-FR': ['# option disponible(s).', '# options disponible(s).'],
  'he-IL': ['אפשרות # במצב זמין.', '# אפשרויות במצב זמין.'],
  'hr-HR': ['Dostupno još: # opcija.', 'Dostupno još: # opcije/a.'],
  'hu-HU': ['# lehetőség áll rendelkezésre.', '# lehetőség áll rendelkezésre.'],
  'it-IT': ['# opzione disponibile.', '# opzioni disponibili.'],
  'ja-JP': [
    '# 個のオプションを利用できます。',
    '# 個のオプションを利用できます。',
  ],
  'ko-KR': ['#개 옵션을 사용할 수 있습니다.', '#개 옵션을 사용할 수 있습니다.'],
  'lt-LT': ['Yra # parinktis.', 'Yra # parinktys (-ių).'],
  'lv-LV': [
    'Pieejamo opciju skaits: # opcija.',
    'Pieejamo opciju skaits: # opcijas.',
  ],
  'nb-NO': ['# alternativ finnes.', '# alternativer finnes.'],
  'nl-NL': ['# optie beschikbaar.', '# opties beschikbaar.'],
  'pl-PL': [
    'dostępna/dostępne(-nych) # opcja.',
    'dostępna/dostępne(-nych) # opcje(-i).',
  ],
  'pt-BR': ['# opção disponível.', '# opções disponível.'],
  'pt-PT': ['# opção disponível.', '# opções disponível.'],
  'ro-RO': ['# opțiune disponibile.', '# opțiuni disponibile.'],
  'ru-RU': ['# параметр доступно.', '# параметров доступно.'],
  'sk-SK': ['# možnosť k dispozícii.', '# možnosti/-í k dispozícii.'],
  'sl-SI': ['Na voljo je # opcija.', 'Na voljo je # opcije.'],
  'sr-SP': ['Dostupno još: # opcija.', 'Dostupno još: # opcije/a.'],
  'sv-SE': ['# alternativ tillgängliga.', '# alternativ tillgängliga.'],
  'tr-TR': ['# seçenek kullanılabilir.', '# seçenekler kullanılabilir.'],
  'uk-UA': ['# параметр доступно.', '# параметри(-ів) доступно.'],
  'zh-CN': ['有 # 个选项可用。', '有 # 个选项可用。'],
  'zh-TW': ['# 選項 可用。', '# 選項 可用。'],
};

/** The strings React Aria chooses for `locale`, falling back to en-US. */
function stringsFor(locale: string): readonly [string, string] {
  const exact = counts[locale];
  if (exact) return exact;
  const { language, script } = new Intl.Locale(locale);
  const near =
    (script ? counts[`${language}-${script}`] : undefined) ??
    counts[language] ??
    Object.entries(counts).find(([key]) => key.startsWith(language + '-'))?.[1];
  return near ?? (counts['en-US'] as readonly [string, string]);
}

/** What React Aria's combo box says for `count` options in `locale`. */
export function ariaCountText(count: number, locale: string): string {
  const [one, other] = stringsFor(locale);
  const text =
    new Intl.PluralRules(locale).select(count) === 'one' ? one : other;
  return text.replace('#', new Intl.NumberFormat(locale).format(count));
}
