/** The React-free resource card recipe (#245), on the SDK's SELECT decoder. */
import { describe, expect, it } from 'vitest';
import { anonymous, createPod } from '@sempods/client-sdk';
import {
  MAX_IMAGES,
  cardQuery,
  exampleRules,
  imageAddress,
  previewCandidates,
  resourceCards,
  sourceFacts,
  type CardRule,
  type SourceFacts,
} from '../../../examples/todo/recipes/resource-cards.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SAME_AS = 'http://www.w3.org/2002/07/owl#sameAs';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const S = 'https://schema.org/';
const alice = 'https://pod.example/alice';
const bob = 'https://pod.example/bob';
const ada = 'https://people.example/ada';
const lovelace = 'https://people.example/lovelace';
const talk = 'https://events.example/talk';

type Term = Readonly<Record<string, string>>;
const iri = (value: string): Term => ({ type: 'uri', value });
const blank = (value: string): Term => ({ type: 'bnode', value });
const text = (value: string): Term => ({ type: 'literal', value });
const date = (value: string, type = 'date'): Term => ({
  type: 'literal',
  value,
  datatype: `${XSD}${type}`,
});

/** Rows `[s, p, o, g]`, decoded by the SDK's own SELECT decoder. */
async function select(
  rows: readonly (readonly [Term, string, Term, string])[],
) {
  const pod = createPod(alice, {
    auth: anonymous(),
    fetch: async () =>
      Response.json(
        {
          head: { vars: ['s', 'p', 'o', 'g'] },
          results: {
            bindings: rows.map(([s, p, o, g]) => ({
              s,
              p: iri(p),
              o,
              g: iri(g),
            })),
          },
        },
        { headers: { 'content-type': 'application/sparql-results+json' } },
      ),
  });
  const answer = await pod.sparql.select('SELECT * WHERE { ?s ?p ?o }');
  if (answer.kind !== 'ok') throw new Error(answer.kind);
  return answer.body;
}

async function facts(
  root: string,
  pod: string,
  rows: readonly (readonly [Term, string, Term, string])[],
): Promise<SourceFacts> {
  return sourceFacts(await select(rows), root, pod, exampleRules);
}
const ctx = (pod: string, name: string) => `${pod}/contexts/${name}`;

describe('card query', () => {
  it('reads only the declared paths of one root, bounded', () => {
    const query = cardQuery(ada, exampleRules);
    expect(query).toContain(`GRAPH ?g { <${ada}> ?p ?o }`);
    expect(query).toContain(`GRAPH ?origin { <${ada}> ?link ?s }`);
    expect(query).toContain(`<${RDF_TYPE}>`);
    expect(query).toContain(`<${SAME_AS}>`);
    expect(query).toContain(`<${S}thumbnailUrl>`);
    expect(query).toContain('ORDER BY ?s ?p ?g ?o LIMIT 201');
    // Values are never read as roots of further reads.
    expect(query.match(/GRAPH/g)).toHaveLength(3);
  });

  it("pairs each link only with its own path's variants", () => {
    const rules: readonly CardRule[] = [
      {
        id: 'any',
        types: [],
        images: [
          [['urn:v:photo'], ['urn:v:thumbnail']],
          [['urn:v:icon'], ['urn:v:iconUrl']],
          [['urn:v:photo']],
        ],
        dates: [],
      },
    ];
    const query = cardQuery(ada, rules);
    // Undeclared pairs never use up the bounded rows.
    expect(query).toContain(
      'VALUES (?link ?p) { (<urn:v:photo> <urn:v:thumbnail>) (<urn:v:icon> <urn:v:iconUrl>) }',
    );
    expect(query).not.toContain('(<urn:v:photo> <urn:v:iconUrl>)');
  });

  it('refuses a root that is no IRI or would break the query', () => {
    for (const root of [
      'ada',
      'https://x.example/a b',
      'https://x.example/>',
      'urn:a\u0000',
    ])
      expect(() => cardQuery(root, exampleRules)).toThrow();
  });
});

