import { describe, expect, it, vi } from 'vitest';
import {
  bearer,
  createPod,
  type FindOptions,
  type PodAuth,
  type PodFetch,
} from './index.js';

const base = 'https://pod.example/alice';
const tasks = `${base}/_system/contexts/tasks`;
const notes = `${base}/_system/contexts/notes`;
const url = `${base}/_system/find`;
const event = 'https://schema.org/Event';
const place = 'https://schema.org/Place';
const FIND_RESULT = 'https://schema.sempods.org/findResult';
const jsonLd = (body: unknown, type = 'application/ld+json') =>
  new Response(JSON.stringify(body), { headers: { 'content-type': type } });
const challenge = () =>
  new Response(null, {
    status: 401,
    headers: { 'www-authenticate': 'Bearer' },
  });
const sent = (fetch: ReturnType<typeof vi.fn<PodFetch>>, call = 0) =>
  JSON.parse(String(fetch.mock.calls[call]?.[1]?.body)) as unknown;

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

  it('keeps each named graph with its source Context and the nodes as answered', async () => {
    // Raw JSON-LD, not the canonical resource shape: `@type` shorthand and a
    // plain string value pass through unchanged.
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
        { context: tasks, nodes: [node], observations: [] },
        { context: notes, nodes: [{ '@id': node['@id'] }], observations: [] },
      ],
    });
    if (answer.kind !== 'ok') throw new Error(answer.kind);
    expect(Object.isFrozen(answer.body)).toBe(true);
    expect(Object.isFrozen(answer.body[0])).toBe(true);
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
      let credential = { authorization: 'Bearer old' };
      const auth: PodAuth = {
        credential: async () => credential,
        renew: async () => {
          credential = { authorization: 'Bearer new' };
          return true;
        },
      };
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
    ['a group without nodes', [{ '@id': tasks }], {}],
    ['a node that is not an object', [{ '@id': tasks, '@graph': ['x'] }], {}],
    ['a flat graph', { '@graph': [] }, {}],
    ['a default-graph node', [{ '@id': `${base}/e1` }], {}],
    [
      'a default-graph statement about a group',
      [{ '@id': tasks, '@type': ['x:y'], '@graph': [] }],
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
    ).rejects.toMatchObject({ reason: { code: 'response', problem: 'body' } });
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
    let credential = { authorization: 'Bearer old' };
    const auth: PodAuth = {
      credential: async () => credential,
      renew: async () => {
        credential = { authorization: 'Bearer new' };
        return true;
      },
    };
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
    ['a graph wrapper with a statement', { '@graph': [], 'x:p': 'v' }, {}],
    ['a node that is not an object', ['x'], {}],
    [
      'a statement for an empty downscope',
      [{ '@id': `${base}/e1` }],
      { contexts: [] },
    ],
  ])('rejects a flat answer with %s', async (_name, body, options) => {
    const fetch = vi.fn<PodFetch>(async () => jsonLd(body));
    await expect(
      createPod(base, { auth: bearer('test'), fetch }).findFlat('x', options),
    ).rejects.toMatchObject({ reason: { code: 'response', problem: 'body' } });
  });

  it('keeps a node with only stored sps:findResult values as answered', async () => {
    // Scalar JSON-LD values are not rewritten into arrays.
    const stored = {
      '@id': `${base}/e1`,
      [FIND_RESULT]: { '@id': `${base}/saved` },
    };
    const fetch = vi.fn<PodFetch>(async () =>
      jsonLd([{ '@id': tasks, '@graph': [stored] }]),
    );
    const answer = await createPod(base, { auth: bearer('test'), fetch }).find(
      'x',
    );
    if (answer.kind !== 'ok') throw new Error(answer.kind);
    expect(answer.body[0]!.nodes).toEqual([stored]);
    expect(answer.body[0]!.observations).toEqual([]);
  });

  it('reads an observation embedded in its link, and leaves a blank subject as answered', async () => {
    const hit = `${base}/e1`;
    const blank = { '@id': '_:b', [FIND_RESULT]: [{ '@id': '_:c' }] };
    const fetch = vi.fn<PodFetch>(async () =>
      jsonLd([
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
        blank,
      ]),
    );
    const answer = await createPod(base, {
      auth: bearer('test'),
      fetch,
    }).findFlat('konzert');
    if (answer.kind !== 'ok') throw new Error(answer.kind);
    expect(answer.body.nodes).toEqual([{ '@id': hit }, blank]);
    expect(answer.body.observations).toMatchObject([
      {
        links: [{ hit }],
        text: ['Konzert'],
        position: [3],
        engine: ['sparql-text'],
      },
      { links: [{ hit }], details: [], text: [] },
    ]);
    expect(Object.isFrozen(answer.body.observations[0])).toBe(true);
  });
});
