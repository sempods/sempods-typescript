import { describe, expect, it, vi } from 'vitest';
import { bearer, createPod, type FindOptions, type PodFetch } from './index.js';
import {
  answering,
  bodyRejected,
  FIND_RESULT,
  jsonLd,
  ok,
  renewing,
  sent,
  stable,
} from './find.helpers.test.js';

const base = 'https://pod.example/alice';
const tasks = `${base}/_system/contexts/tasks`;
const notes = `${base}/_system/contexts/notes`;
const url = `${base}/_system/find`;
const event = 'https://schema.org/Event';
const place = 'https://schema.org/Place';
const challenge = () =>
  new Response(null, {
    status: 401,
    headers: { 'www-authenticate': 'Bearer' },
  });

describe('Pod find requests', () => {
  it.each<[string, FindOptions, unknown]>([
    ['the whole readable Pod', {}, { text: 'konzert', include_contexts: true }],
    [
      'a Context subset and a limit',
      { contexts: [tasks, notes], limit: 7 },
      {
        text: 'konzert',
        include_contexts: true,
        contexts: [tasks, notes],
        limit: 7,
      },
    ],
    [
      'an explicitly empty downscope',
      { contexts: [] },
      { text: 'konzert', include_contexts: true, contexts: [] },
    ],
    [
      'exact types, each once',
      { types: [event, place, event] },
      { text: 'konzert', include_contexts: true, type: [event, place] },
    ],
    [
      'no types as any type',
      { types: [] },
      { text: 'konzert', include_contexts: true },
    ],
  ])('sends one POST for %s', async (_name, options, body) => {
    const fetch = vi.fn<PodFetch>(async () => jsonLd([]));
    const pod = createPod(base, { auth: bearer('test'), fetch });
    expect(await pod.find('konzert', options)).toEqual({
      kind: 'ok',
      body: [],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      url,
      expect.objectContaining({
        method: 'POST',
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
      }),
    );
    expect(sent(fetch)).toEqual(body);
    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get('accept')).toBe('application/ld+json');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('authorization')).toBe('Bearer test');
  });

  it('keeps each named graph with its source Context and normalizes its nodes', async () => {
    // Read by the RDF it encodes: `@type` shorthand and a plain string become
    // the canonical arrays; a node with only `@id` states nothing.
    const node = {
      '@id': 'https://pod.example/alice/e1',
      '@type': 'https://schema.org/MusicEvent',
      'https://schema.org/name': 'Konzert',
    };
    const fetch = vi.fn<PodFetch>(async () =>
      jsonLd(
        [
          { '@id': tasks, '@graph': [node] },
          { '@id': notes, '@graph': [{ '@id': node['@id'] }] },
        ],
        'application/json',
      ),
    );
    const answer = await createPod(base, { auth: bearer('test'), fetch }).find(
      'konzert',
      { contexts: [tasks, notes] },
    );
    expect(answer).toEqual({
      kind: 'ok',
      body: [
        {
          context: tasks,
          nodes: [
            {
              '@id': node['@id'],
              '@type': ['https://schema.org/MusicEvent'],
              'https://schema.org/name': [{ '@value': 'Konzert' }],
            },
          ],
          observations: [],
        },
        { context: notes, nodes: [], observations: [] },
      ],
    });
    if (answer.kind !== 'ok') throw new Error(answer.kind);
    expect(Object.isFrozen(answer.body)).toBe(true);
    expect(Object.isFrozen(answer.body[0])).toBe(true);
    expect(Object.isFrozen(answer.body[0]!.nodes[0])).toBe(true);
  });

  it.each([401, 403] as const)(
    'returns refusal %s, distinct from an empty answer',
    async (status) => {
      const fetch = vi.fn<PodFetch>(async () => new Response(null, { status }));
      const pod = createPod(base, { auth: bearer('test'), fetch });
      expect(await pod.find('konzert')).toEqual({ kind: 'refused', status });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each<[string, FindOptions]>([
    ['a Context subset', { contexts: [tasks] }],
    ['an empty downscope', { contexts: [] }],
  ])(
    'repeats the exact body with %s on the one resend, never unscoped',
    async (_name, options) => {
      const auth = renewing();
      const fetch = vi
        .fn<PodFetch>()
        .mockImplementationOnce(async () => challenge())
        .mockImplementationOnce(
          async () => new Response(null, { status: 500 }),
        );
      await expect(
        createPod(base, { auth, fetch }).find('konzert', options),
      ).rejects.toMatchObject({ reason: { code: 'http', status: 500 } });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(sent(fetch, 1)).toEqual(sent(fetch, 0));
      expect(sent(fetch, 1)).toMatchObject({ contexts: options.contexts });
      expect(
        new Headers(fetch.mock.calls[1]?.[1]?.headers).get('authorization'),
      ).toBe('Bearer new');
    },
  );

  it('maps cancellation and dispatch guards like other reads', async () => {
    const fetch = vi.fn<PodFetch>(async () => jsonLd([]));
    expect(
      await createPod(base, { auth: bearer('test'), fetch }).find('konzert', {
        signal: AbortSignal.abort(),
      }),
    ).toEqual({ kind: 'cancelled' });
    expect(
      await createPod(base, {
        auth: bearer('test'),
        fetch,
        beforeDispatch: () => false,
      }).find('konzert'),
    ).toEqual({ kind: 'stopped' });
    expect(fetch).not.toHaveBeenCalled();
    const controller = new AbortController();
    fetch.mockImplementationOnce(async () => {
      controller.abort();
      throw new Error('aborted');
    });
    expect(
      await createPod(base, { auth: bearer('test'), fetch }).find('konzert', {
        signal: controller.signal,
      }),
    ).toEqual({ kind: 'cancelled' });
  });

  it.each<[string, string, FindOptions, 'text' | 'context' | 'type' | 'limit']>(
    [
      ['blank text', ' \n ', {}, 'text'],
      [
        'a foreign Context',
        'x',
        { contexts: ['https://other.example/_system/contexts/a'] },
        'context',
      ],
      ['a resource IRI', 'x', { contexts: [`${base}/tasks/1`] }, 'context'],
      ['no list', 'x', { contexts: tasks as unknown as string[] }, 'context'],
      ['a zero limit', 'x', { limit: 0 }, 'limit'],
      ['a fractional limit', 'x', { limit: 1.5 }, 'limit'],
      ['an infinite limit', 'x', { limit: Infinity }, 'limit'],
      ['a blank type', 'x', { types: [' '] }, 'type'],
      ['a relative type', 'x', { types: ['Event'] }, 'type'],
      [
        'a malformed escape in a type',
        'x',
        { types: ['https://example.org/%GG'] },
        'type',
      ],
      [
        'types without a list',
        'x',
        { types: event as unknown as string[] },
        'type',
      ],
    ],
  )('refuses %s before sending', async (_name, text, options, argument) => {
    const fetch = vi.fn<PodFetch>(async () => jsonLd([]));
    await expect(
      createPod(base, { auth: bearer('test'), fetch }).find(text, options),
    ).rejects.toMatchObject({
      reason: { code: 'invalid-argument', argument },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each<[string, unknown, FindOptions]>([
    ['a group without a source Context', [{ '@graph': [] }], {}],
    [
      'a group of another Pod',
      [{ '@id': 'https://other.example/_system/contexts/a', '@graph': [] }],
      {},
    ],
    [
      'a group outside the requested Contexts',
      [
        { '@id': tasks, '@graph': [] },
        { '@id': notes, '@graph': [] },
      ],
      { contexts: [tasks] },
    ],
    [
      'any group for an empty downscope',
      [{ '@id': tasks, '@graph': [] }],
      { contexts: [] },
    ],
    [
      'a default-graph statement about a Context',
      [{ '@id': tasks, 'x:p': 'v' }],
      {},
    ],
    ['a node that is not an object', [{ '@id': tasks, '@graph': ['x'] }], {}],
    ['a flat graph', { '@graph': [{ '@id': `${base}/e1`, 'x:p': 'v' }] }, {}],
    ['a default-graph node', [{ '@id': `${base}/e1`, '@type': ['x:T'] }], {}],
    [
      'a named graph inside an embedded node',
      [
        {
          '@id': tasks,
          '@graph': [
            {
              '@id': `${base}/e1`,
              'x:p': [
                {
                  '@id': notes,
                  '@graph': [{ '@id': `${base}/e2`, 'x:q': 'v' }],
                },
              ],
            },
          ],
        },
      ],
      {},
    ],
    [
      'a local context that changes a key',
      [
        {
          '@id': tasks,
          '@graph': [
            {
              '@context': { found: FIND_RESULT },
              '@id': `${base}/e1`,
              found: [{ '@id': '_:m' }],
            },
          ],
        },
      ],
      {},
    ],
    [
      'a default-graph statement about a group',
      [{ '@id': tasks, '@type': ['x:y'], '@graph': [] }],
      {},
    ],
    [
      'a default-graph statement beside groups in a wrapper',
      {
        '@graph': [
          { '@id': tasks, '@graph': [] },
          { '@id': `${base}/e2`, 'x:p': 'v' },
        ],
      },
      {},
    ],
    [
      'a graph nested in a group',
      [{ '@id': tasks, '@graph': [{ '@id': notes, '@graph': [] }] }],
      {},
    ],
  ])('rejects the whole answer for %s', async (_name, body, options) => {
    const fetch = vi.fn<PodFetch>(async () => jsonLd(body));
    await expect(
      createPod(base, { auth: bearer('test'), fetch }).find('x', options),
    ).rejects.toMatchObject(bodyRejected);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects an answer that is not JSON-LD', async () => {
    const fetch = vi.fn<PodFetch>(
      async () =>
        new Response('<s> <p> "o" <g> .', {
          headers: { 'content-type': 'application/n-quads' },
        }),
    );
    await expect(
      createPod(base, { auth: bearer('test'), fetch }).find('x'),
    ).rejects.toMatchObject({
      reason: { code: 'response', problem: 'content-type' },
    });
  });

  it('sends the flat form without include_contexts, also on the one resend', async () => {
    const auth = renewing();
    const fetch = vi
      .fn<PodFetch>()
      .mockImplementationOnce(async () => challenge())
      .mockImplementationOnce(async () => jsonLd([]));
    expect(
      await createPod(base, { auth, fetch }).findFlat('konzert', {
        contexts: [],
        types: [event],
        limit: 3,
      }),
    ).toEqual({ kind: 'ok', body: { nodes: [], observations: [] } });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sent(fetch, 0)).toEqual({
      text: 'konzert',
      type: [event],
      contexts: [],
      limit: 3,
    });
    expect(sent(fetch, 1)).toEqual(sent(fetch, 0));
  });

  it.each<[string, unknown, FindOptions]>([
    ['a named graph', [{ '@id': tasks, '@graph': [] }], {}],
    [
      'a named graph inside a wrapper',
      { '@graph': [{ '@id': tasks, '@graph': [] }] },
      {},
    ],
    ['a graph wrapper with a statement', { '@graph': [], 'x:p': 'v' }, {}],
    ['a node that is not an object', ['x'], {}],
    [
      'a statement for an empty downscope',
      [{ '@id': `${base}/e1`, [FIND_RESULT]: [{ '@id': '_:m' }] }],
      { contexts: [] },
    ],
    [
      'a named graph inside an embedded node',
      [{ '@id': `${base}/e1`, 'x:p': { '@id': tasks, '@graph': [] } }],
      {},
    ],
    [
      'a default graph with a context that changes a key',
      { '@context': { '@vocab': 'x:' }, '@graph': [{ '@id': `${base}/e1` }] },
      {},
    ],
  ])('rejects a flat answer with %s', async (_name, body, options) => {
    const fetch = vi.fn<PodFetch>(async () => jsonLd(body));
    await expect(
      createPod(base, { auth: bearer('test'), fetch }).findFlat('x', options),
    ).rejects.toMatchObject(bodyRejected);
  });

  it('keeps a stored sps:findResult as pod data, in the canonical array form', async () => {
    const stored = {
      '@id': `${base}/e1`,
      [FIND_RESULT]: { '@id': `${base}/saved` },
    };
    const [group] = await ok(
      answering([{ '@id': tasks, '@graph': [stored] }], base).pod.find('x'),
    );
    expect(group).toEqual({
      context: tasks,
      nodes: [{ '@id': stored['@id'], [FIND_RESULT]: [stored[FIND_RESULT]] }],
      observations: [],
    });
  });

  it('reads an observation embedded in its link, and labels pod blank nodes per answer', async () => {
    const hit = `${base}/e1`;
    const { pod } = answering(
      [
        {
          '@id': hit,
          [FIND_RESULT]: [
            {
              'https://schema.org/text': [{ '@value': 'Konzert' }],
              'https://schema.sempods.org/engine': [
                { '@value': 'sparql-text' },
              ],
              'https://schema.org/position': [
                {
                  '@value': '3',
                  '@type': 'http://www.w3.org/2001/XMLSchema#integer',
                },
              ],
            },
            {},
          ],
        },
        { '@id': '_:b', [FIND_RESULT]: [{ '@id': '_:c' }] },
      ],
      base,
    );
    const answer = await ok(pod.findFlat('konzert'));
    // A blank subject is no hit: its link stays pod data, relabelled.
    expect(answer.nodes).toEqual([
      { '@id': hit },
      {
        '@id': expect.stringMatching(/^_:a\d+-bb$/),
        [FIND_RESULT]: [{ '@id': expect.stringMatching(/^_:a\d+-bc$/) }],
      },
    ]);
    expect(answer.observations).toMatchObject([
      {
        links: [{ hit }],
        text: ['Konzert'],
        position: [3],
        engine: ['sparql-text'],
      },
      { links: [{ hit }], details: [], text: [] },
    ]);
    expect(Object.isFrozen(answer.observations[0])).toBe(true);
    const again = await ok(pod.findFlat('konzert'));
    expect(again.nodes[1]!['@id']).not.toBe(answer.nodes[1]!['@id']);
  });

  it.each<[string, unknown, FindOptions]>([
    ['an empty object', {}, {}],
    ['an empty object for an empty downscope', {}, { contexts: [] }],
    ['an empty default graph', { '@graph': [] }, {}],
    [
      'nodes without statements',
      [{}, { '@id': `${base}/e1` }],
      { contexts: [] },
    ],
  ])('reads %s as no statement in both forms', async (_name, body, options) => {
    const { pod } = answering(body, base);
    expect(await pod.findFlat('x', options)).toEqual({
      kind: 'ok',
      body: { nodes: [], observations: [] },
    });
    expect(await pod.find('x', options)).toEqual({ kind: 'ok', body: [] });
  });

  it('keeps nonpositive positions out of the typed projection', async () => {
    const position = 'https://schema.org/position';
    const answer = await ok(
      answering(
        [
          {
            '@id': `${base}/e1`,
            [FIND_RESULT]: [
              {
                [position]: [
                  { '@value': 0 },
                  { '@value': -2 },
                  { '@value': 1 },
                ],
              },
            ],
          },
        ],
        base,
      ).pod.findFlat('x'),
    );
    const [observation] = answer.observations;
    expect(observation!.position).toEqual([1]);
    expect(observation!.details[0]!.node[position]).toHaveLength(3);
  });

  it('keeps a statement from one observation to another, by its id', async () => {
    const part = 'https://schema.org/isPartOf';
    const answer = await ok(
      answering(
        [
          { '@id': `${base}/e1`, [FIND_RESULT]: [{ '@id': '_:a' }] },
          { '@id': `${base}/e2`, [FIND_RESULT]: [{ '@id': '_:b' }] },
          { '@id': '_:a', [part]: [{ '@id': '_:b' }] },
        ],
        base,
      ).pod.findFlat('x'),
    );
    const [a, b] = answer.observations;
    expect(a!.details).toEqual([{ node: { [part]: [{ '@id': b!.id }] } }]);
    expect(a!.id).not.toBe(b!.id);
    expect(b!.details).toEqual([]);
  });
});

describe('Find answers read by the RDF they encode', () => {
  const one = `${base}/e1`;
  const two = `${base}/e2`;
  const about = 'https://schema.org/about';
  const name = 'https://schema.org/name';
  const text = (value: string) => ({
    'https://schema.org/text': [{ '@value': value }],
  });
  /** The same graph as a grouped and a flat answer. */
  const both = async (graph: unknown) => [
    await answering([{ '@id': tasks, '@graph': graph }], base).pod.find('x'),
    await answering(graph, base).pod.findFlat('x'),
  ];

  // Each row: one serialization, and the same statements written as separate
  // flattened nodes with plain arrays.
  it.each<[string, unknown, unknown]>([
    [
      'a link written with @reverse',
      [
        {
          '@id': '_:m',
          ...text('first'),
          '@reverse': {
            [FIND_RESULT]: [{ '@id': one, [name]: [{ '@value': 'One' }] }],
          },
        },
      ],
      [
        {
          '@id': one,
          [name]: [{ '@value': 'One' }],
          [FIND_RESULT]: [{ '@id': '_:m' }],
        },
        { '@id': '_:m', ...text('first') },
      ],
    ],
    [
      'a bare reverse link from an anonymous observation',
      [{ ...text('first'), '@reverse': { [FIND_RESULT]: { '@id': one } } }],
      [
        { '@id': one, [FIND_RESULT]: [{ '@id': '_:m' }] },
        { '@id': '_:m', ...text('first') },
      ],
    ],
    [
      '@set values of a link',
      [
        { '@id': one, [FIND_RESULT]: { '@set': [{ '@id': '_:m' }] } },
        { '@id': '_:m', ...text('first') },
      ],
      [
        { '@id': one, [FIND_RESULT]: [{ '@id': '_:m' }] },
        { '@id': '_:m', ...text('first') },
      ],
    ],
    [
      '@set values of a reverse link',
      [
        {
          '@id': '_:m',
          ...text('first'),
          '@reverse': { [FIND_RESULT]: [{ '@set': [{ '@id': one }] }] },
        },
      ],
      [
        { '@id': one, [FIND_RESULT]: [{ '@id': '_:m' }] },
        { '@id': '_:m', ...text('first') },
      ],
    ],
    [
      '@set-wrapped details and single values',
      [
        {
          '@id': one,
          [FIND_RESULT]: [
            {
              'https://schema.org/text': { '@set': [{ '@value': 'first' }] },
              'https://schema.org/position': [{ '@set': [{ '@value': 2 }] }],
              'https://schema.sempods.org/engine': { '@set': ['sparql-text'] },
            },
          ],
        },
      ],
      [
        { '@id': one, [FIND_RESULT]: [{ '@id': '_:m' }] },
        {
          '@id': '_:m',
          ...text('first'),
          'https://schema.org/position': [{ '@value': 2 }],
          'https://schema.sempods.org/engine': [{ '@value': 'sparql-text' }],
        },
      ],
    ],
    [
      'a hit embedded in another node',
      [
        {
          '@id': one,
          [about]: [
            {
              '@id': two,
              [name]: [{ '@value': 'Two' }],
              [FIND_RESULT]: [{ '@id': '_:m' }],
            },
          ],
        },
        { '@id': '_:m', ...text('first') },
      ],
      [
        { '@id': one, [about]: [{ '@id': two }] },
        {
          '@id': two,
          [name]: [{ '@value': 'Two' }],
          [FIND_RESULT]: [{ '@id': '_:m' }],
        },
        { '@id': '_:m', ...text('first') },
      ],
    ],
    [
      'an embedded observation that names a second hit with @reverse',
      [
        {
          '@id': one,
          [FIND_RESULT]: [
            {
              '@id': '_:m',
              ...text('first'),
              '@reverse': { [FIND_RESULT]: [{ '@id': two }] },
            },
          ],
        },
      ],
      [
        { '@id': one, [FIND_RESULT]: [{ '@id': '_:m' }] },
        { '@id': two, [FIND_RESULT]: [{ '@id': '_:m' }] },
        { '@id': '_:m', ...text('first') },
      ],
    ],
    [
      'a hit embedded in an observation, with its own observation',
      [
        {
          '@id': one,
          [FIND_RESULT]: [
            {
              '@id': '_:first',
              ...text('first'),
              [about]: [
                {
                  '@id': two,
                  [FIND_RESULT]: [{ '@id': '_:second', ...text('second') }],
                },
              ],
            },
          ],
        },
      ],
      [
        { '@id': one, [FIND_RESULT]: [{ '@id': '_:first' }] },
        { '@id': '_:first', ...text('first'), [about]: [{ '@id': two }] },
        { '@id': two, [FIND_RESULT]: [{ '@id': '_:second' }] },
        { '@id': '_:second', ...text('second') },
      ],
    ],
    [
      'a hit that names an observation with @reverse',
      [
        {
          '@id': one,
          [FIND_RESULT]: [
            {
              '@id': '_:first',
              ...text('first'),
              '@reverse': {
                [about]: [
                  {
                    '@id': two,
                    [FIND_RESULT]: [{ '@id': '_:second', ...text('second') }],
                  },
                ],
              },
            },
          ],
        },
      ],
      [
        { '@id': one, [FIND_RESULT]: [{ '@id': '_:first' }] },
        { '@id': '_:first', ...text('first') },
        {
          '@id': two,
          [about]: [{ '@id': '_:first' }],
          [FIND_RESULT]: [{ '@id': '_:second' }],
        },
        { '@id': '_:second', ...text('second') },
      ],
    ],
    [
      'a hit embedded in an observation through @set',
      [
        {
          '@id': one,
          [FIND_RESULT]: [
            {
              '@id': '_:m',
              [about]: {
                '@set': [{ '@id': two, [name]: [{ '@value': 'Two' }] }],
              },
            },
          ],
        },
      ],
      [
        { '@id': one, [FIND_RESULT]: [{ '@id': '_:m' }] },
        { '@id': '_:m', [about]: [{ '@id': two }] },
        { '@id': two, [name]: [{ '@value': 'Two' }] },
      ],
    ],
    [
      'a hit embedded in an observation through @list',
      [
        {
          '@id': one,
          [FIND_RESULT]: [
            {
              '@id': '_:m',
              [about]: {
                '@list': [{ '@id': two, [name]: [{ '@value': 'Two' }] }],
              },
            },
          ],
        },
      ],
      [
        { '@id': one, [FIND_RESULT]: [{ '@id': '_:m' }] },
        { '@id': '_:m', [about]: [{ '@list': [{ '@id': two }] }] },
        { '@id': two, [name]: [{ '@value': 'Two' }] },
      ],
    ],
    [
      '@included nodes and single values',
      {
        '@id': one,
        [name]: { '@value': 'One' },
        [FIND_RESULT]: { '@id': '_:m' },
        '@included': {
          '@id': '_:m',
          'https://schema.org/text': { '@value': 'first' },
        },
      },
      [
        {
          '@id': one,
          [name]: [{ '@value': 'One' }],
          [FIND_RESULT]: [{ '@id': '_:m' }],
        },
        { '@id': '_:m', ...text('first') },
      ],
    ],
  ])('reads %s like separate nodes', async (_name, variant, separate) => {
    const read = await both(variant);
    expect(read.every((answer) => answer.kind === 'ok')).toBe(true);
    expect(stable(read)).toEqual(stable(await both(separate)));
  });

  it('names every hit as a node and keeps statements about an observation in its details', async () => {
    // Anchors for the separate forms above: a hit known only by its link is a
    // node, and a statement naming an observation sits under @reverse.
    const [grouped, flat] = await both([
      { '@id': one, [FIND_RESULT]: [{ '@id': '_:first' }] },
      { '@id': '_:first', ...text('first') },
      {
        '@id': two,
        [about]: [{ '@id': '_:first' }],
        [FIND_RESULT]: [{ '@id': '_:second' }],
      },
    ]);
    expect(grouped).toMatchObject({
      kind: 'ok',
      body: [{ nodes: [{ '@id': one }, { '@id': two }] }],
    });
    expect(flat).toMatchObject({
      kind: 'ok',
      body: {
        nodes: [{ '@id': one }, { '@id': two }],
        observations: [
          {
            links: [{ hit: one }],
            text: ['first'],
            details: [
              {
                node: {
                  ...text('first'),
                  '@reverse': { [about]: [{ '@id': two }] },
                },
              },
            ],
          },
          { links: [{ hit: two }], details: [] },
        ],
      },
    });
  });

  it.each<[string, unknown, unknown, 'find' | 'findFlat']>([
    [
      'one node as the value of @graph, with contexts without effect',
      {
        '@context': {},
        '@id': tasks,
        '@graph': {
          '@id': one,
          '@context': [null, {}],
          [FIND_RESULT]: { '@id': '_:m' },
        },
      },
      [
        {
          '@id': tasks,
          '@graph': [{ '@id': one, [FIND_RESULT]: [{ '@id': '_:m' }] }],
        },
      ],
      'find',
    ],
    [
      'one node in the default-graph wrapper',
      {
        '@context': null,
        '@graph': { '@id': one, [FIND_RESULT]: { '@id': '_:m' } },
      },
      [{ '@id': one, [FIND_RESULT]: [{ '@id': '_:m' }] }],
      'findFlat',
    ],
    [
      'named groups inside a top-level @graph wrapper',
      {
        '@graph': [
          { '@id': tasks, '@graph': [{ '@id': one, '@type': [event] }] },
        ],
      },
      [{ '@id': tasks, '@graph': [{ '@id': one, '@type': [event] }] }],
      'find',
    ],
  ])(
    'reads %s like the plain document',
    async (_name, variant, plain, read) => {
      const answer = await answering(variant, base).pod[read]('x');
      expect(answer.kind).toBe('ok');
      expect(stable(answer)).toEqual(
        stable(await answering(plain, base).pod[read]('x')),
      );
    },
  );

  it('keeps a JSON null literal and two lists with the same members', async () => {
    const data = 'x:data';
    const tags = 'x:tags';
    const node = {
      '@id': one,
      [data]: [{ '@value': null, '@type': '@json' }],
      [tags]: [
        { '@list': [{ '@value': 'a' }] },
        { '@list': [{ '@value': 'a' }] },
      ],
    };
    const [grouped, flat] = await both([node]);
    expect(flat).toEqual({
      kind: 'ok',
      body: { nodes: [node], observations: [] },
    });
    expect(grouped).toMatchObject({ kind: 'ok', body: [{ nodes: [node] }] });
  });
});