describe('facts of one read', () => {
  it('keeps the Pod, Context and statement of every value', async () => {
    const found = await facts(ada, alice, [
      [iri(ada), RDF_TYPE, iri(`${S}Person`), ctx(alice, 'people')],
      [iri(ada), RDF_TYPE, iri(`${S}Person`), ctx(alice, 'team')],
      [
        iri(ada),
        `${S}image`,
        text('https://img.example/ada.jpg'),
        ctx(alice, 'people'),
      ],
    ]);
    expect(found.types).toEqual([
      {
        value: `${S}Person`,
        evidence: [
          {
            pod: alice,
            context: ctx(alice, 'people'),
            subject: `<${ada}>`,
            predicate: RDF_TYPE,
          },
          {
            pod: alice,
            context: ctx(alice, 'team'),
            subject: `<${ada}>`,
            predicate: RDF_TYPE,
          },
        ],
      },
    ]);
    expect(found.images).toEqual([
      {
        predicate: `${S}image`,
        url: 'https://img.example/ada.jpg',
        evidence: [
          {
            pod: alice,
            context: ctx(alice, 'people'),
            subject: `<${ada}>`,
            predicate: `${S}image`,
          },
        ],
      },
    ]);
    expect(found.truncated).toBe(false);
  });

  it('groups the variants of a linked image node; the node is no address', async () => {
    const photo = 'https://people.example/ada/photo';
    const found = await facts(ada, alice, [
      [iri(ada), `${S}image`, iri(photo), ctx(alice, 'people')],
      [
        iri(photo),
        `${S}contentUrl`,
        iri('https://img.example/ada.jpg'),
        ctx(alice, 'media'),
      ],
      [
        iri(photo),
        `${S}thumbnailUrl`,
        iri('https://img.example/ada-s.jpg'),
        ctx(alice, 'media'),
      ],
      [iri(ada), `${S}image`, blank('b0'), ctx(alice, 'people')],
      [
        blank('b0'),
        `${S}contentUrl`,
        text('https://img.example/ada-2.jpg'),
        ctx(alice, 'people'),
      ],
    ]);
    expect(
      found.images.map(({ url, node, link }) => ({ url, node, link })),
    ).toEqual([
      { url: 'https://img.example/ada.jpg', node: photo, link: `${S}image` },
      { url: 'https://img.example/ada-s.jpg', node: photo, link: `${S}image` },
      {
        url: 'https://img.example/ada-2.jpg',
        // A blank node is keyed within its read only.
        node: expect.stringContaining('_:b0'),
        link: `${S}image`,
      },
      // The facts keep the direct value; the card's rule suppresses it.
      { url: photo, node: undefined, link: undefined },
    ]);
    // Both statements of the path are evidence, each in its own Context.
    expect(found.images[0]!.evidence.map((e) => e.context)).toEqual([
      ctx(alice, 'people'),
      ctx(alice, 'media'),
    ]);
    expect(found.images[2]!.evidence[1]!.subject).toBe('_:b0');
    const card = resourceCards([ada], [found], exampleRules).get(ada)!;
    expect(previewCandidates(card.images)).not.toContain(photo);
  });

  it('refuses unsafe image addresses and counts them', async () => {
    const values = [
      'http://img.example/a.jpg',
      'https://user:pw@img.example/a.jpg',
      'https://127.0.0.1/a.jpg',
      'https://0x7f.1/a.jpg',
      'https://[::1]/a.jpg',
      'https://intranet/a.jpg',
      'https://printer.local/a.jpg',
      'https://router.home.arpa/a.jpg',
      'https://localhost../a.jpg',
      'https://printer.local../a.jpg',
      'https://a..img.example/a.jpg',
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
    ];
    const found = await facts(
      ada,
      alice,
      values.map(
        (value) =>
          [iri(ada), `${S}image`, text(value), ctx(alice, 'people')] as const,
      ),
    );
    expect(found.images.every((match) => match.url === undefined)).toBe(true);
    const card = resourceCards([ada], [found], exampleRules).get(ada)!;
    expect(card.images).toEqual([]);
    expect(card.refused).toBe(values.length);
  });

  it('marks a read with more than 200 rows as truncated', async () => {
    const rows = Array.from(
      { length: 201 },
      (_, i) =>
        [
          iri(ada),
          RDF_TYPE,
          iri(`urn:type:${i}`),
          ctx(alice, 'people'),
        ] as const,
    );
    const found = await facts(ada, alice, rows);
    expect(found.truncated).toBe(true);
    expect(found.types).toHaveLength(200);
  });
});

