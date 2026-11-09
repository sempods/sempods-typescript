/** Access prompts derived from runtime facts (#238): rules, identity, dismissal. */
import { describe, expect, it } from 'vitest';
import type {
  Connection,
  SessionFact,
  StartupReport,
} from '../runtime/types.js';
import { createAccessTracker, type AccessPrompt } from './access.js';

const started: StartupReport = {
  interaction: 'none',
  storage: 'durable',
  unreadable: [],
};
const active: SessionFact = { kind: 'active', subject: 'urn:person' };
function connection(
  id: string,
  session: SessionFact = active,
  overrides: Partial<Connection> = {},
): Connection {
  return {
    id,
    podUrl: `https://pod.example/${id}`,
    clientKind: 'dynamic',
    session,
    catalogue: { kind: 'unknown' },
    requestedScopes: [],
    requiredScopes: [],
    optionalScopes: [],
    grantedScopes: [],
    missingRequiredScopes: [],
    selectedContext: null,
    ...overrides,
  };
}
type Facts = Parameters<ReturnType<typeof createAccessTracker>['derive']>[0];
const facts = (overrides: Partial<Facts> = {}): Facts => ({
  startup: started,
  startupError: undefined,
  callbackNotice: false,
  connections: [],
  activeId: null,
  ...overrides,
});
/** One derivation's prompts without their opaque ids. */
function shape(prompt: AccessPrompt | null) {
  if (!prompt) return null;
  const { id, ...rest } = prompt;
  void id;
  return rest;
}
const derive = (f: Facts) => createAccessTracker().derive(f);

describe('startup and pending', () => {
  it('derives nothing before startup settles', () => {
    expect(derive(facts({ startup: undefined }))).toEqual({
      pending: true,
      blocking: null,
      prompts: [],
    });
  });
  it.each(['restoring', 'leaving'] as const)(
    'derives nothing while the active connection is %s',
    (kind) => {
      const state = derive(
        facts({
          connections: [
            connection('a', { kind }),
            connection('b', { kind: 'ended', problem: 'expired' }),
          ],
          activeId: 'a',
        }),
      );
      expect(state).toMatchObject({
        pending: true,
        blocking: null,
        prompts: [],
      });
    },
  );
  it('puts a startup failure before busy and unavailable storage', () => {
    const blocking = (f: Partial<Facts>) => shape(derive(facts(f)).blocking);
    expect(
      blocking({
        startupError: new Error('fixture'),
        startup: { ...started, storage: 'busy' },
      }),
    ).toEqual({
      severity: 'blocking',
      reason: 'startup-failed',
      connectionId: null,
      actions: ['reload'],
    });
    expect(
      blocking({ startup: { ...started, storage: 'busy' } }),
    ).toMatchObject({ reason: 'other-tab', actions: ['reload'] });
    expect(
      blocking({ startup: { ...started, storage: 'unavailable' } }),
    ).toMatchObject({ reason: 'storage', actions: [] });
  });
  it('derives no other prompt beside a startup problem', () => {
    const state = derive(
      facts({
        startup: { ...started, storage: 'busy' },
        connections: [connection('b', { kind: 'ended', problem: 'expired' })],
      }),
    );
    expect(state.prompts).toEqual([]);
  });
  it('blocks without an active connection', () => {
    expect(shape(derive(facts()).blocking)).toEqual({
      severity: 'blocking',
      reason: 'no-connection',
      connectionId: null,
      actions: ['sign-in'],
    });
  });
});

