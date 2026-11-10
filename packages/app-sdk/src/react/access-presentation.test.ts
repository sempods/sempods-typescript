import { expect, it } from 'vitest';
import type { Connection } from '../runtime/types.js';
import { presentAccess, type AccessFacts } from './access-presentation.js';

const connected = (overrides: Partial<Connection> = {}): Connection => {
  const session = overrides.session ?? {
    kind: 'active',
    subject: 'urn:person',
  };
  return {
    id: 'alice',
    podUrl: 'https://pod.example/alice',
    clientKind: 'dynamic',
    session,
    // As the runtime publishes it under `signIn: 'required'`.
    reading:
      session.kind === 'active' || session.kind === 'renewing'
        ? 'session'
        : null,
    catalogue: { kind: 'unknown' },
    requestedScopes: [],
    requiredScopes: [],
    optionalScopes: [],
    grantedScopes: [],
    missingRequiredScopes: [],
    selectedContext: null,
    ...overrides,
  };
};
const base: AccessFacts = {
  state: { contextSelection: 'on-demand', preset: undefined },
  connection: connected(),
  podReadable: true,
  viewReadable: false,
  hasView: false,
  demand: 'none',
  manage: false,
  catalogueSettled: false,
};
type Decision = Partial<
  Pick<ReturnType<typeof presentAccess>, 'body' | 'visible' | 'notice'>
>;
const hidden: Decision = {
  visible: false,
  notice: false,
};
const connections: Decision = {
  body: 'connections',
  visible: true,
  notice: false,
};
const loading: Decision = { body: 'loading', visible: true, notice: false };

it.each<{ name: string; facts: Partial<AccessFacts>; expected: Decision }>([
  // Session and startup problems belong to the gate and the prompts.
  ...(
    [
      ['no connection', undefined],
      [
        'a signed-out connection',
        connected({ session: { kind: 'signed-out' } }),
      ],
      ['a restoring connection', connected({ session: { kind: 'restoring' } })],
      [
        'an ended session',
        connected({ session: { kind: 'ended', problem: 'expired' } }),
      ],
      [
        'a failed durable sign-out',
        connected({
          session: { kind: 'ended', problem: 'disconnected', saved: false },
        }),
      ],
      [
        'missing required scopes',
        connected({ missingRequiredScopes: ['tasks'] }),
      ],
    ] as const
  ).map(([what, connection]) => ({
    name: `${what} shows no inline Context surface`,
    facts: { connection, podReadable: false, demand: 'selection' as const },
    expected: hidden,
  })),
  { name: 'readable Pod overview hides access', facts: {}, expected: hidden },
  {
    name: 'renewing readable Pod keeps access hidden',
    facts: {
      connection: connected({
        session: { kind: 'renewing', subject: 'urn:person' },
      }),
    },
    expected: hidden,
  },
  {
    name: 'active Pod still awaiting its reader loads',
    facts: { podReadable: false },
    expected: loading,
  },
  {
    name: 'renewing Pod still awaiting its reader loads',
    facts: {
      podReadable: false,
      connection: connected({
        session: { kind: 'renewing', subject: 'urn:person' },
      }),
    },
    expected: loading,
  },
  {
    name: 'management explains missing required scopes',
    facts: {
      manage: true,
      podReadable: false,
      connection: connected({ missingRequiredScopes: ['tasks'] }),
    },
    expected: { ...connections, notice: true },
  },
  {
    name: 'read-only Context is usable',
    facts: {
      state: { ...base.state, contextSelection: 'required' },
      demand: 'selection',
      viewReadable: true,
      hasView: true,
      connection: connected({
        catalogue: {
          kind: 'ready',
          contexts: [
            {
              iri: 'urn:context',
              readable: true,
              writable: false,
              manageable: false,
            },
          ],
        },
        selectedContext: 'urn:context',
      }),
    },
    expected: hidden,
  },
  {
    name: 'explicit target discovery never demands selection',
    facts: { demand: 'discovery' },
    expected: hidden,
  },
  {
    name: 'explicit target discovery may load without a chooser',
    facts: {
      demand: 'discovery',
      connection: connected({ catalogue: { kind: 'loading' } }),
    },
    expected: hidden,
  },
  {
    name: 'explicit target discovery failure needs recovery',
    facts: {
      demand: 'discovery',
      connection: connected({ catalogue: { kind: 'failed' } }),
    },
    expected: { ...connections, notice: true },
  },
  {
    name: 'unused catalogue failure does not interrupt a Pod overview',
    facts: { connection: connected({ catalogue: { kind: 'failed' } }) },
    expected: hidden,
  },
  {
    name: 'first demanded catalogue is loading',
    facts: { demand: 'selection' },
    expected: loading,
  },
  {
    name: 'ready catalogue offers context choice',
    facts: {
      demand: 'selection',
      connection: connected({ catalogue: { kind: 'ready', contexts: [] } }),
    },
    expected: connections,
  },
  {
    name: 'missing preset context explains the limitation',
    facts: {
      demand: 'selection',
      connection: connected({ catalogue: { kind: 'ready', contexts: [] } }),
      state: {
        ...base.state,
        preset: {
          podUrl: 'https://pod.example/alice',
          contextIri: 'urn:context',
        },
      },
    },
    expected: { ...connections, notice: true },
  },
  {
    name: 'failed demanded catalogue needs recovery',
    facts: {
      demand: 'selection',
      connection: connected({ catalogue: { kind: 'failed' } }),
    },
    expected: { ...connections, notice: true },
  },
  {
    name: 'a settled catalogue reload keeps its controls',
    facts: {
      demand: 'selection',
      catalogueSettled: true,
      connection: connected({ catalogue: { kind: 'loading' } }),
    },
    expected: { ...connections, notice: true },
  },
  {
    name: 'management overrides initial loading',
    facts: { demand: 'selection', manage: true },
    expected: { ...connections, notice: true },
  },
  {
    name: 'management opens a readable overview',
    facts: { manage: true },
    expected: connections,
  },
  {
    name: 'first sign-in leaves without an inline surface',
    facts: {
      podReadable: false,
      connection: connected({ session: { kind: 'leaving' } }),
    },
    expected: hidden,
  },
  {
    name: 'reauthorization keeps usable access hidden',
    facts: {
      podReadable: false,
      connection: connected({
        session: { kind: 'leaving', subject: 'urn:person' },
      }),
    },
    expected: hidden,
  },
  {
    name: 'reauthorization hides catalogue recovery while leaving',
    facts: {
      demand: 'selection',
      connection: connected({
        session: { kind: 'leaving', subject: 'urn:person' },
        catalogue: { kind: 'failed' },
      }),
    },
    expected: hidden,
  },

  {
    name: 'open management shows leaving',
    facts: {
      manage: true,
      connection: connected({
        session: { kind: 'leaving', subject: 'urn:person' },
      }),
    },
    expected: { body: 'leaving', visible: true, notice: false },
  },
])('$name', ({ facts, expected }) => {
  expect(presentAccess({ ...base, ...facts })).toMatchObject(expected);
});

it.each([
  [{}, 'h1', true],
  [{ manage: true }, 'h2', false],
  [{ hasView: true }, 'h2', false],
  [{ headingLevel: 2 }, 'h2', false],
  [{ hasView: true, headingLevel: 1 }, 'h1', false],
] as const)('preserves the heading for %j', (facts, heading, namesApp) => {
  expect(presentAccess({ ...base, ...facts })).toMatchObject({
    heading,
    namesApp,
  });
});
