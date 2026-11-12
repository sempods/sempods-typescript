import { describe, expect, it } from 'vitest';
import {
  contextLabels,
  contextName,
  podLabel,
  podLabels,
  podName,
} from './names.js';

it.each([
  ['https://one.example/', undefined, 'one.example'],
  ['https://one.example/alice/', undefined, 'one.example/alice'],
  ['https://one.example/alice', undefined, 'one.example/alice'],
  ['http://localhost:1234/alice/', '', 'localhost:1234/alice'],
  ['https://one.example/', 'Privat/', 'Privat/'],
  [
    'https://one.example/',
    'Familie – 夏の買い物'.repeat(8),
    'Familie – 夏の買い物'.repeat(8),
  ],
])('formats only the URL fallback (%s, %s)', (url, configured, expected) => {
  const names = configured === undefined ? undefined : { [url]: configured };
  expect(podLabel(url, names)).toBe(expected);
  // The existing standalone name contract is unchanged.
  expect(podName(url, names)).toBe(
    configured || url.replace(/^https?:\/\//, ''),
  );
});

it('keeps real context labels ending in a slash and decodes missing labels', () => {
  const iri =
    'https://one.example/_system/contexts/%E8%B2%B7%E3%81%84%E7%89%A9';
  expect(contextName(iri)).toBe('買い物');
  expect(contextName(iri, { [iri]: 'Shopping/' })).toBe('Shopping/');
});

it('decodes a non-ASCII address fallback and strips formatting characters', () => {
  expect(podLabel('https://host.example/J%C3%BCrgen/')).toBe(
    'host.example/Jürgen',
  );
  expect(podLabel('https://host.example/a%E2%80%AEb/')).toBe('host.example/ab');
  // Invalid escapes stay as they are.
  expect(podLabel('https://host.example/100%/')).toBe('host.example/100%');
});

it('shows the exact address where two address fallbacks would be equal', () => {
  const urls = [
    'https://pod.example/',
    'http://pod.example/',
    'https://pod.example/alice/',
    'https://other.example/',
  ];
  expect(podLabels(urls)).toEqual([
    'https://pod.example/',
    'http://pod.example/',
    'pod.example/alice',
    'other.example',
  ]);
  // A fallback equal to a configured name yields; configured names never change.
  expect(
    podLabels(urls.slice(2), {
      'https://other.example/': 'pod.example/alice',
    }),
  ).toEqual(['https://pod.example/alice/', 'pod.example/alice']);
  expect(
    podLabels(['https://a.example/', 'https://b.example/'], {
      'https://a.example/': 'Privat/',
      'https://b.example/': 'Privat/',
    }),
  ).toEqual(['Privat/', 'Privat/']);
});

describe('contextLabels', () => {
  const pod = 'https://pod.example/alice/';
  const iri = (path: string) => pod + path;
  const parts = (
    labels: Record<string, string>,
    iris: string[],
    podUrl: string | null = pod,
  ) => [
    ...contextLabels(
      iris,
      (i) => contextName(i, labels),
      podUrl ?? undefined,
    ).values(),
  ];

  it('adds nothing to names that are unique within the Pod', () => {
    const a = iri('_system/contexts/a');
    const b = iri('_system/contexts/b');
    expect(parts({ [a]: 'Shopping' }, [a, b])).toEqual([
      { contextLabel: 'Shopping', label: 'Shopping' },
      // Absent label: the readable segment, without a qualifier.
      { contextLabel: 'b', label: 'b' },
    ]);
  });

  it('qualifies equal labels by their segment, never collapsing them', () => {
    const work = iri('_system/contexts/work');
    const home = iri('_system/contexts/%E5%AE%B6');
    expect(parts({ [work]: 'Tasks', [home]: 'Tasks' }, [work, home])).toEqual([
      { contextLabel: 'Tasks', qualifier: 'work', label: 'Tasks · work' },
      { contextLabel: 'Tasks', qualifier: '家', label: 'Tasks · 家' },
    ]);
  });

  it('uses the path below the Pod when segments are equal too', () => {
    const a = iri('a/tasks');
    const b = iri('b/tasks');
    expect(parts({}, [a, b])).toEqual([
      { contextLabel: 'tasks', qualifier: 'a/tasks', label: 'tasks · a/tasks' },
      { contextLabel: 'tasks', qualifier: 'b/tasks', label: 'tasks · b/tasks' },
    ]);
    // Without a Pod (or outside it) only the exact IRI remains.
    expect(parts({}, [a, b], null).map((p) => p.qualifier)).toEqual([a, b]);
    expect(
      parts({}, [a, b], 'https://elsewhere.example/').map((p) => p.qualifier),
    ).toEqual([a, b]);
  });

  it('falls back to the exact IRI when decoding makes paths equal', () => {
    const a = iri('x/a%2Fb/tasks');
    const b = iri('x/a/b/tasks');
    expect(parts({}, [a, b]).map((p) => p.qualifier)).toEqual([a, b]);
  });

  it('keeps labels that end in a slash or are long and unique', () => {
    const a = iri('_system/contexts/a');
    const b = iri('_system/contexts/b');
    const long = 'Familie – 夏の買い物'.repeat(8);
    expect(parts({ [a]: 'Shopping/', [b]: long }, [a, b])).toEqual([
      { contextLabel: 'Shopping/', label: 'Shopping/' },
      { contextLabel: long, label: long },
    ]);
  });
});
