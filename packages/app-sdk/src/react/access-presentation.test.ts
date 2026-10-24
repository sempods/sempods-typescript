import { expect, it } from 'vitest';
import type { Connection } from '../runtime/types.js';
import { presentAccess, type AccessFacts } from './access-presentation.js';

const connected = (overrides: Partial<Connection> = {}): Connection => ({
  id: 'alice',
  podUrl: 'https://pod.example/alice',
  clientKind: 'dynamic',
  session: { kind: 'active', subject: 'urn:person' },
  catalogue: { kind: 'unknown' },
  requestedScopes: [],
  requiredScopes: [],
  optionalScopes: [],
  grantedScopes: [],
  missingRequiredScopes: [],
  selectedContext: null,
  ...overrides,
});
const base: AccessFacts = {
  state: {
    startup: { interaction: 'none', storage: 'durable', unreadable: [] },
    startupError: undefined,
    callbackNotice: false,
    contextSelection: 'on-demand',
    preset: undefined,
  },
  connection: connected(),
  podReadable: true,
  viewReadable: false,
  hasView: false,
  demand: 'none',
  manage: false,
  catalogueSettled: false,
  retry: false,
};
type Decision = Pick<
  ReturnType<typeof presentAccess>,
  'body' | 'visible' | 'notice'
>;
const hidden: Decision = { body: 'none', visible: false, notice: false };
const connections: Decision = {
  body: 'connections',
  visible: true,
  notice: false,
};
const loading: Decision = { body: 'loading', visible: true, notice: false };

it.each<{ name: string; facts: Partial<AccessFacts>; expected: Decision }>([
  {
    name: 'no connection offers sign-in',
    facts: { connection: undefined, podReadable: false },
    expected: connections,
  },
  {
    name: 'prepared but signed-out connection offers sign-in',
    facts: {
      connection: connected({ session: { kind: 'signed-out' } }),
      podReadable: false,
    },
    expected: connections,
  },
  {
    name: 'restoration shows loading',
    facts: {
      connection: connected({ session: { kind: 'restoring' } }),
      podReadable: false,
    },
    expected: loading,
  },
  {
    name: 'callback notice keeps restoring controls visible',
    facts: {
      connection: connected({ session: { kind: 'restoring' } }),
      podReadable: false,
      state: { ...base.state, callbackNotice: true },
    },
    expected: connections,
  },
  {
    name: 'ended session offers sign-in',
    facts: {
      connection: connected({ session: { kind: 'ended', problem: 'expired' } }),
      podReadable: false,
    },
    expected: connections,
  },
  {
    name: 'failed durable sign-out keeps retry controls visible',
    facts: {
      connection: connected({
        session: { kind: 'ended', problem: 'disconnected', saved: false },
      }),
      podReadable: false,
    },
    expected: connections,
  },
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
    name: 'missing required scopes needs recovery',
    facts: {
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
    name: 'first sign-in leaves',
    facts: {
      podReadable: false,
      connection: connected({ session: { kind: 'leaving' } }),
    },
    expected: { body: 'leaving', visible: true, notice: false },
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
    name: 'reauthorization with missing scopes shows leaving',
    facts: {
      connection: connected({
        session: { kind: 'leaving', subject: 'urn:person' },
        missingRequiredScopes: ['tasks'],
      }),
    },
    expected: { body: 'leaving', visible: true, notice: false },
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
  {
    name: 'resumed denial offers one retry',
    facts: { retry: true, state: { ...base.state, callbackNotice: true } },
    expected: { body: 'retry', visible: true, notice: false },
  },
  {
    name: 'retry survives cleared callback notice',
    facts: { retry: true },
    expected: { body: 'retry', visible: true, notice: false },
  },
  {
    name: 'callback notice alone stays visible',
    facts: { state: { ...base.state, callbackNotice: true } },
    expected: { body: 'none', visible: true, notice: false },
  },
  {
    name: 'recovery takes precedence over a retained retry',
    facts: {
      retry: true,
      demand: 'selection',
      connection: connected({ catalogue: { kind: 'failed' } }),
    },
    expected: { ...connections, notice: true },
  },
])('$name', ({ facts, expected }) => {
  expect(presentAccess({ ...base, ...facts })).toMatchObject(expected);
});

it.each([
  ['startup-error', { startupError: new Error('fixture') }],
  ['starting', { startup: undefined }],
  [
    'busy',
    { startup: { interaction: 'none', storage: 'busy', unreadable: [] } },
  ],
  [
    'unavailable',
    {
      startup: { interaction: 'none', storage: 'unavailable', unreadable: [] },
    },
  ],
] as const)('%s takes precedence over management and retry', (body, state) => {
  expect(
    presentAccess({
      ...base,
      manage: true,
      retry: true,
      state: { ...base.state, ...state },
    }),
  ).toMatchObject({ body, visible: true, notice: false });
});

it.each([
  [{}, 'h1', true, true],
  [{ manage: true }, 'h2', false, false],
  [{ hasView: true }, 'h2', false, false],
  [{ headingLevel: 2 }, 'h2', false, true],
  [{ hasView: true, headingLevel: 1 }, 'h1', false, false],
] as const)(
  'preserves heading and layout for %j',
  (facts, heading, namesApp, initial) => {
    expect(presentAccess({ ...base, ...facts })).toMatchObject({
      heading,
      namesApp,
      initial,
    });
  },
);
