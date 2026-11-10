// @vitest-environment jsdom
/** The public RDF lookup recipe (#234), with its real parsers. */
import { describe, expect, it, vi } from 'vitest';
import { createLocale } from '@sempods/app-sdk';
import type { SparqlTerm } from '@sempods/client-sdk';
import {
  lookupPublicRdf,
  PUBLIC_RDF_ACCEPT,
  publicAddress,
  type PublicRdfOptions,
  type PublicStatement,
} from '../../../examples/todo/recipes/public-rdf.js';
import {
  commonVocabulary,
  describeValue,
} from '../../../examples/todo/recipes/rdf-values.js';

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const SCHEMA = 'https://schema.org/';
const IRI = 'https://data.example.org/resource/Berlin';

function answer(
  body: BodyInit | null,
  contentType: string | null,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  if (contentType) headers.set('content-type', contentType);
  return new Response(body, { status: 200, ...init, headers });
}

function serve(response: Response | (() => Response)) {
  return vi.fn<typeof fetch>(async () =>
    typeof response === 'function' ? response() : response,
  );
}

async function loaded(
  body: string,
  contentType: string,
  options: PublicRdfOptions = {},
): Promise<readonly PublicStatement[]> {
  const result = await lookupPublicRdf(IRI, {
    fetch: serve(answer(body, contentType)),
    ...options,
  });
  if (result.kind !== 'loaded') throw new Error(JSON.stringify(result));
  return result.statements;
}

const iri = (value: string): SparqlTerm => ({ type: 'iri', value });

/** A body that sends `first` and then never ends unless its reader is cancelled. */
function stalled(first: string, onCancel = () => {}) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(first));
    },
    cancel: onCancel,
  });
}

