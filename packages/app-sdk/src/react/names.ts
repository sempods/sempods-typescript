/** Presentation only; identities and authorization always use the original IRI. */
export function contextName(
  iri: string,
  labels?: Readonly<Record<string, string>>,
) {
  const label = labels?.[iri]
    ?.replace(
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
      '',
    )
    .trim();
  if (label) return label;
  const segment = iri.slice(iri.lastIndexOf('/') + 1);
  try {
    return (
      decodeURIComponent(segment).replace(
        // eslint-disable-next-line no-control-regex
        /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
        '',
      ) || iri
    );
  } catch {
    return segment || iri;
  }
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
