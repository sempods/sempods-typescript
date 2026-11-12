// Control and bidirectional formatting characters never reach display text.
// eslint-disable-next-line no-control-regex
const unsafe = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;
/** Percent-decoded where valid, without control or bidi formatting characters. */
function readable(text: string) {
  try {
    return decodeURIComponent(text).replace(unsafe, '');
  } catch {
    return text.replace(unsafe, '');
  }
}

/** Presentation only; identities and authorization always use the original IRI. */
export function contextName(
  iri: string,
  labels?: Readonly<Record<string, string>>,
) {
  const label = labels?.[iri]?.replace(unsafe, '').trim();
  if (label) return label;
  const segment = iri.slice(iri.lastIndexOf('/') + 1);
  return readable(segment) || iri;
}
export function podName(url: string, names?: Readonly<Record<string, string>>) {
  return names?.[url]?.trim() || url.replace(/^https?:\/\//, '');
}
export function distinctName(
  iri: string,
  identities: readonly string[],
  name: (iri: string) => string,
) {
  const label = name(iri);
  return identities.some((other) => other !== iri && name(other) === label)
    ? `${label} · ${iri}`
    : label;
}

/**
 * A readable address fallback only: no scheme, one terminal slash removed and
 * the path decoded. A configured label may intentionally end in /.
 */
export function podLabel(
  url: string,
  names?: Readonly<Record<string, string>>,
) {
  return (
    names?.[url]?.trim() ||
    readable(url.replace(/^https?:\/\//, '').replace(/\/$/, '')) ||
    url
  );
}

/**
 * `podLabel` for every Pod of one chooser. Address fallbacks that would equal
 * another Pod's label show the exact address; configured names stay as given.
 */
export function podLabels(
  urls: readonly string[],
  names?: Readonly<Record<string, string>>,
) {
  const labels = urls.map((url) => podLabel(url, names));
  return urls.map((url, i) =>
    !names?.[url]?.trim() &&
    labels.some((other, j) => j !== i && other === labels[i])
      ? url
      : labels[i]!,
  );
}

/** How one Context of a Pod is shown, apart from its Pod. */
export interface ContextLabelParts {
  readonly contextLabel: string;
  readonly qualifier?: string;
  /** `contextLabel`, plus ` · qualifier` when there is one. */
  readonly label: string;
}

/**
 * Tells the Contexts of one Pod apart without collapsing equal names: a
 * qualifier is added only where the composed label would repeat, first the
 * readable last segment, then the path below the Pod, then the exact IRI.
 */
export function contextLabels(
  iris: readonly string[],
  name: (iri: string) => string,
  podUrl?: string,
): ReadonlyMap<string, ContextLabelParts> {
  const base = podUrl && (podUrl.endsWith('/') ? podUrl : podUrl + '/');
  const options = new Map(
    iris.map((iri) => {
      const label = name(iri);
      const segment = contextName(iri);
      const path =
        base && iri.startsWith(base) && iri.length > base.length
          ? readable(iri.slice(base.length))
          : undefined;
      const qualifiers: (string | undefined)[] = [undefined];
      for (const q of [segment, path, iri])
        if (q && q !== label && !qualifiers.includes(q)) qualifiers.push(q);
      if (qualifiers.at(-1) !== iri) qualifiers.push(iri);
      return [iri, { label, qualifiers }] as const;
    }),
  );
  const level = new Map(iris.map((iri) => [iri, 0]));
  const compose = (iri: string) => {
    const { label, qualifiers } = options.get(iri)!;
    const qualifier = qualifiers[level.get(iri)!];
    return qualifier ? `${label} · ${qualifier}` : label;
  };
  // Every Context sharing a composed label takes its next qualifier; the
  // last one is the unique IRI, so this ends.
  for (let changed = true; changed;) {
    changed = false;
    const shown = new Map<string, string[]>();
    for (const iri of iris) {
      const text = compose(iri);
      shown.set(text, [...(shown.get(text) ?? []), iri]);
    }
    for (const same of shown.values())
      if (same.length > 1)
        for (const iri of same)
          if (level.get(iri)! < options.get(iri)!.qualifiers.length - 1) {
            level.set(iri, level.get(iri)! + 1);
            changed = true;
          }
  }
  return new Map(
    iris.map((iri) => {
      const { label, qualifiers } = options.get(iri)!;
      const qualifier = qualifiers[level.get(iri)!];
      return [
        iri,
        qualifier
          ? { contextLabel: label, qualifier, label: compose(iri) }
          : { contextLabel: label, label },
      ];
    }),
  );
}