describe('public RDF lookup: request policy', () => {
  it('sends one credential-free GET with only a safelisted Accept', async () => {
    const fetch = serve(answer('', 'text/turtle'));
    const result = await lookupPublicRdf(IRI, { fetch });

    expect(result).toEqual({
      kind: 'loaded',
      source: IRI,
      contentType: 'text/turtle',
      statements: [],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(IRI);
    expect(init).toMatchObject({
      method: 'GET',
      credentials: 'omit',
      redirect: 'manual',
      referrerPolicy: 'no-referrer',
      mode: 'cors',
    });
    expect(init?.headers).toEqual({ accept: PUBLIC_RDF_ACCEPT });
    // CORS-safelisted Accept: at most 128 bytes, no unsafe bytes.
    expect(new TextEncoder().encode(PUBLIC_RDF_ACCEPT).length).toBeLessThan(
      129,
    );
    for (const char of PUBLIC_RDF_ACCEPT) {
      expect(char >= ' ' && char <= '~').toBe(true);
      expect('"():<>?@[\\]{}').not.toContain(char);
    }
  });

  it('requests the document of a hash IRI, without its fragment', async () => {
    const term = 'https://vocab.example.org/ns#City';
    const response = answer(
      '<#City> <http://www.w3.org/2000/01/rdf-schema#label> "City"@en .',
      'text/turtle',
    );
    // Browsers and Node report the response URL without the fragment.
    Object.defineProperty(response, 'url', {
      value: 'https://vocab.example.org/ns',
    });
    const fetch = serve(response);

    const result = await lookupPublicRdf(term, { fetch });

    expect(fetch.mock.calls[0]![0]).toBe('https://vocab.example.org/ns');
    expect(result).toMatchObject({
      kind: 'loaded',
      source: 'https://vocab.example.org/ns',
      statements: [{ subject: iri(term) }],
    });
  });

  it.each([
    ['not an IRI', 'invalid-iri'],
    ['http://data.example.org/a', 'unsupported-scheme'],
    ['ftp://data.example.org/a', 'unsupported-scheme'],
    ['https://user:secret@data.example.org/a', 'blocked-host'],
    ['https://localhost/a', 'blocked-host'],
    ['https://LOCALHOST./a', 'blocked-host'],
    ['https://pod.localhost/a', 'blocked-host'],
    ['https://printer.local/a', 'blocked-host'],
    ['https://db.internal/a', 'blocked-host'],
    ['https://nas.home.arpa/a', 'blocked-host'],
    ['https://intranet/a', 'blocked-host'],
    ['https://127.0.0.1/a', 'blocked-host'],
    ['https://2130706433/a', 'blocked-host'],
    ['https://0x7f.1/a', 'blocked-host'],
    ['https://0.0.0.0/a', 'blocked-host'],
    ['https://10.1.2.3/a', 'blocked-host'],
    ['https://100.64.0.1/a', 'blocked-host'],
    ['https://169.254.169.254/latest', 'blocked-host'],
    ['https://172.16.0.1/a', 'blocked-host'],
    ['https://172.31.255.255/a', 'blocked-host'],
    ['https://192.168.1.1/a', 'blocked-host'],
    ['https://224.0.0.1/a', 'blocked-host'],
    ['https://[::1]/a', 'blocked-host'],
    ['https://[::]/a', 'blocked-host'],
    ['https://[fd12:3456::1]/a', 'blocked-host'],
    ['https://[fc00::1]/a', 'blocked-host'],
    ['https://[fe80::1]/a', 'blocked-host'],
    ['https://[fec0::1]/a', 'blocked-host'],
    ['https://[::ffff:127.0.0.1]/a', 'blocked-host'],
    ['https://[::ffff:10.0.0.1]/a', 'blocked-host'],
    ['https://[64:ff9b::192.168.0.1]/a', 'blocked-host'],
    ['https://localhost../a', 'blocked-host'],
    ['https://localhost.localdomain/a', 'blocked-host'],
    ['https://192.0.0.1/a', 'blocked-host'],
    ['https://198.18.0.1/a', 'blocked-host'],
    ['https://[ff02::1]/a', 'blocked-host'],
    ['https://[::127.0.0.1]/a', 'blocked-host'],
    ['https://[::ffff:0:a00:1]/a', 'blocked-host'],
    ['https://[64:ff9b:1::1]/a', 'blocked-host'],
    ['https://[2002:7f00:1::]/a', 'blocked-host'],
  ])('refuses %s (%s)', (address, reason) => {
    expect(publicAddress(address)).toEqual({ kind: 'failed', reason });
  });

  it.each([
    ['http://data.example.org/a', 'unsupported-scheme'],
    ['https://169.254.169.254/latest', 'blocked-host'],
  ])('looks up %s not at all (%s)', async (address, reason) => {
    const fetch = serve(answer('', 'text/turtle'));

    expect(await lookupPublicRdf(address, { fetch })).toEqual({
      kind: 'failed',
      reason,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    'https://dbpedia.org/resource/Berlin',
    'https://fdroid.org/a',
    'https://fc.example.org/a',
    'https://172.32.0.1/a',
    'https://100.128.0.1/a',
    'https://[fc::1]/a',
    'https://[2001:db8::1]/a',
    'https://[::ffff:8.8.8.8]/a',
    'https://[2002:808:808::]/a',
    'https://192.0.1.1/a',
    'https://198.20.0.1/a',
  ])('allows the public address %s', (address) => {
    expect(publicAddress(address)).toMatchObject({ kind: 'allowed' });
  });
});

describe('public RDF lookup: bounded answers', () => {
  it.each([
    [
      'a 303 See Other',
      () =>
        answer(null, null, {
          status: 303,
          headers: { location: IRI + '.ttl' },
        }),
    ],
    [
      'an opaque redirect',
      () => {
        const response = answer('', 'text/turtle');
        Object.defineProperty(response, 'type', { value: 'opaqueredirect' });
        return response;
      },
    ],
    [
      'an answer from another URL',
      () => {
        const response = answer('', 'text/turtle');
        Object.defineProperty(response, 'url', {
          value: 'https://elsewhere.example.org/',
        });
        return response;
      },
    ],
  ])('refuses %s without a second request', async (_, response) => {
    const fetch = serve(response);

    expect(await lookupPublicRdf(IRI, { fetch })).toEqual({
      kind: 'failed',
      reason: 'redirect-blocked',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reports a status other than 200 with the status', async () => {
    expect(
      await lookupPublicRdf(IRI, {
        fetch: serve(answer('gone', 'text/plain', { status: 404 })),
      }),
    ).toEqual({ kind: 'failed', reason: 'http-error', status: 404 });
  });

  it('reports a rejected fetch, such as a CORS refusal, as network', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.reject(new TypeError('Failed to fetch')),
    );

    expect(await lookupPublicRdf(IRI, { fetch })).toEqual({
      kind: 'failed',
      reason: 'network',
    });
  });

  it('refuses an announced oversize body without reading it', async () => {
    const cancel = vi.fn();
    const response = answer(stalled('<a> <b> <c> .', cancel), 'text/turtle', {
      headers: { 'content-length': '2048' },
    });

    expect(
      await lookupPublicRdf(IRI, { fetch: serve(response), maxBytes: 1024 }),
    ).toEqual({
      kind: 'failed',
      reason: 'too-large',
    });
    expect(cancel).toHaveBeenCalled();
  });

  it('stops reading past the byte cap whatever Content-Length claims', async () => {
    const cancel = vi.fn();
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        controller.enqueue(new Uint8Array(512));
      },
      cancel,
    });
    const response = answer(body, 'text/turtle', {
      headers: { 'content-length': '10' },
    });

    expect(
      await lookupPublicRdf(IRI, { fetch: serve(response), maxBytes: 1024 }),
    ).toEqual({
      kind: 'failed',
      reason: 'too-large',
    });
    expect(cancel).toHaveBeenCalled();
    expect(sent).toBeLessThan(5);
  });

  it('times out when the body stalls after the headers', async () => {
    // Like a real fetch, the body errors once the request's signal aborts.
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode('@prefix ex: <https://ex.org/> .'),
          );
          init?.signal?.addEventListener('abort', () =>
            controller.error(new DOMException('aborted', 'AbortError')),
          );
        },
      });
      return answer(body, 'text/turtle');
    });

    expect(await lookupPublicRdf(IRI, { fetch, timeoutMs: 20 })).toEqual({
      kind: 'failed',
      reason: 'timeout',
    });
  });

  it('times out when the headers never arrive', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      (_url, init) =>
        new Promise((_, reject) =>
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          ),
        ),
    );

    expect(await lookupPublicRdf(IRI, { fetch, timeoutMs: 20 })).toEqual({
      kind: 'failed',
      reason: 'timeout',
    });
  });

  it('is cancelled by the caller, before and during the request', async () => {
    const before = new AbortController();
    before.abort();
    const unused = serve(answer('', 'text/turtle'));
    expect(
      await lookupPublicRdf(IRI, { fetch: unused, signal: before.signal }),
    ).toEqual({
      kind: 'cancelled',
    });
    expect(unused).not.toHaveBeenCalled();

    const during = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>(
      (_url, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
          during.abort();
        }),
    );
    expect(
      await lookupPublicRdf(IRI, { fetch, signal: during.signal }),
    ).toEqual({
      kind: 'cancelled',
    });
  });

  it.each([
    ['application/rdf+xml', '<rdf:RDF/>'],
    ['application/json', '{}'],
    ['text/plain', '<a> <b> <c> .'],
    ['constructor', '<a> <b> <c> .'],
    [null, '<a> <b> <c> .'],
  ])('refuses the content type %s', async (contentType, body) => {
    expect(
      await lookupPublicRdf(IRI, { fetch: serve(answer(body, contentType)) }),
    ).toEqual({
      kind: 'failed',
      reason: 'unsupported-type',
    });
  });

  it.each([
    ['text/turtle', '<a> <b> "unterminated .'],
    ['application/ld+json', '{"@id": '],
    ['application/ld+json', '{"@context": 5}'],
    // A top-level string would otherwise be loaded as a document URL.
    ['application/ld+json', '"https://schema.org"'],
    ['text/html', '<script type="application/ld+json">{ nope</script>'],
  ])(
    'reports an unparseable %s body as parse-failed',
    async (contentType, body) => {
      expect(
        await lookupPublicRdf(IRI, { fetch: serve(answer(body, contentType)) }),
      ).toEqual({
        kind: 'failed',
        reason: 'parse-failed',
      });
    },
  );
});

