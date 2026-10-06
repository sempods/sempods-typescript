import { expect, it } from 'vitest';
import {
  CatalogueError,
  decodeCatalogue,
  decodeContextDescription,
  isContextIri,
} from './catalogue.js';
const pod = 'https://pod.example/alice';
const sd = 'http://www.w3.org/ns/sparql-service-description#';
const sps = 'https://schema.sempods.org/';
const root = {
  '@id': `${pod}/_system/contexts`,
  '@type': [`${sd}GraphCollection`],
};
const tasks = `${pod}/_system/contexts/tasks`;
const notes = `${pod}/_system/contexts/apps/notes/public`;
const ids = (...iris: string[]) => iris.map((iri) => ({ '@id': iri }));

it('reports implied caller rights per context (SPS-CTX-033/034, SPS-GRANT-009)', () => {
  const contexts = decodeCatalogue(
    {
      ...root,
      [`${sd}namedGraph`]: ids(tasks, notes),
      [`${sps}readableContext`]: ids(tasks, notes),
      [`${sps}writableContext`]: ids(notes),
      [`${sps}manageableContext`]: ids(notes),
    },
    pod,
  );
  expect(contexts).toEqual([
    { iri: tasks, readable: true, writable: false, manageable: false },
    { iri: notes, readable: true, writable: true, manageable: true },
  ]);
});

it('distinguishes a valid empty catalogue from malformed or legacy responses', () => {
  expect(decodeCatalogue(root, pod)).toEqual([]);
  for (const body of [
    {},
    [],
    { contexts: [] },
    { ...root, '@id': 'urn:other' },
    { ...root, '@context': {} },
    { ...root, [`${sd}namedGraph`]: [tasks] },
    { ...root, [`${sps}readableContext`]: ids(tasks) },
  ])
    expect(() => decodeCatalogue(body, pod)).toThrow();
});

it('rejects rights that the grant model cannot produce, instead of trusting them', () => {
  const member = { ...root, [`${sd}namedGraph`]: ids(tasks) };
  const foreign = 'https://pod.example/bob/_system/contexts/tasks';
  for (const body of [
    // Visible without any mode: membership alone is not a right.
    member,
    // Write-only or manage-only contexts do not exist (write and manage imply read).
    { ...member, [`${sps}writableContext`]: ids(tasks) },
    {
      ...member,
      [`${sps}readableContext`]: ids(tasks),
      [`${sps}manageableContext`]: ids(tasks),
    },
    // Context IRIs live under this pod's registry (SPS-CTX-004).
    {
      ...root,
      [`${sd}namedGraph`]: ids('urn:a'),
      [`${sps}readableContext`]: ids('urn:a'),
    },
    {
      ...root,
      [`${sd}namedGraph`]: ids(foreign),
      [`${sps}readableContext`]: ids(foreign),
    },
    // An embedded context description is not a catalogue entry.
    {
      ...root,
      [`${sd}namedGraph`]: [{ '@id': tasks, [`${sps}public`]: true }],
      [`${sps}readableContext`]: ids(tasks),
    },
  ])
    expect(() => decodeCatalogue(body, pod)).toThrow();
});

it('rejects context paths that cannot be addressed again (SPS-CTX-010/013), without normalizing', () => {
  const listed = (iri: string) => ({
    ...root,
    [`${sd}namedGraph`]: ids(iri),
    [`${sps}readableContext`]: ids(iri),
  });
  for (const suffix of [
    'a//b',
    'a/./b',
    'a/../b',
    'a%2Fb',
    'a%23b',
    'a?x=1',
    'a#read',
    'a/',
    '',
    'a/_system/b',
    'a b',
  ])
    expect(() =>
      decodeCatalogue(listed(`${pod}/_system/contexts/${suffix}`), pod),
    ).toThrow();
  for (const iri of [tasks, notes])
    expect(decodeCatalogue(listed(iri), pod)).toEqual([
      { iri, readable: true, writable: false, manageable: false },
    ]);
});

it('accepts a percent-encoded pod base while still rejecting encoded context paths', () => {
  const base = 'https://pod.example/users/alice%20smith';
  const context = `${base}/_system/contexts/tasks`;
  const body = (iri: string) => ({
    '@id': `${base}/_system/contexts`,
    '@type': [`${sd}GraphCollection`],
    [`${sd}namedGraph`]: ids(iri),
    [`${sps}readableContext`]: ids(iri),
  });
  expect(decodeCatalogue(body(context), base)).toEqual([
    { iri: context, readable: true, writable: false, manageable: false },
  ]);
  expect(() =>
    decodeCatalogue(body(`${base}/_system/contexts/a%2Fb`), base),
  ).toThrow();
});