describe('connection prompts', () => {
  const cases: readonly {
    readonly name: string;
    readonly session: SessionFact;
    readonly missing?: readonly string[];
    readonly active: Omit<AccessPrompt, 'id' | 'connectionId'> | null;
    readonly other: Omit<AccessPrompt, 'id' | 'connectionId'> | null;
  }[] = [
    {
      name: 'a sign-out in progress',
      session: { kind: 'ended', problem: 'disconnected' },
      active: null,
      other: null,
    },
    {
      name: 'a failed sign-out',
      session: { kind: 'ended', problem: 'disconnected', saved: false },
      active: {
        severity: 'blocking',
        reason: 'sign-out-failed',
        actions: ['retry'],
      },
      other: {
        severity: 'action',
        reason: 'sign-out-failed',
        actions: ['retry', 'dismiss'],
      },
    },
    {
      name: 'a failed forget',
      session: {
        kind: 'ended',
        problem: 'disconnected',
        saved: false,
        forget: true,
      },
      active: {
        severity: 'blocking',
        reason: 'sign-out-failed',
        actions: ['retry'],
      },
      other: {
        severity: 'action',
        reason: 'sign-out-failed',
        actions: ['retry', 'dismiss'],
      },
    },
    {
      name: 'an unreachable Pod',
      session: { kind: 'ended', problem: 'network', restorable: true },
      active: {
        severity: 'action',
        reason: 'unreachable',
        actions: ['retry'],
        problem: 'network',
      },
      other: {
        severity: 'action',
        reason: 'unreachable',
        actions: ['retry', 'dismiss'],
        problem: 'network',
      },
    },
    {
      name: 'an ended session',
      session: { kind: 'ended', problem: 'expired' },
      active: {
        severity: 'blocking',
        reason: 'signed-out',
        actions: ['sign-in', 'forget'],
        problem: 'expired',
      },
      other: {
        severity: 'action',
        reason: 'signed-out',
        actions: ['sign-in', 'forget', 'dismiss'],
        problem: 'expired',
      },
    },
    {
      name: 'a remembered Pod whose session ended',
      session: { kind: 'signed-out', problem: 'invalid-client' },
      active: {
        severity: 'blocking',
        reason: 'signed-out',
        actions: ['sign-in', 'forget'],
        problem: 'invalid-client',
      },
      other: {
        severity: 'action',
        reason: 'signed-out',
        actions: ['sign-in', 'forget', 'dismiss'],
        problem: 'invalid-client',
      },
    },
    {
      name: 'a Pod the person signed out of',
      session: { kind: 'signed-out', problem: 'disconnected' },
      active: {
        severity: 'blocking',
        reason: 'signed-out',
        actions: ['sign-in', 'forget'],
        problem: 'disconnected',
      },
      other: null,
    },
    {
      name: 'missing required scopes',
      session: active,
      missing: ['tasks'],
      active: {
        severity: 'blocking',
        reason: 'missing-scopes',
        actions: ['sign-in'],
      },
      other: {
        severity: 'action',
        reason: 'missing-scopes',
        actions: ['sign-in', 'dismiss'],
      },
    },
    { name: 'a usable session', session: active, active: null, other: null },
    {
      name: 'a renewing session',
      session: { kind: 'renewing', subject: 'urn:person' },
      active: null,
      other: null,
    },
  ];
  it.each(cases)('$name on the active connection', (c) => {
    const state = derive(
      facts({
        connections: [
          connection('a', c.session, {
            missingRequiredScopes: c.missing ?? [],
          }),
        ],
        activeId: 'a',
      }),
    );
    const expected = c.active && { ...c.active, connectionId: 'a' };
    const blocking = expected?.severity === 'blocking' ? expected : null;
    expect(shape(state.blocking)).toEqual(blocking);
    expect(state.prompts.map(shape)).toEqual(
      expected && !blocking ? [expected] : [],
    );
  });
  it.each(cases)('$name beside a usable active connection', (c) => {
    const state = derive(
      facts({
        connections: [
          connection('a'),
          connection('b', c.session, {
            missingRequiredScopes: c.missing ?? [],
          }),
        ],
        activeId: 'a',
      }),
    );
    // Only the active connection blocks.
    expect(state.blocking).toBeNull();
    expect(state.prompts.map(shape)).toEqual(
      c.other ? [{ ...c.other, connectionId: 'b' }] : [],
    );
  });
  it('keeps the active connection blocking beside a healthy other one', () => {
    const state = derive(
      facts({
        connections: [
          connection('a', { kind: 'ended', problem: 'expired' }),
          connection('b'),
        ],
        activeId: 'a',
      }),
    );
    expect(state.blocking).toMatchObject({
      reason: 'signed-out',
      connectionId: 'a',
    });
  });
});