describe('cards across sources', () => {
  it('chooses the rule by its order, whatever the order of sources or types', async () => {
    const event = await facts(ada, alice, [
      [iri(ada), RDF_TYPE, iri(`${S}Event`), ctx(alice, 'a')],
    ]);
    const person = await facts(ada, bob, [
      [iri(ada), RDF_TYPE, iri(`${S}Person`), ctx(bob, 'b')],
    ]);
    for (const order of [
      [event, person],
      [person, event],
    ])
      expect(resourceCards([ada], order, exampleRules).get(ada)?.rule).toBe(
        'person',
      );
    const untyped = resourceCards([talk], [], exampleRules).get(talk);
    expect(untyped?.rule).toBe('resource');
  });

  it('prefers values by path, then by source, and merges shared addresses', async () => {
    const photo = 'https://people.example/ada/photo';
    const fromAlice = await facts(ada, alice, [
      [
        iri(ada),
        `${S}image`,
        text('https://img.example/direct.jpg'),
        ctx(alice, 'a'),
      ],
      [iri(ada), `${S}image`, iri(photo), ctx(alice, 'a')],
      [
        iri(photo),
        `${S}contentUrl`,
        iri('https://img.example/ada.jpg'),
        ctx(alice, 'a'),
      ],
    ]);
    const fromBob = await facts(ada, bob, [
      [iri(ada), `${S}image`, iri(photo), ctx(bob, 'b')],
      [
        iri(photo),
        `${S}thumbnailUrl`,
        iri('https://img.example/ada-s.jpg'),
        ctx(bob, 'b'),
      ],
      [
        iri(ada),
        `${S}image`,
        text('https://img.example/ada.jpg#full'),
        ctx(bob, 'b'),
      ],
    ]);
    const card = resourceCards([ada], [fromAlice, fromBob], exampleRules).get(
      ada,
    )!;
    // The linked picture first (its path is declared first), thumbnail first.
    expect(
      card.images.map((image) => image.variants.map((v) => v.value)),
    ).toEqual([
      ['https://img.example/ada-s.jpg', 'https://img.example/ada.jpg'],
      ['https://img.example/direct.jpg'],
    ]);
    // The same address from both Pods is one variant with both sources.
    const original = card.images[0]!.variants[1]!;
    expect([...new Set(original.evidence.map((e) => e.pod))]).toEqual([
      alice,
      bob,
    ]);
    expect(previewCandidates(card.images)).toEqual([
      'https://img.example/ada-s.jpg',
      'https://img.example/ada.jpg',
      'https://img.example/direct.jpg',
    ]);
  });

  it('bounds pictures per card, keeping the preferred ones', async () => {
    const rows = Array.from(
      { length: 10 },
      (_, i) =>
        [
          iri(ada),
          `http://xmlns.com/foaf/0.1/depiction`,
          text(`https://img.example/${i}.jpg`),
          ctx(alice, 'a'),
        ] as const,
    );
    const card = resourceCards(
      [ada],
      [
        await facts(ada, alice, [
          ...rows,
          [
            iri(ada),
            `${S}image`,
            text('https://img.example/p.jpg'),
            ctx(alice, 'a'),
          ],
        ]),
      ],
      exampleRules,
    ).get(ada)!;
    expect(card.images).toHaveLength(MAX_IMAGES);
    // schema:image is declared before foaf:depiction; the sorted rows are not.
    expect(card.images[0]!.variants[0]!.value).toBe(
      'https://img.example/p.jpg',
    );
  });

  it('orders by declared predicate before the source', async () => {
    const fromAlice = await facts(ada, alice, [
      [
        iri(ada),
        'http://xmlns.com/foaf/0.1/img',
        text('https://img.example/a.jpg'),
        ctx(alice, 'a'),
      ],
    ]);
    const fromBob = await facts(ada, bob, [
      [iri(ada), `${S}image`, text('https://img.example/b.jpg'), ctx(bob, 'b')],
    ]);
    const card = resourceCards([ada], [fromAlice, fromBob], exampleRules).get(
      ada,
    )!;
    expect(previewCandidates(card.images)).toEqual([
      'https://img.example/b.jpg',
      'https://img.example/a.jpg',
    ]);
  });

  it('keeps blank nodes of two reads apart, even with equal labels', async () => {
    const read = () =>
      facts(ada, alice, [
        [iri(ada), `${S}image`, blank('b0'), ctx(alice, 'a')],
        [
          blank('b0'),
          `${S}contentUrl`,
          text(`https://img.example/${n++}.jpg`),
          ctx(alice, 'a'),
        ],
      ]);
    let n = 1;
    // For example two connections to the same Pod.
    const card = resourceCards(
      [ada],
      [await read(), await read()],
      exampleRules,
    ).get(ada)!;
    expect(
      card.images.map((image) => image.variants.map((v) => v.value)),
    ).toEqual([['https://img.example/1.jpg'], ['https://img.example/2.jpg']]);
  });

  it('suppresses a direct address only for a complete declared path', async () => {
    const photo = 'urn:v:photo';
    const rules: readonly CardRule[] = [
      {
        id: 'any',
        types: [],
        images: [
          [[photo], ['urn:v:thumbnail']],
          [['urn:v:icon'], ['urn:v:iconUrl']],
          [[photo]],
        ],
        dates: [],
      },
    ];
    const address = 'https://img.example/photo.jpg';
    // The query pairs every first step with every second step.
    const result = await select([
      [iri(ada), photo, iri(address), ctx(alice, 'a')],
      [
        iri(address),
        'urn:v:iconUrl',
        text('https://img.example/icon.jpg'),
        ctx(alice, 'a'),
      ],
    ]);
    const found = sourceFacts(result, ada, alice, rules);
    const card = resourceCards([ada], [found], rules).get(ada)!;
    expect(card.refused).toBe(0);
    expect(
      card.images.map((image) => image.variants.map((v) => v.value)),
    ).toEqual([[address]]);
  });

  it("suppresses a direct address only where the card's rule describes it", async () => {
    const photo = 'urn:v:photo';
    const rules: readonly CardRule[] = [
      { id: 'direct', types: ['urn:v:Direct'], images: [[[photo]]], dates: [] },
      {
        id: 'linked',
        types: [],
        images: [[[photo], ['urn:v:thumbnail']], [[photo]]],
        dates: [],
      },
    ];
    const address = 'https://img.example/photo.jpg';
    const rows = (type: string) =>
      select([
        [iri(ada), RDF_TYPE, iri(type), ctx(alice, 'a')],
        [iri(ada), photo, iri(address), ctx(alice, 'a')],
        [
          iri(address),
          'urn:v:thumbnail',
          text('https://img.example/t.jpg'),
          ctx(alice, 'a'),
        ],
      ]);
    const shown = async (type: string) => {
      const found = sourceFacts(await rows(type), ada, alice, rules);
      const card = resourceCards([ada], [found], rules).get(ada)!;
      return [
        card.rule,
        card.images.map((image) => image.variants.map((v) => v.value)),
      ];
    };
    // The direct rule has no path through the node: its address is the picture.
    expect(await shown('urn:v:Direct')).toEqual(['direct', [[address]]]);
    // The linked rule describes the node: its thumbnail is the picture.
    expect(await shown('urn:v:Other')).toEqual([
      'linked',
      [['https://img.example/t.jpg']],
    ]);
  });

  it("groups direct values by the card's rule only", async () => {
    const photo = 'urn:v:photo';
    const rules: readonly CardRule[] = [
      { id: 'photos', types: ['urn:v:Album'], images: [[[photo]]], dates: [] },
      // Unrelated to an album: it uses photo as a variant predicate.
      {
        id: 'other',
        types: ['urn:v:Other'],
        images: [[['urn:v:part'], [photo]]],
        dates: [],
      },
    ];
    const found = sourceFacts(
      await select([
        [iri(ada), RDF_TYPE, iri('urn:v:Album'), ctx(alice, 'a')],
        ...[1, 2, 3, 4].map(
          (n) =>
            [
              iri(ada),
              photo,
              iri(`https://img.example/${n}.jpg`),
              ctx(alice, 'a'),
            ] as const,
        ),
      ]),
      ada,
      alice,
      rules,
    );
    const card = resourceCards([ada], [found], rules).get(ada)!;
    expect(
      card.images.map((image) => image.variants.map((v) => v.value)),
    ).toEqual([
      ['https://img.example/1.jpg'],
      ['https://img.example/2.jpg'],
      ['https://img.example/3.jpg'],
      ['https://img.example/4.jpg'],
    ]);
  });

  it('shows an image resource as one picture, thumbnail first', async () => {
    const card = resourceCards(
      [ada],
      [
        await facts(ada, alice, [
          [iri(ada), RDF_TYPE, iri(`${S}ImageObject`), ctx(alice, 'a')],
          [
            iri(ada),
            `${S}contentUrl`,
            iri('https://img.example/full.jpg'),
            ctx(alice, 'a'),
          ],
          [
            iri(ada),
            `${S}thumbnailUrl`,
            iri('https://img.example/s.jpg'),
            ctx(alice, 'a'),
          ],
        ]),
      ],
      exampleRules,
    ).get(ada)!;
    expect(card.rule).toBe('image');
    expect(
      card.images.map((image) => image.variants.map((v) => v.value)),
    ).toEqual([['https://img.example/s.jpg', 'https://img.example/full.jpg']]);
  });

  it('follows an image link back to the resource itself', async () => {
    const card = resourceCards(
      [ada],
      [
        await facts(ada, alice, [
          [iri(ada), `${S}image`, iri(ada), ctx(alice, 'a')],
          [
            iri(ada),
            `${S}thumbnailUrl`,
            iri('https://img.example/s.jpg'),
            ctx(alice, 'a'),
          ],
        ]),
      ],
      exampleRules,
    ).get(ada)!;
    // The resource is described as an image; its IRI is no address.
    expect(previewCandidates(card.images)).toEqual([
      'https://img.example/s.jpg',
    ]);
  });

  it('merges pictures that a shared address connects, before the limit', async () => {
    const node = (name: string) => `https://people.example/ada/${name}`;
    const rows = [
      ...['a', 'b', 'c', 'd', 'e'].map(
        (name) =>
          [iri(ada), `${S}image`, iri(node(name)), ctx(alice, 'a')] as const,
      ),
      ...['a', 'b', 'c', 'd', 'e'].map(
        (name) =>
          [
            iri(node(name)),
            `${S}contentUrl`,
            iri(`https://img.example/${name}.jpg`),
            ctx(alice, 'a'),
          ] as const,
      ),
      // A and B share their thumbnail: one picture.
      [
        iri(node('a')),
        `${S}thumbnailUrl`,
        iri('https://img.example/ab-s.jpg'),
        ctx(alice, 'a'),
      ] as const,
      [
        iri(node('b')),
        `${S}thumbnailUrl`,
        iri('https://img.example/ab-s.jpg'),
        ctx(alice, 'a'),
      ] as const,
    ];
    const card = resourceCards(
      [ada],
      [await facts(ada, alice, rows)],
      exampleRules,
    ).get(ada)!;
    expect(
      card.images.map((image) => image.variants.map((v) => v.value)),
    ).toEqual([
      [
        'https://img.example/ab-s.jpg',
        'https://img.example/a.jpg',
        'https://img.example/b.jpg',
      ],
      ['https://img.example/c.jpg'],
      ['https://img.example/d.jpg'],
      ['https://img.example/e.jpg'],
    ]);
  });

  it('ranks an address by its best predicate when it appears under several', async () => {
    const photo = 'https://people.example/ada/photo';
    const card = resourceCards(
      [ada],
      [
        await facts(ada, alice, [
          [iri(ada), `${S}image`, iri(photo), ctx(alice, 'a')],
          ...['a', 'b', 'c', 'z'].map(
            (name) =>
              [
                iri(photo),
                `${S}contentUrl`,
                iri(`https://img.example/${name}.jpg`),
                ctx(alice, 'a'),
              ] as const,
          ),
          [
            iri(photo),
            `${S}thumbnailUrl`,
            iri('https://img.example/z.jpg'),
            ctx(alice, 'a'),
          ],
        ]),
      ],
      exampleRules,
    ).get(ada)!;
    expect(card.images[0]!.variants.map((v) => v.value)).toEqual([
      'https://img.example/z.jpg',
      'https://img.example/a.jpg',
      'https://img.example/b.jpg',
    ]);
  });

  it('keeps the preferred variants when a picture has more than three', async () => {
    const photo = 'https://people.example/ada/photo';
    const originals = await facts(ada, alice, [
      [iri(ada), `${S}image`, iri(photo), ctx(alice, 'a')],
      ...[1, 2, 3].map(
        (n) =>
          [
            iri(photo),
            `${S}contentUrl`,
            iri(`https://img.example/${n}.jpg`),
            ctx(alice, 'a'),
          ] as const,
      ),
    ]);
    // The thumbnail arrives from a later source.
    const thumbnail = await facts(ada, bob, [
      [iri(ada), `${S}image`, iri(photo), ctx(bob, 'b')],
      [
        iri(photo),
        `${S}thumbnailUrl`,
        iri('https://img.example/s.jpg'),
        ctx(bob, 'b'),
      ],
    ]);
    const card = resourceCards([ada], [originals, thumbnail], exampleRules).get(
      ada,
    )!;
    expect(
      card.images.map((image) => image.variants.map((v) => v.value)),
    ).toEqual([
      [
        'https://img.example/s.jpg',
        'https://img.example/1.jpg',
        'https://img.example/2.jpg',
      ],
    ]);
  });

  it('groups the variants of a blank image node, thumbnail first', async () => {
    const found = await facts(ada, alice, [
      [iri(ada), `${S}image`, blank('b0'), ctx(alice, 'a')],
      [
        blank('b0'),
        `${S}contentUrl`,
        text('https://img.example/full.jpg'),
        ctx(alice, 'a'),
      ],
      [
        blank('b0'),
        `${S}thumbnailUrl`,
        text('https://img.example/thumb.jpg'),
        ctx(alice, 'a'),
      ],
      [iri(ada), `${S}image`, blank('b1'), ctx(alice, 'a')],
      [
        blank('b1'),
        `${S}contentUrl`,
        text('https://img.example/other.jpg'),
        ctx(alice, 'a'),
      ],
    ]);
    const card = resourceCards([ada], [found], exampleRules).get(ada)!;
    expect(
      card.images.map((image) => image.variants.map((v) => v.value)),
    ).toEqual([
      ['https://img.example/thumb.jpg', 'https://img.example/full.jpg'],
      ['https://img.example/other.jpg'],
    ]);
  });

  it('keeps conflicting dates inspectable and merges equal ones', async () => {
    const fromAlice = await facts(talk, alice, [
      [iri(talk), RDF_TYPE, iri(`${S}Event`), ctx(alice, 'a')],
      [iri(talk), `${S}startDate`, date('2026-10-05'), ctx(alice, 'a')],
    ]);
    const fromBob = await facts(talk, bob, [
      [
        iri(talk),
        `http://schema.org/startDate`,
        date('2026-10-05'),
        ctx(bob, 'b'),
      ],
      [iri(talk), `${S}startDate`, date('2026-10-06'), ctx(bob, 'b')],
      [iri(talk), `${S}startDate`, text('2026-10-05'), ctx(bob, 'b')],
    ]);
    const card = resourceCards([talk], [fromAlice, fromBob], exampleRules).get(
      talk,
    )!;
    expect(
      card.dates.map((d) => [
        d.value.value,
        d.value.datatype ?? null,
        d.evidence.length,
      ]),
    ).toEqual([
      ['2026-10-05', `${XSD}date`, 2],
      ['2026-10-06', `${XSD}date`, 1],
      ['2026-10-05', null, 1],
    ]);
  });

  it('projects sameAs onto admitted roots only, and reverses with its source', async () => {
    const link = await facts(ada, bob, [
      [iri(ada), SAME_AS, iri(lovelace), ctx(bob, 'b')],
      [iri(ada), SAME_AS, iri('https://elsewhere.example/ada'), ctx(bob, 'b')],
    ]);
    const picture = await facts(lovelace, alice, [
      [
        iri(lovelace),
        `${S}image`,
        text('https://img.example/l.jpg'),
        ctx(alice, 'a'),
      ],
    ]);
    const joined = resourceCards(
      [ada, lovelace],
      [picture, link],
      exampleRules,
    );
    const card = joined.get(ada)!;
    expect(joined.get(lovelace)).toBe(card);
    expect(card.root).toBe(ada);
    expect(card.members).toEqual([ada, lovelace]);
    expect(card.sameAs).toEqual([
      {
        value: lovelace,
        evidence: [
          {
            pod: bob,
            context: ctx(bob, 'b'),
            subject: `<${ada}>`,
            predicate: SAME_AS,
          },
        ],
      },
    ]);
    // The picture keeps its own subject: the statements are not rewritten.
    expect(card.images[0]!.variants[0]!.evidence[0]!.subject).toBe(
      `<${lovelace}>`,
    );
    // The alias outside the admitted roots is not followed.
    expect(joined.has('https://elsewhere.example/ada')).toBe(false);
    // Without Bob's read, the two resources are separate again.
    const split = resourceCards([ada, lovelace], [picture], exampleRules);
    expect(split.get(ada)).not.toBe(split.get(lovelace));
    expect(split.get(ada)?.images).toEqual([]);
  });

  it('ignores facts of roots that are no longer admitted', async () => {
    const old = await facts(talk, alice, [
      [iri(talk), RDF_TYPE, iri(`${S}Event`), ctx(alice, 'a')],
    ]);
    const cards = resourceCards([ada], [old], exampleRules);
    expect([...cards.keys()]).toEqual([ada]);
    expect(cards.get(ada)?.types).toEqual([]);
  });
});

describe('image address', () => {
  it('accepts a named https host and drops the fragment', () => {
    expect(imageAddress('https://img.example/a.jpg#x')).toBe(
      'https://img.example/a.jpg',
    );
    expect(imageAddress('https://IMG.example./a.jpg?w=48')).toBe(
      'https://img.example./a.jpg?w=48',
    );
  });
});

describe('guide', () => {
  it('shows only code that the type-checked recipe contains verbatim', async () => {
    const { readFile } = await import('node:fs/promises');
    const read = (path: string) =>
      readFile(new URL(`../../../${path}`, import.meta.url), 'utf8');
    const guide = await read('docs/resource-cards.md');
    const recipe =
      (await read('examples/todo/recipes/resource-cards.ts')) +
      (await read('examples/todo/recipes/resource-card-view.tsx'));
    const blocks = [...guide.matchAll(/```tsx?\n([\s\S]*?)```/g)].map(
      (match) => match[1]!,
    );
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) expect(recipe).toContain(block);
  });
});
