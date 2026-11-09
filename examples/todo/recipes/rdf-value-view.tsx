import type { SelectResult, SparqlTerm } from '@sempods/client-sdk';
import { useMessages, useSdkLocale } from '@sempods/app-sdk/react';
import {
  commonAddressPredicates,
  commonVocabulary,
  describeValue,
  labelFor,
  type Vocabulary,
} from './rdf-values.js';

// App placeholder: the app's own vocabulary over the common labels. Its
// entries win; any other term falls back to a readable name from its IRI.
const vocabulary: Vocabulary = {
  ...commonVocabulary,
  'http://www.w3.org/1999/02/22-rdf-syntax-ns#type': { en: 'kind', de: 'Art' },
  'urn:example:vocab#Ship': { en: 'Ship', de: 'Schiff' },
};

const texts = {
  en: {
    blank: 'Unnamed node',
    unsupported: 'Unsupported value',
    empty: 'No values.',
    open: (host: string) => `Open ${host}`,
    show: (name: string) => `Show ${name}`,
  },
  de: {
    blank: 'Unbenannter Knoten',
    unsupported: 'Nicht unterstützter Wert',
    empty: 'Keine Werte.',
    open: (host: string) => `${host} öffnen`,
    show: (name: string) => `${name} anzeigen`,
  },
};

function useValues() {
  // The provider's formatters: pass `timeZone` there (see rdf-values.md).
  const { format, language } = useSdkLocale();
  const t = useMessages(texts);
  const describe = (term: SparqlTerm, predicate?: string) =>
    describeValue(term, {
      format,
      language,
      vocabulary,
      predicate,
      addressPredicates: commonAddressPredicates,
      texts: t,
    });
  const label = (iri: string) => labelFor(iri, vocabulary, language);
  return { describe, label, t };
}

/** Compact text for one term, such as a graph node's caption. */
export function ValueText({
  term,
  predicate,
}: {
  readonly term: SparqlTerm;
  readonly predicate?: string;
}) {
  const shown = useValues().describe(term, predicate);
  return (
    <span lang={shown.language} dir="auto">
      {shown.text}
    </span>
  );
}

/**
 * The bound `?property ?value` rows of one resource. A resource IRI opens in
 * the app (`onShow`, without a request); only a web address gets an external
 * link, beside its text and the exact term.
 */
export function ResourceValues({
  result,
  onShow,
}: {
  readonly result: SelectResult;
  readonly onShow: (iri: string) => void;
}) {
  const { describe, label, t } = useValues();
  const rows = result.rows.flatMap((row) =>
    row['property']?.type === 'iri' && row['value']
      ? [{ property: row['property'].value, value: row['value'] }]
      : [],
  );
  if (rows.length === 0) return <p>{t.empty}</p>;
  return (
    <dl>
      {rows.map(({ property, value }, index) => {
        const shown = describe(value, property);
        return (
          <div key={index}>
            <dt title={property} dir="auto">
              {label(property)}
            </dt>
            <dd>
              <span lang={shown.language} dir="auto">
                {shown.text}
              </span>
              {shown.note && <small> · {shown.note}</small>}{' '}
              {shown.address ? (
                <a
                  href={shown.address.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  referrerPolicy="no-referrer"
                >
                  {t.open(shown.address.host)}
                </a>
              ) : (
                value.type === 'iri' && (
                  <button type="button" onClick={() => onShow(value.value)}>
                    {t.show(shown.text)}
                  </button>
                )
              )}
              <br />
              {/* pre-wrap: "a  b" and "a b" are different literals. */}
              <code dir="ltr" style={{ whiteSpace: 'pre-wrap' }}>
                {shown.exact}
              </code>
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