describe('callbacks', () => {
  const failure = { code: 'authentication' } as const;
  it('takes over a callback in its connection prompt', () => {
    const state = derive(
      facts({
        callbackNotice: true,
        startup: {
          ...started,
          interaction: 'failed',
          attemptConnectionId: 'a',
          failure,
        },
        connections: [connection('a', { kind: 'ended', problem: 'denied' })],
        activeId: 'a',
      }),
    );
    expect(state.blocking).toMatchObject({ reason: 'signed-out', failure });
    expect(state.prompts).toEqual([]);
  });
  it('keeps the callbacks and causes of different connections apart', () => {
    const state = derive(
      facts({
        callbackNotice: true,
        startup: {
          ...started,
          interaction: 'failed',
          attemptConnectionId: 'a',
        },
        connections: [
          connection('a'),
          connection('b', { kind: 'ended', problem: 'expired' }),
        ],
        activeId: 'a',
      }),
    );
    expect(state.prompts.map((p) => [p.reason, p.connectionId])).toEqual([
      ['signed-out', 'b'],
      ['sign-in-failed', 'a'],
    ]);
  });
  it('adds no callback prompt while its connection signs out', () => {
    const state = derive(
      facts({
        callbackNotice: true,
        startup: {
          ...started,
          interaction: 'failed',
          attemptConnectionId: 'a',
        },
        connections: [
          connection('a', { kind: 'ended', problem: 'disconnected' }),
          connection('b'),
        ],
        activeId: 'b',
      }),
    );
    expect(state.prompts).toEqual([]);
  });
  it('offers only dismiss for a callback without a known attempt', () => {
    const state = derive(
      facts({
        callbackNotice: true,
        startup: { ...started, interaction: 'failed', failure },
        connections: [connection('a')],
        activeId: 'a',
      }),
    );
    expect(state.prompts.map(shape)).toEqual([
      {
        severity: 'action',
        reason: 'sign-in-failed',
        connectionId: null,
        actions: ['dismiss'],
        failure,
      },
    ]);
  });
  it.each([
    [undefined, 'sign-in-cancelled'],
    [true, 'sharing-unchanged'],
  ] as const)(
    'reports a cancelled callback (resumed: %s) as information',
    (resumed, reason) => {
      const state = derive(
        facts({
          callbackNotice: true,
          startup: {
            ...started,
            interaction: 'cancelled',
            attemptConnectionId: 'a',
            ...(resumed ? { resumed } : {}),
          },
          connections: [connection('a')],
          activeId: 'a',
        }),
      );
      expect(state.prompts.map(shape)).toEqual([
        { severity: 'info', reason, connectionId: 'a', actions: ['dismiss'] },
      ]);
    },
  );
  it('ends the callback prompt with callbackNotice', () => {
    const tracker = createAccessTracker();
    const f = facts({
      callbackNotice: true,
      startup: {
        ...started,
        interaction: 'cancelled',
        attemptConnectionId: 'a',
        resumed: true,
      },
      connections: [connection('a')],
      activeId: 'a',
    });
    expect(tracker.derive(f).prompts).toHaveLength(1);
    expect(tracker.derive({ ...f, callbackNotice: false }).prompts).toEqual([]);
  });
});