describe('public RDF lookup: parsed statements', () => {
  it('keeps IRIs, blank nodes and typed and language-tagged literals exact', async () => {
    const statements = await loaded(
      [
        `<${IRI}> <${RDFS_LABEL}> "Berlin"@de .`,
        `<${IRI}> <${RDFS_LABEL}> "Berlin"^^<${XSD}string> .`,
        `<${IRI}> <${SCHEMA}population> "3850809"^^<${XSD}integer> .`,
        `<${IRI}> <${SCHEMA}foundingDate> "1237"^^<${XSD}gYear> .`,
        `<${IRI}> <${SCHEMA}sameAs> <http://data.example.org/resource/Berlin> .`,
        `<${IRI}> <${SCHEMA}geo> _:g .`,
        `_:g <${SCHEMA}latitude> "52.52"^^<${XSD}decimal> .`,
      ].join('\n'),
      'application/n-triples; charset=utf-8',
    );

    expect(statements).toEqual([
      {
        subject: iri(IRI),
        predicate: iri(RDFS_LABEL),
        object: { type: 'literal', value: 'Berlin', language: 'de' },
      },
      {
        subject: iri(IRI),
        predicate: iri(RDFS_LABEL),
        object: { type: 'literal', value: 'Berlin' },
      },
      {
        subject: iri(IRI),
        predicate: iri(`${SCHEMA}population`),
        object: {
          type: 'literal',
          value: '3850809',
          datatype: `${XSD}integer`,
        },
      },
      {
        subject: iri(IRI),
        predicate: iri(`${SCHEMA}foundingDate`),
        object: { type: 'literal', value: '1237', datatype: `${XSD}gYear` },
      },
      // Exact identity: http and https stay different IRIs.
      {
        subject: iri(IRI),
        predicate: iri(`${SCHEMA}sameAs`),
        object: iri('http://data.example.org/resource/Berlin'),
      },
      {
        subject: iri(IRI),
        predicate: iri(`${SCHEMA}geo`),
        object: { type: 'blank', value: expect.any(String) },
      },
      {
        subject: { type: 'blank', value: expect.any(String) },
        predicate: iri(`${SCHEMA}latitude`),
        object: { type: 'literal', value: '52.52', datatype: `${XSD}decimal` },
      },
    ]);
    expect(statements[5]!.object).toEqual(statements[6]!.subject);
  });

  it('resolves relative Turtle IRIs against the source and parses TriG', async () => {
    const turtle = await loaded(
      `@prefix s: <${SCHEMA}> .\n<> s:name "Berlin"@de ; s:containedIn <../Germany> .`,
      'TEXT/Turtle',
    );
    expect(turtle).toEqual([
      {
        subject: iri(IRI),
        predicate: iri(`${SCHEMA}name`),
        object: { type: 'literal', value: 'Berlin', language: 'de' },
      },
      {
        subject: iri(IRI),
        predicate: iri(`${SCHEMA}containedIn`),
        object: iri('https://data.example.org/Germany'),
      },
    ]);

    const trig = await loaded(
      `<https://ex.org/g> { <${IRI}> <${SCHEMA}name> "Berlin" . }\n` +
        `<https://ex.org/h> { <${IRI}> <${SCHEMA}name> "Berlin" . }`,
      'application/trig',
    );
    // Graph names are dropped; the same triple in two graphs is kept once.
    expect(trig).toEqual([
      {
        subject: iri(IRI),
        predicate: iri(`${SCHEMA}name`),
        object: { type: 'literal', value: 'Berlin' },
      },
    ]);
  });

  it.each([
    ['text/turtle', `<${IRI}> <${RDFS_LABEL}> "Berlin"@ar--rtl .`],
    [
      'application/ld+json',
      JSON.stringify({
        '@id': IRI,
        [RDFS_LABEL]: {
          '@value': 'Berlin',
          '@language': 'ar',
          '@direction': 'rtl',
        },
      }),
    ],
  ])(
    'keeps a %s base direction whole as an unsupported term',
    async (contentType, body) => {
      const [statement] = await loaded(body, contentType);

      expect(statement!.object).toEqual({
        type: 'unsupported',
        term: {
          type: 'literal',
          value: 'Berlin',
          'xml:lang': 'ar',
          'its:dir': 'rtl',
        },
      });
    },
  );

  it.each([
    [
      'an i18n datatype from Turtle',
      'text/turtle',
      `<${IRI}> <${RDFS_LABEL}> "x"^^<https://www.w3.org/ns/i18n#en_rtl> .`,
      'https://www.w3.org/ns/i18n#en_rtl',
    ],
    [
      'an i18n-like datatype that is no direction',
      'text/turtle',
      `<${IRI}> <${RDFS_LABEL}> "x"^^<https://www.w3.org/ns/i18n#en_custom> .`,
      'https://www.w3.org/ns/i18n#en_custom',
    ],
    [
      'a JSON-LD literal of an i18n-like datatype that is no direction',
      'application/ld+json',
      JSON.stringify({
        '@id': IRI,
        [RDFS_LABEL]: {
          '@value': 'x',
          '@type': 'https://www.w3.org/ns/i18n#en_custom',
        },
      }),
      'https://www.w3.org/ns/i18n#en_custom',
    ],
    [
      'a JSON-LD @direction without a language',
      'application/ld+json',
      JSON.stringify({
        '@id': IRI,
        [RDFS_LABEL]: { '@value': 'x', '@direction': 'rtl' },
      }),
      'https://www.w3.org/ns/i18n#_rtl',
    ],
  ])('keeps %s as a typed literal', async (_, contentType, body, datatype) => {
    const [statement] = await loaded(body, contentType);

    expect(statement!.object).toEqual({
      type: 'literal',
      value: 'x',
      datatype,
    });
  });

  it('keeps an RDF 1.2 triple term whole as an unsupported term', async () => {
    const statements = await loaded(
      `<${IRI}> <${SCHEMA}subjectOf> <<( <https://s.example.org/a> <${RDFS_LABEL}> "a"@en )>> .`,
      'text/turtle',
    );

    expect(statements).toEqual([
      {
        subject: iri(IRI),
        predicate: iri(`${SCHEMA}subjectOf`),
        object: {
          type: 'unsupported',
          term: {
            type: 'triple',
            value: {
              subject: { type: 'uri', value: 'https://s.example.org/a' },
              predicate: { type: 'uri', value: RDFS_LABEL },
              object: { type: 'literal', value: 'a', 'xml:lang': 'en' },
            },
          },
        },
      },
    ]);
  });

  it('reads JSON-LD with an inline context, @graph, references and embedded nodes', async () => {
    const statements = await loaded(
      JSON.stringify({
        '@context': { s: SCHEMA, name: { '@id': 's:name', '@language': 'de' } },
        '@graph': [
          {
            '@id': IRI,
            name: 'Berlin',
            's:containedIn': {
              '@id': 'https://data.example.org/resource/Germany',
            },
            's:geo': {
              's:latitude': { '@value': '52.52', '@type': `${XSD}decimal` },
            },
          },
          {
            '@id': 'https://data.example.org/resource/Germany',
            name: 'Deutschland',
          },
        ],
      }),
      'application/ld+json',
    );

    expect(statements).toEqual(
      expect.arrayContaining([
        {
          subject: iri(IRI),
          predicate: iri(`${SCHEMA}name`),
          object: { type: 'literal', value: 'Berlin', language: 'de' },
        },
        {
          subject: iri(IRI),
          predicate: iri(`${SCHEMA}containedIn`),
          object: iri('https://data.example.org/resource/Germany'),
        },
        {
          subject: iri('https://data.example.org/resource/Germany'),
          predicate: iri(`${SCHEMA}name`),
          object: { type: 'literal', value: 'Deutschland', language: 'de' },
        },
        {
          subject: { type: 'blank', value: expect.any(String) },
          predicate: iri(`${SCHEMA}latitude`),
          object: {
            type: 'literal',
            value: '52.52',
            datatype: `${XSD}decimal`,
          },
        },
      ]),
    );
    expect(statements).toHaveLength(5);
  });

  it('keeps the lexical form of a JSON-LD xsd:double string', async () => {
    const statements = await loaded(
      JSON.stringify({
        '@context': {
          xsd: XSD,
          ratio: { '@id': `${SCHEMA}ratio`, '@type': 'xsd:double' },
        },
        '@id': IRI,
        ratio: '01.00',
        [`${SCHEMA}value`]: [
          { '@value': '1e1', '@type': `${XSD}double` },
          { '@value': 1.5 },
        ],
      }),
      'application/ld+json',
    );

    expect(statements.map((s) => s.object)).toEqual(
      expect.arrayContaining([
        { type: 'literal', value: '01.00', datatype: `${XSD}double` },
        { type: 'literal', value: '1e1', datatype: `${XSD}double` },
        // A JSON number has no lexical form; JSON-LD gives it the canonical one.
        { type: 'literal', value: '1.5E0', datatype: `${XSD}double` },
      ]),
    );
    expect(statements).toHaveLength(3);
  });

  it('leaves the content of a JSON literal alone', async () => {
    const payload = { '@value': '01.00', '@type': `${XSD}double` };
    const [statement] = await loaded(
      JSON.stringify({
        '@id': IRI,
        [`${SCHEMA}value`]: { '@value': payload, '@type': '@json' },
      }),
      'application/ld+json',
    );

    expect(statement!.object).toEqual({
      type: 'literal',
      value: JSON.stringify({ '@type': `${XSD}double`, '@value': '01.00' }),
      datatype: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#JSON',
    });
  });

  it('tells an explicit i18n datatype from a JSON-LD @direction', async () => {
    const statements = await loaded(
      JSON.stringify({
        '@id': IRI,
        [RDFS_LABEL]: [
          { '@value': 'x', '@type': 'https://www.w3.org/ns/i18n#en_rtl' },
          { '@value': 'x', '@language': 'en', '@direction': 'rtl' },
        ],
      }),
      'application/ld+json',
    );

    expect(statements.map((s) => s.object)).toEqual(
      expect.arrayContaining([
        {
          type: 'literal',
          value: 'x',
          datatype: 'https://www.w3.org/ns/i18n#en_rtl',
        },
        {
          type: 'unsupported',
          term: {
            type: 'literal',
            value: 'x',
            'xml:lang': 'en',
            'its:dir': 'rtl',
          },
        },
      ]),
    );
    expect(statements).toHaveLength(2);
  });

  it('merges the statements of JSON-LD named graphs', async () => {
    const statements = await loaded(
      JSON.stringify({
        '@id': 'https://data.example.org/graph',
        '@graph': [{ '@id': IRI, [RDFS_LABEL]: 'Berlin' }],
      }),
      'application/ld+json',
    );

    expect(statements).toEqual([
      {
        subject: iri(IRI),
        predicate: iri(RDFS_LABEL),
        object: { type: 'literal', value: 'Berlin' },
      },
    ]);
  });

  it('never fetches a remote JSON-LD context; bundled contexts resolve by exact URL', async () => {
    const document = JSON.stringify({
      '@context': 'https://schema.org',
      '@id': IRI,
      name: 'Berlin',
    });
    const fetch = serve(() => answer(document, 'application/ld+json'));

    expect(await lookupPublicRdf(IRI, { fetch })).toEqual({
      kind: 'failed',
      reason: 'remote-context',
    });
    expect(
      await lookupPublicRdf(IRI, {
        fetch,
        contexts: {
          'https://schema.org/': { '@context': { '@vocab': SCHEMA } },
        },
      }),
    ).toEqual({ kind: 'failed', reason: 'remote-context' });
    expect(fetch).toHaveBeenCalledTimes(2);

    const result = await lookupPublicRdf(IRI, {
      fetch,
      contexts: { 'https://schema.org': { '@context': { '@vocab': SCHEMA } } },
    });
    expect(result).toMatchObject({
      kind: 'loaded',
      statements: [
        {
          subject: iri(IRI),
          predicate: iri(`${SCHEMA}name`),
          object: { type: 'literal', value: 'Berlin' },
        },
      ],
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('reads all JSON-LD scripts of an HTML page as one dataset', async () => {
    const page = `<!doctype html><html><head>
      <script type="application/ld+json">
        { "@context": { "rdfs": "http://www.w3.org/2000/01/rdf-schema#" },
          "@id": "${IRI}", "rdfs:label": { "@value": "Berlin", "@language": "en" },
          "rdfs:seeAlso": { "@id": "_:x" } }
      </script>
      <script type="Application/LD+JSON; charset=utf-8">
        [{ "@id": "_:x", "${RDFS_LABEL}": "described in another script" }]
      </script>
      <script type="application/json">{ "@id": "${IRI}", "${RDFS_LABEL}": "ignored" }</script>
    </head></html>`;

    const result = await lookupPublicRdf(IRI, {
      fetch: serve(answer(page, 'text/html; charset=utf-8')),
    });

    if (result.kind !== 'loaded') throw new Error(JSON.stringify(result));
    expect(result.contentType).toBe('text/html');
    const by = (predicate: string) =>
      result.statements.filter(
        (s) => s.predicate.type === 'iri' && s.predicate.value === predicate,
      );
    expect(by(RDFS_LABEL)).toHaveLength(2);
    const [seeAlso] = by('http://www.w3.org/2000/01/rdf-schema#seeAlso');
    // JSON-LD 1.1: `_:x` in two scripts of one page names one node.
    expect(by(RDFS_LABEL)).toEqual(
      expect.arrayContaining([
        {
          subject: iri(IRI),
          predicate: iri(RDFS_LABEL),
          object: { type: 'literal', value: 'Berlin', language: 'en' },
        },
        {
          subject: seeAlso!.object,
          predicate: iri(RDFS_LABEL),
          object: { type: 'literal', value: 'described in another script' },
        },
      ]),
    );
    expect(seeAlso!.object.type).toBe('blank');
  });

  it("resolves JSON-LD in HTML against the page's base element", async () => {
    const page = `<!doctype html><html><head>
      <base href="/vocab/">
      <script type="application/ld+json">{ "@id": "item", "${RDFS_LABEL}": "Item" }</script>
    </head></html>`;

    expect(await loaded(page, 'text/html')).toEqual([
      {
        subject: iri('https://data.example.org/vocab/item'),
        predicate: iri(RDFS_LABEL),
        object: { type: 'literal', value: 'Item' },
      },
    ]);
  });

  it('parses XHTML as XML, with CDATA and character references', async () => {
    const page = `<?xml version="1.0"?>
      <html xmlns="http://www.w3.org/1999/xhtml"><head>
      <script type="application/ld+json"><![CDATA[
        { "@id": "${IRI}", "${RDFS_LABEL}": "Berlin & Brandenburg" }
      ]]></script>
      <script type="application/ld+json">{ "@id": "${IRI}", "${SCHEMA}name": "A &amp; B" }</script>
      </head></html>`;

    expect(await loaded(page, 'application/xhtml+xml')).toEqual([
      {
        subject: iri(IRI),
        predicate: iri(RDFS_LABEL),
        object: { type: 'literal', value: 'Berlin & Brandenburg' },
      },
      {
        subject: iri(IRI),
        predicate: iri(`${SCHEMA}name`),
        object: { type: 'literal', value: 'A & B' },
      },
    ]);
    expect(
      await lookupPublicRdf(IRI, {
        fetch: serve(answer('<html><head></html>', 'application/xhtml+xml')),
      }),
    ).toEqual({ kind: 'failed', reason: 'parse-failed' });
  });

  it('reads a top-level JSON-LD array beyond the argument limit', async () => {
    const nodes = Array.from({ length: 150_000 }, () => ({}));
    nodes.push({ '@id': IRI, [RDFS_LABEL]: 'last' } as never);

    expect(await loaded(JSON.stringify(nodes), 'application/ld+json')).toEqual([
      {
        subject: iri(IRI),
        predicate: iri(RDFS_LABEL),
        object: { type: 'literal', value: 'last' },
      },
    ]);
  });

  it('reads a page without JSON-LD, even one reading "too-large", as empty', async () => {
    expect(await loaded('too-large', 'text/html')).toEqual([]);
  });

  it('is cancelled when the caller aborts while the body is parsed', async () => {
    const lookup = new AbortController();
    const contexts = {
      get 'https://context.example.org/'() {
        lookup.abort();
        return { '@context': { '@vocab': SCHEMA } };
      },
    };
    const document = JSON.stringify({
      '@context': 'https://context.example.org/',
      '@id': IRI,
      name: 'Berlin',
    });

    expect(
      await lookupPublicRdf(IRI, {
        fetch: serve(answer(document, 'application/ld+json')),
        signal: lookup.signal,
        contexts,
      }),
    ).toEqual({ kind: 'cancelled' });
  });

  it('feeds the RDF value recipe unchanged', async () => {
    const statements = await loaded(
      `<${IRI}> <${RDFS_LABEL}> "Berlin"@de ; <${SCHEMA}population> "3850809"^^<${XSD}integer> .`,
      'text/turtle',
    );
    const { format, language } = createLocale({
      locale: 'de-DE',
      timeZone: 'Europe/Berlin',
    });

    const [label, population] = statements.map((s) =>
      describeValue(s.object, {
        format,
        language,
        vocabulary: commonVocabulary,
        predicate: s.predicate.type === 'iri' ? s.predicate.value : undefined,
        texts: {
          blank: 'Unbenannter Knoten',
          unsupported: 'Nicht unterstützt',
        },
      }),
    );

    expect(label).toMatchObject({
      text: 'Berlin',
      language: 'de',
      exact: '"Berlin"@de',
    });
    expect(population).toMatchObject({
      text: '3850809',
      exact: `"3850809"^^<${XSD}integer>`,
    });
  });
});