it('keeps raw Unicode context IRIs exactly as listed (SPS-CTX-013 forbids percent encoding, not Unicode)', () => {
  const munich = `${pod}/_system/contexts/projekte/münchen`;
  const greeting = `${pod}/_system/contexts/grüße`;
  const contexts = decodeCatalogue(
    {
      ...root,
      [`${sd}namedGraph`]: ids(munich, greeting),
      [`${sps}readableContext`]: ids(munich, greeting),
    },
    pod,
  );
  expect(contexts.map((c) => c.iri)).toEqual([munich, greeting]);
  for (const suffix of ['projekte/m%C3%BCnchen', 'a\\b', 'a\tb'])
    expect(() =>
      decodeCatalogue(
        {
          ...root,
          [`${sd}namedGraph`]: ids(`${pod}/_system/contexts/${suffix}`),
          [`${sps}readableContext`]: ids(`${pod}/_system/contexts/${suffix}`),
        },
        pod,
      ),
    ).toThrow();
});

it('exposes the same canonical context check for caller configuration, without implying grants', () => {
  expect(isContextIri(tasks, pod)).toBe(true);
  expect(isContextIri(pod + '/_system/contexts/persönlich/tasks', pod)).toBe(
    true,
  );
  for (const value of [
    tasks + '/',
    tasks + '?',
    tasks + '%20',
    tasks + '/..',
    tasks + '/_system',
    'urn:task',
    notes.replace('/alice/', '/bob/'),
  ])
    expect(isContextIri(value, pod)).toBe(false);
});

const described = {
  '@id': tasks,
  '@type': [`${sd}NamedGraph`],
  [`${sd}name`]: [{ '@id': tasks }],
  [`${sps}public`]: [{ '@value': false }],
};
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const DCT = 'http://purl.org/dc/terms/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

it('reads a Context description: label, description, public flag and creation time (SPS-CTX-032)', () => {
  expect(
    decodeContextDescription(
      {
        ...described,
        [RDFS_LABEL]: [{ '@value': 'Aufgaben' }],
        [`${DCT}description`]: [{ '@value': 'Tasks', '@type': `${XSD}string` }],
        [`${DCT}created`]: [
          { '@value': '2026-10-01T08:00:00Z', '@type': `${XSD}dateTime` },
        ],
        'http://www.w3.org/2000/01/rdf-schema#seeAlso': [
          { '@id': `${pod}/_system/resources/x` },
        ],
        'https://example.org/extra': [{ '@value': 'tolerated' }],
      },
      tasks,
      pod,
    ),
  ).toEqual({
    iri: tasks,
    public: false,
    label: 'Aufgaben',
    description: 'Tasks',
    created: '2026-10-01T08:00:00Z',
  });
});

it('leaves out absent, ambiguous or non-plain descriptive text', () => {
  const read = (extra: Record<string, unknown>) =>
    decodeContextDescription({ ...described, ...extra }, tasks, pod);
  expect(read({})).toEqual({ iri: tasks, public: false });
  for (const label of [
    [{ '@value': 'A' }, { '@value': 'B' }],
    [{ '@value': 'Privat', '@language': 'de' }],
    [{ '@value': 3 }],
    [{ '@id': 'https://example.org/label' }],
    [{ '@value': 'x', '@type': `${XSD}token` }],
  ])
    expect(read({ [RDFS_LABEL]: label }).label).toBeUndefined();
  expect(
    read({ [`${DCT}created`]: [{ '@value': '2026-10-01' }] }).created,
  ).toBeUndefined();
});

it('rejects a malformed description as a catalogue failure', () => {
  const bad: unknown[] = [
    null,
    [described],
    { ...described, '@context': {} },
    { ...described, '@id': notes },
    { ...described, '@type': [`${sd}GraphCollection`] },
    { ...described, [`${sd}name`]: [] },
    { ...described, [`${sd}name`]: [{ '@id': notes }] },
    { ...described, [`${sps}public`]: [{ '@value': 'false' }] },
    { ...described, [`${sps}public`]: [] },
    { ...described, [RDFS_LABEL]: { '@value': 'not an array' } },
  ];
  for (const body of bad)
    expect(() => decodeContextDescription(body, tasks, pod)).toThrow(
      CatalogueError,
    );
  // The asked IRI must be a context IRI of this Pod.
  expect(() =>
    decodeContextDescription(
      { ...described, '@id': `${pod}/tasks` },
      `${pod}/tasks`,
      pod,
    ),
  ).toThrow(CatalogueError);
});