describe('identity and dismissal', () => {
  const ended = connection('b', { kind: 'ended', problem: 'expired' });
  const beside = (b: Connection, a = connection('a')) =>
    facts({ connections: [a, b], activeId: 'a' });
  it('keeps ids and the state object across equal snapshots', () => {
    const tracker = createAccessTracker();
    const first = tracker.derive(beside(ended));
    // A catalogue reload changes the connection object, not the cause.
    const second = tracker.derive(
      beside({ ...ended, catalogue: { kind: 'loading' } }),
    );
    expect(second).toBe(first);
    expect(second.prompts[0]!.id).toBe(first.prompts[0]!.id);
  });
  it('dismisses a dismissible prompt once and keeps it dismissed', () => {
    const tracker = createAccessTracker();
    const [prompt] = tracker.derive(beside(ended)).prompts;
    expect(tracker.dismiss(prompt!.id)).toBe(prompt);
    expect(tracker.derive(beside(ended)).prompts).toEqual([]);
    expect(tracker.derive(beside({ ...ended })).prompts).toEqual([]);
    expect(tracker.dismiss(prompt!.id)).toBeUndefined();
  });
  it('shows a dismissed prompt again once it blocks', () => {
    const tracker = createAccessTracker();
    const [prompt] = tracker.derive(beside(ended)).prompts;
    tracker.dismiss(prompt!.id);
    // The ended connection becomes the active one: same cause, now blocking.
    const state = tracker.derive(
      facts({ connections: [connection('a'), ended], activeId: 'b' }),
    );
    expect(state.blocking?.id).toBe(prompt!.id);
    // Falling back to an action prompt, the earlier dismissal holds.
    expect(tracker.derive(beside(ended)).prompts).toEqual([]);
  });
  it('refuses to dismiss a prompt without dismiss', () => {
    const tracker = createAccessTracker();
    const unreachable = connection('a', {
      kind: 'ended',
      problem: 'network',
      restorable: true,
    });
    const [prompt] = tracker.derive(
      facts({ connections: [unreachable], activeId: 'a' }),
    ).prompts;
    expect(prompt!.actions).toEqual(['retry']);
    expect(tracker.dismiss(prompt!.id)).toBeUndefined();
    const blocking = tracker.derive(facts()).blocking!;
    expect(tracker.dismiss(blocking.id)).toBeUndefined();
  });
  it('keeps the id of an unreachable Pod while a retry restores it', () => {
    const tracker = createAccessTracker();
    const unreachable = connection('b', {
      kind: 'ended',
      problem: 'network',
      restorable: true,
    });
    const [prompt] = tracker.derive(beside(unreachable)).prompts;
    tracker.dismiss(prompt!.id);
    tracker.derive(beside(connection('b', { kind: 'restoring' })));
    expect(tracker.derive(beside(unreachable)).prompts).toEqual([]);
    // Restored, then unreachable again: a new cause with a new id.
    tracker.derive(beside(connection('b')));
    const [again] = tracker.derive(beside(unreachable)).prompts;
    expect(again!.id).not.toBe(prompt!.id);
  });
  it('gives a later cause a new id, also with the same reason', () => {
    const tracker = createAccessTracker();
    const [first] = tracker.derive(beside(ended)).prompts;
    tracker.derive(beside(connection('b')));
    const [second] = tracker.derive(beside(ended)).prompts;
    expect(second!.id).not.toBe(first!.id);
  });
  it('keeps identity and dismissals while derivation waits', () => {
    const tracker = createAccessTracker();
    const [prompt] = tracker.derive(beside(ended)).prompts;
    tracker.dismiss(prompt!.id);
    tracker.derive(beside(ended, connection('a', { kind: 'restoring' })));
    expect(tracker.derive(beside(ended)).prompts).toEqual([]);
  });
  it('lists prompts oldest first', () => {
    const tracker = createAccessTracker();
    const c = connection('c', { kind: 'ended', problem: 'expired' });
    tracker.derive(facts({ connections: [connection('a'), c], activeId: 'a' }));
    const state = tracker.derive(
      facts({ connections: [connection('a'), ended, c], activeId: 'a' }),
    );
    expect(state.prompts.map((p) => p.connectionId)).toEqual(['c', 'b']);
  });
  it('reports whether a prompt is still current with an action', () => {
    const tracker = createAccessTracker();
    const [prompt] = tracker.derive(beside(ended)).prompts;
    expect(tracker.current(prompt!, 'sign-in')).toBeTruthy();
    expect(tracker.current(prompt!, 'retry')).toBeUndefined();
    tracker.derive(beside(connection('b')));
    expect(tracker.current(prompt!, 'sign-in')).toBeUndefined();
  });
});
