import {
  prepareSessionAuthorization,
  type SessionAttempt,
} from './authorization.js';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverPod } from '@sempods/client-sdk/oauth';
import {
  exchangeAuthorization,
  refreshAuthorization,
  type ExchangeResult,
} from '@sempods/client-sdk/oauth';
import { fixture, jwt, pod, callback } from '../runtime/fixture.test.js';
import { openSessionStore, type SessionStore } from './store.js';
import {
  createSessionTransitions,
  type SessionChange,
  type CodeClaim,
} from './transitions.js';

const opened: SessionStore[] = [];
afterEach(() => {
  opened.splice(0).forEach((store) => store.close());
  vi.restoreAllMocks();
});
const config = { configKey: 'app', redirectUri: callback };
function committed(change: SessionChange) {
  expect(change.kind).toBe('committed');
  if (change.kind !== 'committed') throw new Error('Expected commit');
  return change.record;
}
function claimed<T extends { readonly kind: string }>(
  claim: T,
): Extract<T, { kind: 'claimed' }> {
  expect(claim.kind).toBe('claimed');
  if (claim.kind !== 'claimed') throw new Error('Expected claim');
  return claim as Extract<T, { kind: 'claimed' }>;
}
function returned(attempt: SessionAttempt) {
  return new URL(`${callback}?code=fixture-code&state=${attempt.state}`);
}
function credentials(changes: Partial<ExchangeResult> = {}): ExchangeResult {
  const receivedAt = Date.now();
  return {
    receivedAt,
    expiresIn: 3600,
    accessToken: jwt(),
    refreshToken: 'refresh-one',
    subject: 'https://person.example/#me',
    scopes: [],
    expiresAt: receivedAt + 3600_000,
    ...changes,
  };
}
async function setup(factory = new IDBFactory()) {
  const store = await openSessionStore('app', factory);
  opened.push(store);
  const transitions = createSessionTransitions(store, config);
  const f = fixture();
  const discovery = await discoverPod(pod, { fetch: f.fetch });
  const { attempt } = await prepareSessionAuthorization({
    ...config,
    connectionId: 'connection',
    generation: 'generation-one',
    pod: discovery,
    client: {
      kind: 'dynamic',
      podUrl: pod,
      issuer: pod,
      clientId: 'dyn:test',
      redirectUri: callback,
    },
    returnTo: '/',
  });
  async function prepare() {
    return committed(await transitions.prepare(attempt, null));
  }
  async function ready() {
    const saved = await prepare();
    return committed(
      await claimed(
        await transitions.claimCode(
          saved.id,
          saved.revision,
          attempt,
          returned(attempt),
        ),
      ).complete(credentials()),
    );
  }
  return { factory, store, transitions, f, attempt, prepare, ready };
}

describe('durable transitions owned by the browser coordinator', () => {
  it('allows exactly one code dispatch and accepts only after durable completion', async () => {
    const { factory, transitions, prepare, f, attempt } = await setup();
    const other = (await setup(factory)).transitions;
    const pending = await prepare();
    const contenders = await Promise.all(
      [transitions, other].map((t) =>
        t.claimCode(pending.id, pending.revision, attempt, returned(attempt)),
      ),
    );
    expect(contenders.filter((r) => r.kind === 'conflict')).toHaveLength(1);
    const winner = contenders.find(
      (r): r is CodeClaim => r.kind === 'claimed',
    )!;
    const stored = await other.read(pending.id);
    expect(stored?.value.kind).toBe('claimed');
    expect(JSON.stringify(stored)).not.toContain(winner.attempt.verifier);
    const result = await exchangeAuthorization(
      winner.attempt,
      new URL(`${callback}?code=fixture-code&state=${winner.attempt.state}`),
      { fetch: f.fetch },
    );
    expect(f.count('/token')).toBe(1);
    expect(committed(await winner.complete(result)).value.kind).toBe('ready');
    await expect(winner.complete(result)).rejects.toMatchObject({
      problem: 'consumed',
    });
  });

  it('claims refresh once, erases durable credentials before dispatch and preserves rotated results', async () => {
    const { factory, transitions, ready, f, attempt } = await setup();
    const before = await ready();
    const other = (await setup(factory)).transitions;
    const contenders = await Promise.all(
      [transitions, other].map((t) =>
        t.claimRefresh(before.id, before.revision, attempt),
      ),
    );
    expect(contenders.filter((r) => r.kind === 'claimed')).toHaveLength(1);
    const winner = claimed(contenders.find((r) => r.kind === 'claimed')!);
    const saved = await other.read(before.id);
    expect(saved?.value.kind).toBe('claimed');
    // Only the one resend keeps the refresh token; no access token stays.
    expect(saved?.value).toMatchObject({
      resend: { refreshToken: 'refresh-one', sentAt: winner.sentAt },
    });
    expect(saved?.value).not.toHaveProperty('credentials');
    expect(JSON.stringify(saved)).not.toContain(winner.credentials.accessToken);
    const result = await refreshAuthorization(
      { ...winner.binding, scopes: winner.credentials.scopes },
      winner.credentials.refreshToken!,
      winner.credentials.subject,
      { fetch: f.fetch, signal: new AbortController().signal },
    );
    expect(f.count('/token')).toBe(1);
    const accepted = committed(await winner.complete(result));
    expect(accepted.value.kind).toBe('ready');
    expect(await other.read(before.id)).toEqual(accepted);
    expect(
      await other.claimRefresh(before.id, before.revision, attempt),
    ).toEqual({ kind: 'conflict' });
  });

  it('never reclaims an uncertain exchange after close/reopen or elapsed time', async () => {
    const { factory, store, transitions, ready, attempt } = await setup();
    const before = await ready();
    await transitions.claimRefresh(before.id, before.revision, attempt);
    store.close();
    const reopened = (await setup(factory)).transitions;
    const saved = (await reopened.read(before.id))!;
    expect(saved.value.kind).toBe('claimed');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 24 * 3600_000);
    await expect(
      reopened.claimRefresh(saved.id, saved.revision, attempt),
    ).rejects.toMatchObject({ problem: 'state' });
    await expect(
      reopened.claimCode(saved.id, saved.revision, attempt, returned(attempt)),
    ).rejects.toMatchObject({ problem: 'state' });
    expect(
      committed(await reopened.disconnect(saved.id, saved.revision)).value.kind,
    ).toBe('disconnected');
  });

  it('resends a claimed refresh once, keeping when it was first sent', async () => {
    const { factory, store, transitions, ready, attempt } = await setup();
    const before = await ready();
    const first = claimed(
      await transitions.claimRefresh(before.id, before.revision, attempt),
    );
    // A new page: the claim is all that is left of the lost answer.
    store.close();
    const reopened = (await setup(factory)).transitions;
    const saved = (await reopened.read(before.id))!;
    const resend = claimed(
      await reopened.resendRefresh(saved.id, saved.revision, attempt),
    );
    expect(resend.resend).toEqual({
      refreshToken: 'refresh-one',
      scopes: [],
      sentAt: first.sentAt,
      resent: true,
    });
    expect(resend.subject).toBe('https://person.example/#me');
    expect((await reopened.read(before.id))?.value).toMatchObject({
      kind: 'claimed',
      resend: { resent: true, sentAt: first.sentAt },
    });
    // Only once, also from a later page.
    await expect(
      reopened.resendRefresh(saved.id, resend.revision, attempt),
    ).rejects.toMatchObject({ problem: 'state' });
    // The result continues the refresh like the first answer would have.
    await expect(
      resend.complete(credentials({ refreshToken: 'refresh-one' })),
    ).rejects.toMatchObject({ problem: 'result' });
    expect((await reopened.read(before.id))?.value.kind).toBe('claimed');
    // Retiring the claim drops the token.
    const retired = committed(
      await reopened.disconnect(saved.id, resend.revision, 'interrupted'),
    );
    expect(JSON.stringify(retired)).not.toContain('refresh-one');
  });

  it('accepts a resent refresh result and refuses a resend of other records', async () => {
    const { transitions, ready, attempt } = await setup();
    const before = await ready();
    claimed(
      await transitions.claimRefresh(before.id, before.revision, attempt),
    );
    const saved = (await transitions.read(before.id))!;
    // Another binding (here: another generation) is refused unchanged.
    await expect(
      transitions.resendRefresh(saved.id, saved.revision, {
        ...attempt,
        generation: 'generation-two',
      }),
    ).rejects.toMatchObject({ problem: 'state' });
    expect(await transitions.read(before.id)).toEqual(saved);
    expect(await transitions.resendRefresh(saved.id, 'stale', attempt)).toEqual(
      { kind: 'conflict' },
    );
    const resend = claimed(
      await transitions.resendRefresh(saved.id, saved.revision, attempt),
    );
    expect(
      committed(await resend.complete(credentials({ refreshToken: 'rotated' })))
        .value,
    ).toMatchObject({
      kind: 'ready',
      credentials: { refreshToken: 'rotated' },
    });
    // A ready record or an attempt has nothing to resend.
    const current = (await transitions.read(before.id))!;
    await expect(
      transitions.resendRefresh(current.id, current.revision, attempt),
    ).rejects.toMatchObject({ problem: 'state' });
    const other = await setup();
    const attemptRecord = await other.prepare();
    await expect(
      other.transitions.resendRefresh(
        attemptRecord.id,
        attemptRecord.revision,
        other.attempt,
      ),
    ).rejects.toMatchObject({ problem: 'state' });
  });

  it('never resends a refresh claim written without its token (SDK 0.7)', async () => {
    const { store, transitions, ready, attempt } = await setup();
    const before = await ready();
    claimed(
      await transitions.claimRefresh(before.id, before.revision, attempt),
    );
    const saved = (await store.read(before.id))!;
    const value = { ...(saved.value as Record<string, unknown>) };
    delete value.resend;
    const old = await store.commit(saved.id, saved.revision, value);
    if (old.kind !== 'committed') throw new Error('Expected commit');
    await expect(
      transitions.resendRefresh(saved.id, old.record.revision, attempt),
    ).rejects.toMatchObject({ problem: 'state' });
  });

  it.each([
    ['an empty token', { refreshToken: '' }],
    ['a missing send time', { sentAt: undefined }],
    ['a negative send time', { sentAt: -1 }],
    ['invalid scopes', { scopes: ['a b'] }],
    ['an invalid resent mark', { resent: false }],
  ] as const)(
    'reads a refresh claim with %s as corrupt',
    async (_l, change) => {
      const { store, transitions, ready, attempt } = await setup();
      const before = await ready();
      claimed(
        await transitions.claimRefresh(before.id, before.revision, attempt),
      );
      const saved = (await store.read(before.id))!;
      const value = saved.value as { resend: Record<string, unknown> };
      await store.commit(saved.id, saved.revision, {
        ...value,
        resend: { ...value.resend, ...change },
      });
      await expect(transitions.read(before.id)).rejects.toMatchObject({
        problem: 'corrupt',
      });
    },
  );

  it.each(['disconnect', 'reconnect'] as const)(
    'rejects late completion after %s wins',
    async (action) => {
      const { transitions, ready, attempt } = await setup();
      const before = await ready();
      const winner = claimed(
        await transitions.claimRefresh(before.id, before.revision, attempt),
      );
      const held = (await transitions.read(before.id))!;
      const newer =
        action === 'disconnect'
          ? committed(await transitions.disconnect(held.id, held.revision))
          : committed(
              await transitions.prepare(
                { ...attempt, generation: 'new-generation' },
                held.revision,
              ),
            );
      expect(
        await winner.complete(credentials({ refreshToken: 'rotated' })),
      ).toEqual({ kind: 'conflict' });
      expect(await transitions.read(before.id)).toEqual(newer);
    },
  );

  it('preserves claims after failed acceptance and never restores spent credentials', async () => {
    const { store, transitions, ready, attempt } = await setup();
    const before = await ready();
    const winner = claimed(
      await transitions.claimRefresh(before.id, before.revision, attempt),
    );
    const spy = vi
      .spyOn(store, 'commit')
      .mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(
      winner.complete(credentials({ refreshToken: 'rotated' })),
    ).rejects.toThrow();
    spy.mockRestore();
    expect((await transitions.read(before.id))?.value.kind).toBe('claimed');
    await expect(
      winner.complete(credentials({ refreshToken: 'rotated' })),
    ).rejects.toMatchObject({ problem: 'consumed' });
    // The coordinator retires the secret-free claim with a disconnect.
    expect(
      committed(await transitions.disconnect(before.id, winner.revision)).value
        .kind,
    ).toBe('disconnected');
    expect(JSON.stringify(await store.read(before.id))).not.toContain(
      'refresh-one',
    );
  });

  it.each(['code', 'refresh'] as const)(
    'does not return a %s claim when the claim transaction aborts',
    async (operation) => {
      const { transitions, prepare, ready, attempt } = await setup();
      const before = await (operation === 'code' ? prepare() : ready());
      const put = IDBObjectStore.prototype.put;
      const spy = vi
        .spyOn(IDBObjectStore.prototype, 'put')
        .mockImplementation(function (this: IDBObjectStore, value, key) {
          const request = put.call(this, value, key);
          request.addEventListener('success', () => this.transaction.abort());
          return request;
        });
      const dispatch = vi.fn();
      await expect(
        (operation === 'code'
          ? transitions.claimCode(
              before.id,
              before.revision,
              attempt,
              returned(attempt),
            )
          : transitions.claimRefresh(before.id, before.revision, attempt)
        ).then(dispatch),
      ).rejects.toMatchObject({ problem: 'unavailable' });
      expect(dispatch).not.toHaveBeenCalled();
      spy.mockRestore();
      expect(await transitions.read(before.id)).toEqual(before);
    },
  );

  it('reports a failed durable disconnect and leaves local blocking to the coordinator', async () => {
    const { store, transitions, ready } = await setup();
    const before = await ready();
    vi.spyOn(store, 'commit').mockRejectedValueOnce(
      new Error('storage unavailable'),
    );
    await expect(
      transitions.disconnect(before.id, before.revision),
    ).rejects.toThrow();
    expect(await transitions.read(before.id)).toEqual(before);
  });

  it('retires a failed exchange without retaining secrets', async () => {
    const { transitions, prepare, attempt } = await setup();
    const pending = await prepare();
    const winner = claimed(
      await transitions.claimCode(
        pending.id,
        pending.revision,
        attempt,
        returned(attempt),
      ),
    );
    const saved = committed(
      await transitions.disconnect(pending.id, winner.revision),
    );
    expect(saved.value.kind).toBe('disconnected');
    expect(JSON.stringify(saved)).not.toContain(winner.attempt.verifier);
    // A late result cannot revive the retired record (compare-and-swap).
    expect(await winner.complete(credentials())).toEqual({ kind: 'conflict' });
  });

  it('does not make an expired access token fresh by reopening storage', async () => {
    const { transitions, store, ready, attempt } = await setup();
    const before = await ready();
    if (before.value.kind !== 'ready') throw new Error();
    const expired = {
      ...before.value,
      credentials: credentials({
        receivedAt: 0,
        expiresIn: 0.001,
        expiresAt: 1,
      }),
    };
    await store.commit(before.id, before.revision, expired);
    const saved = (await transitions.read(before.id))!;
    expect(saved.value).toEqual(expired);
    expect(
      (await transitions.claimRefresh(saved.id, saved.revision, attempt)).kind,
    ).toBe('claimed');
  });

  it('keeps an expired attempt visible but refuses to dispatch it', async () => {
    const { transitions, prepare, attempt } = await setup();
    const before = await prepare();
    vi.spyOn(Date, 'now').mockReturnValue(attempt.expiresAt);
    expect((await transitions.list()).records).toEqual([before]);
    await expect(
      transitions.claimCode(
        before.id,
        before.revision,
        attempt,
        returned(attempt),
      ),
    ).rejects.toMatchObject({ problem: 'attempt' });
  });

  it.each([
    [
      'subject',
      {
        subject: 'https://other.example/me',
        accessToken: jwt({ sub: 'https://other.example/me' }),
      },
    ],
    ['issuer', { accessToken: jwt({ iss: 'https://other.example/pod' }) }],
    ['client', { accessToken: jwt({ client_id: 'dyn:other' }) }],
    [
      'scope expansion',
      { accessToken: jwt({ scope: 'public-read' }), scopes: ['public-read'] },
    ],
    ['spent refresh', { refreshToken: 'refresh-one' }],
    ['expired result', { expiresAt: 1 }],
  ] as const)(
    'rejects refresh result with %s without restoring the submitted token',
    async (_label, changes) => {
      const { transitions, ready, attempt } = await setup();
      const before = await ready();
      const winner = claimed(
        await transitions.claimRefresh(before.id, before.revision, attempt),
      );
      await expect(
        winner.complete(credentials({ refreshToken: 'rotated', ...changes })),
      ).rejects.toMatchObject({ problem: 'result' });
      expect((await transitions.read(before.id))?.value.kind).toBe('claimed');
      await expect(
        winner.complete(credentials({ refreshToken: 'corrected' })),
      ).rejects.toMatchObject({ problem: 'consumed' });
      expect(
        committed(await transitions.disconnect(before.id, winner.revision))
          .value.kind,
      ).toBe('disconnected');
    },
  );

  it('accepts a missing replacement refresh token without reviving the previous one', async () => {
    const { transitions, ready, attempt } = await setup();
    const before = await ready();
    const winner = claimed(
      await transitions.claimRefresh(before.id, before.revision, attempt),
    );
    const result = credentials();
    delete (result as { refreshToken?: string }).refreshToken;
    const saved = committed(await winner.complete(result));
    if (saved.value.kind !== 'ready') throw new Error();
    expect(saved.value.credentials.refreshToken).toBeUndefined();
    await expect(
      transitions.claimRefresh(saved.id, saved.revision, attempt),
    ).rejects.toMatchObject({ problem: 'state' });
  });

  it('isolates connection IDs and rejects a reused generation on deliberate reconnect', async () => {
    const { transitions, ready, attempt } = await setup();
    const before = await ready();
    await expect(
      transitions.prepare(attempt, before.revision),
    ).rejects.toMatchObject({ problem: 'state' });
    const other = committed(
      await transitions.prepare({ ...attempt, connectionId: 'other' }, null),
    );
    await transitions.disconnect(before.id, before.revision);
    expect(await transitions.read(other.id)).toEqual(other);
  });

  it('isolates caller mutation of prepared attempts and returned claim inputs', async () => {
    const { transitions, attempt } = await setup();
    const mutable = structuredClone(attempt);
    const pending = transitions.prepare(mutable, null);
    (mutable.pod.endpoints as { token: string }).token =
      'https://evil.example/token';
    const saved = committed(await pending);
    const winner = claimed(
      await transitions.claimCode(
        saved.id,
        saved.revision,
        attempt,
        returned(attempt),
      ),
    );
    expect(() => {
      (winner.attempt.client as { clientId: string }).clientId = 'dyn:evil';
    }).toThrow(TypeError);
    expect(committed(await winner.complete(credentials())).value.kind).toBe(
      'ready',
    );
  });

  it.each([
    [
      'configuration',
      (v: Record<string, unknown>) => {
        v.configKey = 'other';
      },
    ],
    [
      'connection ID',
      (v: Record<string, unknown>) => {
        v.connectionId = 'other';
      },
    ],
    [
      'issuer',
      (v: Record<string, unknown>) => {
        (v.pod as Record<string, unknown>).issuer = 'https://other.example';
      },
    ],
    [
      'client binding',
      (v: Record<string, unknown>) => {
        (v.client as Record<string, unknown>).podUrl = 'https://other.example';
      },
    ],
    [
      'redirect',
      (v: Record<string, unknown>) => {
        (v.client as Record<string, unknown>).redirectUri =
          'https://evil.example';
      },
    ],
    [
      'endpoint',
      (v: Record<string, unknown>) => {
        (
          (v.pod as Record<string, unknown>).endpoints as Record<
            string,
            unknown
          >
        ).token = 'http://evil.example/token';
      },
    ],
  ] as const)(
    'reports malformed %s separately without overwriting it',
    async (_label, damage) => {
      const { store, transitions, ready, attempt } = await setup();
      const before = await ready();
      const broken = structuredClone(before.value);
      if (broken.kind !== 'ready') throw new Error();
      damage(broken.binding as unknown as Record<string, unknown>);
      const raw = await store.commit(before.id, before.revision, broken);
      if (raw.kind !== 'committed') throw new Error();
      await transitions.prepare({ ...attempt, connectionId: 'good' }, null);
      const listing = await transitions.list();
      expect(listing.records.map((r) => r.id)).toEqual(['good']);
      expect(listing.unreadable).toEqual([
        { id: before.id, problem: 'corrupt' },
      ]);
      await expect(
        transitions.disconnect(before.id, raw.record.revision),
      ).rejects.toMatchObject({ problem: 'corrupt' });
      await expect(
        transitions.prepare(
          { ...attempt, generation: 'new' },
          raw.record.revision,
        ),
      ).rejects.toMatchObject({ problem: 'corrupt' });
      expect(await store.read(before.id)).toEqual(raw.record);
    },
  );

  it('preserves future payload versions and rejects inconsistent stored token metadata', async () => {
    const { store, transitions, ready } = await setup();
    const before = await ready();
    if (before.value.kind !== 'ready') throw new Error();
    const bad = await store.commit(before.id, before.revision, {
      ...before.value,
      credentials: { ...before.value.credentials, scopes: [''] },
    });
    if (bad.kind !== 'committed') throw new Error();
    await expect(transitions.read(before.id)).rejects.toMatchObject({
      problem: 'corrupt',
    });
    await store.commit(before.id, bad.record.revision, {
      version: 2,
      kind: 'ready',
      secret: 'future',
    });
    expect((await transitions.list()).unreadable).toEqual([
      { id: before.id, problem: 'unsupported' },
    ]);
  });
});

it.each(['code', 'refresh'] as const)(
  'requires independently validated endpoint/client facts for a %s claim',
  async (operation) => {
    const { transitions, prepare, ready, attempt } = await setup();
    const before = await (operation === 'code' ? prepare() : ready());
    const different = structuredClone(attempt);
    (different.pod.endpoints as { token: string }).token =
      'https://other.example/token';
    // HTTPS is structurally valid discovery; it is not the endpoint bound to this stored session.
    await expect(
      operation === 'code'
        ? transitions.claimCode(
            before.id,
            before.revision,
            different,
            returned(attempt),
          )
        : transitions.claimRefresh(before.id, before.revision, different),
    ).rejects.toMatchObject({ problem: 'state' });
    expect(await transitions.read(before.id)).toEqual(before);
  },
);

it.each([
  '?code=fixture&state=forged',
  '?code=fixture',
  '?code=fixture&state=STATE&state=STATE',
  '?error=access_denied&state=forged',
  '?error=login_required&state=forged',
  '?code=fixture&state=STATE&iss=https://other.example',
  '?state=STATE',
  '?code=fixture&state=STATE#fragment',
])(
  'leaves a legitimate attempt intact for invalid callback %s',
  async (parameters) => {
    const { transitions, prepare, attempt } = await setup();
    const saved = await prepare();
    const invalid = new URL(
      callback + parameters.replaceAll('STATE', attempt.state),
    );
    await expect(
      transitions.claimCode(saved.id, saved.revision, attempt, invalid),
    ).rejects.toMatchObject({ problem: 'callback' });
    expect(await transitions.read(saved.id)).toEqual(saved);
    const winner = claimed(
      await transitions.claimCode(
        saved.id,
        saved.revision,
        attempt,
        returned(attempt),
      ),
    );
    expect(committed(await winner.complete(credentials())).value.kind).toBe(
      'ready',
    );
  },
);

it.each(['access_denied', 'login_required', 'server_error', 'invalid_scope'])(
  'claims a matching %s answer so its attempt can be durably retired',
  async (code) => {
    const { transitions, prepare, attempt } = await setup();
    const saved = await prepare();
    const denied = new URL(`${callback}?error=${code}&state=${attempt.state}`);
    const winner = claimed(
      await transitions.claimCode(saved.id, saved.revision, attempt, denied),
    );
    expect(
      committed(await transitions.disconnect(saved.id, winner.revision)).value
        .kind,
    ).toBe('disconnected');
    expect(
      await transitions.claimCode(
        saved.id,
        saved.revision,
        attempt,
        returned(attempt),
      ),
    ).toEqual({ kind: 'conflict' });
  },
);

it('uses transition errors for malformed expected bindings and expired attempts', async () => {
  const { transitions, prepare, attempt } = await setup();
  const saved = await prepare();
  for (const operation of [
    () =>
      transitions.claimCode(
        saved.id,
        saved.revision,
        { ...attempt, configKey: 'other' },
        returned(attempt),
      ),
    () =>
      transitions.claimRefresh(saved.id, saved.revision, {
        ...attempt,
        configKey: 'other',
      }),
  ])
    await expect(operation()).rejects.toMatchObject({
      name: 'SessionTransitionError',
      problem: 'configuration',
    });
  vi.spyOn(Date, 'now').mockReturnValue(attempt.expiresAt);
  await expect(
    transitions.prepare({ ...attempt, connectionId: 'other' }, null),
  ).rejects.toMatchObject({
    name: 'SessionTransitionError',
    problem: 'attempt',
  });
  await expect(
    transitions.claimCode(saved.id, saved.revision, attempt, returned(attempt)),
  ).rejects.toMatchObject({
    name: 'SessionTransitionError',
    problem: 'attempt',
  });
});

it.each(['code', 'refresh'] as const)(
  'rejects changed discovery capabilities before a %s claim',
  async (operation) => {
    const { transitions, prepare, ready, attempt } = await setup();
    const saved = await (operation === 'code' ? prepare() : ready());
    const changed = [
      { ...attempt, pod: { ...attempt.pod, supportsRefreshToken: false } },
      {
        ...attempt,
        pod: {
          ...attempt.pod,
          scopes: { ...attempt.pod.scopes, resource: [] },
        },
      },
      {
        ...attempt,
        pod: {
          ...attempt.pod,
          scopes: {
            ...attempt.pod.scopes,
            authorizationServer: ['public-read'],
          },
        },
      },
    ];
    for (const binding of changed) {
      await expect(
        operation === 'code'
          ? transitions.claimCode(
              saved.id,
              saved.revision,
              binding,
              returned(attempt),
            )
          : transitions.claimRefresh(saved.id, saved.revision, binding),
      ).rejects.toMatchObject({ problem: 'state' });
      expect(await transitions.read(saved.id)).toEqual(saved);
    }
  },
);

it('compares advertised scopes as sets rather than discovery array order', async () => {
  const { transitions, attempt } = await setup();
  const binding = {
    ...attempt,
    pod: {
      ...attempt.pod,
      scopes: { resource: ['a', 'b'], authorizationServer: ['a', 'b'] },
    },
  };
  const saved = committed(await transitions.prepare(binding, null));
  const equivalent = {
    ...binding,
    pod: {
      ...binding.pod,
      scopes: { resource: ['b', 'a', 'a'], authorizationServer: ['b', 'a'] },
    },
  };
  expect(
    (
      await transitions.claimCode(
        saved.id,
        saved.revision,
        equivalent,
        returned(attempt),
      )
    ).kind,
  ).toBe('claimed');
});

it.each([-7200, 7200])(
  'retains a bounded endpoint lifetime across reopen with %s seconds clock skew',
  async (skew) => {
    const { factory, store, transitions, prepare, attempt, f } = await setup();
    const saved = await prepare();
    const winner = claimed(
      await transitions.claimCode(
        saved.id,
        saved.revision,
        attempt,
        returned(attempt),
      ),
    );
    const serverNow = Math.floor(Date.now() / 1000) + skew;
    f.setToken(async () =>
      Response.json({
        access_token: jwt({ iat: serverNow, exp: serverNow + 3600 }),
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'fixture-refresh',
      }),
    );
    const tokens = await exchangeAuthorization(
      winner.attempt,
      returned(attempt),
      { fetch: f.fetch },
    );
    expect(tokens.expiresAt).toBe(tokens.receivedAt + 3600_000);
    const accepted = committed(await winner.complete(tokens));
    store.close();
    const reopened = await setup(factory);
    expect(await reopened.transitions.read(saved.id)).toEqual(accepted);
    if (accepted.value.kind !== 'ready') throw new Error();
    await reopened.store.commit(saved.id, accepted.revision, {
      ...accepted.value,
      credentials: { ...tokens, expiresAt: tokens.expiresAt + 1000 },
    });
    await expect(reopened.transitions.read(saved.id)).rejects.toMatchObject({
      problem: 'corrupt',
    });
  },
);

it('checks stored absolute expiry against JWT exp when the endpoint omitted expires_in', async () => {
  const { store, transitions, prepare, attempt, f } = await setup();
  const saved = await prepare();
  const winner = claimed(
    await transitions.claimCode(
      saved.id,
      saved.revision,
      attempt,
      returned(attempt),
    ),
  );
  const result = await exchangeAuthorization(
    winner.attempt,
    returned(attempt),
    { fetch: f.fetch },
  );
  expect(result.expiresIn).toBeUndefined();
  const accepted = committed(await winner.complete(result));
  if (accepted.value.kind !== 'ready') throw new Error();
  await store.commit(saved.id, accepted.revision, {
    ...accepted.value,
    credentials: { ...result, expiresAt: result.expiresAt + 1000 },
  });
  await expect(transitions.read(saved.id)).rejects.toMatchObject({
    problem: 'corrupt',
  });
});

describe('a re-authorization pending beside its session (#393)', () => {
  async function reauthorizing() {
    const s = await setup();
    const ready = await s.ready();
    const { attempt: next } = await prepareSessionAuthorization({
      ...s.attempt,
      generation: 'generation-two',
      returnTo: '/',
    });
    const pending = committed(
      await s.transitions.prepare(next, ready.revision),
    );
    const expected = { ...next, pod: s.attempt.pod };
    return { ...s, ready, next, pending, expected };
  }
  const denied = (attempt: SessionAttempt, error = 'access_denied') =>
    new URL(`${callback}?error=${error}&state=${attempt.state}`);

  it('stores the attempt beside the session, which stays as it was', async () => {
    const { pending, ready, next, transitions, attempt } =
      await reauthorizing();
    if (ready.value.kind !== 'ready') throw new Error('Expected ready');
    expect(pending.value).toEqual({
      ...ready.value,
      pending: { kind: 'open', attempt: next },
    });
    // A newer attempt replaces it.
    const { attempt: third } = await prepareSessionAuthorization({
      ...attempt,
      generation: 'generation-three',
      returnTo: '/',
    });
    const replaced = committed(
      await transitions.prepare(third, pending.revision),
    );
    expect(replaced.value).toMatchObject({
      kind: 'ready',
      binding: { generation: 'generation-one' },
      pending: { kind: 'open', attempt: { state: third.state } },
    });
    // A sign-out drops it.
    const out = committed(
      await transitions.disconnect(
        replaced.id,
        replaced.revision,
        'disconnected',
      ),
    );
    expect(out.value).not.toHaveProperty('pending');
    // Without a session, the attempt is the record; a silent one says so.
    const { attempt: fourth } = await prepareSessionAuthorization({
      ...attempt,
      generation: 'generation-four',
      returnTo: '/',
    });
    expect(
      committed(await transitions.prepare(fourth, out.revision, true)).value,
    ).toEqual({
      version: 1,
      kind: 'authorizing',
      attempt: fourth,
      silent: true,
    });
  });

  it('reads a record of SDK 0.6 to 0.9 as its session with the attempt pending', async () => {
    const { pending, next, store, transitions } = await reauthorizing();
    if (pending.value.kind !== 'ready') throw new Error('Expected ready');
    const { binding, credentials: kept } = pending.value;
    const older = {
      version: 1,
      kind: 'authorizing',
      attempt: next,
      previous: { binding, credentials: kept },
    };
    const written = await store.commit(pending.id, pending.revision, older);
    expect(written.kind).toBe('committed');
    expect((await transitions.read(pending.id))?.value).toEqual(pending.value);
    // A record of SDK 0.5 has no earlier session.
    const { previous: _previous, ...first } = older;
    void _previous;
    const current = await store.read(pending.id);
    await store.commit(pending.id, current!.revision, first);
    expect((await transitions.read(pending.id))?.value).toEqual({
      version: 1,
      kind: 'authorizing',
      attempt: next,
    });
    // A malformed or foreign earlier session is corrupt.
    for (const previous of [
      { binding },
      { binding: { ...binding, connectionId: 'other' }, credentials: kept },
    ]) {
      const now = await store.read(pending.id);
      await store.commit(pending.id, now!.revision, { ...older, previous });
      await expect(transitions.read(pending.id)).rejects.toMatchObject({
        problem: 'corrupt',
      });
    }
  });

  it('keeps the session when the attempt it carries cannot be read', async () => {
    const { pending, store, transitions } = await reauthorizing();
    if (pending.value.kind !== 'ready') throw new Error('Expected ready');
    for (const unknown of [
      { kind: 'future' },
      { kind: 'open', attempt: { state: 'x' } },
      {
        ...pending.value.pending,
        attempt: {
          ...(pending.value.pending as { attempt: SessionAttempt }).attempt,
          generation: 'generation-one',
        },
      },
    ]) {
      const now = await store.read(pending.id);
      await store.commit(pending.id, now!.revision, {
        ...pending.value,
        pending: unknown,
      });
      const read = await transitions.read(pending.id);
      expect(read?.value).toMatchObject({ kind: 'ready' });
      expect(read?.value).not.toHaveProperty('pending');
    }
  });

  it('carries an open attempt through a refresh, and drops a claimed or expired one', async () => {
    const { pending, transitions, attempt, next } = await reauthorizing();
    if (pending.value.kind !== 'ready') throw new Error('Expected ready');
    const session = { ...attempt, generation: 'generation-one' };
    const claim = claimed(
      await transitions.claimRefresh(pending.id, pending.revision, session),
    );
    const sent = await transitions.read(pending.id);
    expect(sent?.value).toMatchObject({
      kind: 'claimed',
      pending: { kind: 'open', attempt: { state: next.state } },
    });
    const renewed = committed(
      await claim.complete(credentials({ refreshToken: 'refresh-two' })),
    );
    expect(renewed.value).toMatchObject({
      kind: 'ready',
      credentials: { refreshToken: 'refresh-two' },
      pending: { kind: 'open', attempt: { state: next.state } },
    });
    // The resend of a lost answer carries it too.
    const lost = claimed(
      await transitions.claimRefresh(renewed.id, renewed.revision, session),
    );
    const resend = claimed(
      await transitions.resendRefresh(renewed.id, lost.revision, session),
    );
    expect((await transitions.read(renewed.id))?.value).toMatchObject({
      pending: { kind: 'open' },
    });
    const again = committed(
      await resend.complete(credentials({ refreshToken: 'refresh-three' })),
    );
    // Once claimed, a refresh under the lock drops it: its tab closed.
    const code = claimed(
      await transitions.claimPending(
        again.id,
        { ...next, pod: attempt.pod },
        returned(next),
      ),
    );
    const left = claimed(
      await transitions.claimRefresh(again.id, code.revision, session),
    );
    expect((await transitions.read(again.id))?.value).not.toHaveProperty(
      'pending',
    );
    const after = committed(
      await left.complete(credentials({ refreshToken: 'refresh-four' })),
    );
    expect(after.value).not.toHaveProperty('pending');
    // An expired open attempt is dropped by the next refresh as well.
    const { attempt: late } = await prepareSessionAuthorization({
      ...attempt,
      generation: 'generation-three',
      returnTo: '/',
    });
    const out = committed(await transitions.prepare(late, after.revision));
    vi.spyOn(Date, 'now').mockReturnValue(late.expiresAt);
    claimed(await transitions.claimRefresh(out.id, out.revision, session));
    expect((await transitions.read(out.id))?.value).not.toHaveProperty(
      'pending',
    );
  });

  it('claims the code once without keeping the verifier, and the new grant replaces the session', async () => {
    const { pending, transitions, next, expected, store } =
      await reauthorizing();
    const claim = claimed(
      await transitions.claimPending(pending.id, expected, returned(next)),
    );
    expect(claim.attempt).toEqual(next);
    const stored = (await store.read(pending.id))?.value;
    expect(JSON.stringify(stored)).not.toContain(next.verifier);
    expect((await transitions.read(pending.id))?.value).toMatchObject({
      kind: 'ready',
      binding: { generation: 'generation-one' },
      pending: {
        kind: 'claimed',
        state: next.state,
        binding: { generation: 'generation-two' },
      },
    });
    // A second callback cannot exchange it again.
    await expect(
      transitions.claimPending(pending.id, expected, returned(next)),
    ).rejects.toMatchObject({ problem: 'attempt' });
    const replaced = committed(
      await claim.complete(
        credentials({
          accessToken: jwt({ sub: 'https://other.example/#me' }),
          subject: 'https://other.example/#me',
          refreshToken: 'new',
        }),
      ),
    );
    expect(replaced.value).toMatchObject({
      kind: 'ready',
      binding: { generation: 'generation-two' },
      credentials: {
        subject: 'https://other.example/#me',
        refreshToken: 'new',
      },
    });
    expect(replaced.value).not.toHaveProperty('pending');
    await expect(claim.complete(credentials())).rejects.toMatchObject({
      problem: 'consumed',
    });
  });

  it('consumes a matching error answer and leaves the session; forged or foreign callbacks change nothing', async () => {
    const { pending, transitions, next, expected, attempt } =
      await reauthorizing();
    const unchanged = async () =>
      expect((await transitions.read(pending.id))?.revision).toBe(
        pending.revision,
      );
    await expect(
      transitions.claimPending(
        pending.id,
        expected,
        new URL(`${denied(next).href}&iss=https%3A%2F%2Fevil`),
      ),
    ).rejects.toMatchObject({ problem: 'callback' });
    await unchanged();
    for (const url of [
      denied(attempt),
      new URL(`${callback}?error=access_denied`),
      new URL(`${denied(next).href}&state=${next.state}`),
    ]) {
      await expect(
        transitions.claimPending(pending.id, expected, url),
      ).rejects.toMatchObject({ problem: 'attempt' });
      await unchanged();
    }
    // A changed token endpoint is not the attempt's binding.
    await expect(
      transitions.claimPending(
        pending.id,
        {
          ...expected,
          pod: {
            ...expected.pod,
            endpoints: {
              ...expected.pod.endpoints,
              token: `${pod}/_system/auth/token-v2`,
            },
          },
        },
        returned(next),
      ),
    ).rejects.toMatchObject({ problem: 'state' });
    await unchanged();
    const answer = await transitions.claimPending(
      pending.id,
      expected,
      denied(next),
    );
    expect(answer).toMatchObject({
      kind: 'answered',
      error: { problem: 'denied' },
    });
    const after = (await transitions.read(pending.id))!;
    if (pending.value.kind !== 'ready') throw new Error('Expected ready');
    const { pending: _dropped, ...session } = pending.value;
    void _dropped;
    // Marked as ended, so every tab reads Context access again.
    expect(after.value).toEqual({
      ...session,
      attemptEnded: expect.any(String),
    });
    await expect(
      transitions.claimPending(pending.id, expected, denied(next)),
    ).rejects.toMatchObject({ problem: 'attempt' });
  });

  it('refuses an expired attempt without changing the record', async () => {
    const { pending, transitions, next, expected } = await reauthorizing();
    vi.spyOn(Date, 'now').mockReturnValue(next.expiresAt);
    await expect(
      transitions.claimPending(pending.id, expected, returned(next)),
    ).rejects.toMatchObject({ problem: 'attempt' });
    expect((await transitions.read(pending.id))?.revision).toBe(
      pending.revision,
    );
  });

  it('lets a sign-out during the exchange stay in effect', async () => {
    const { pending, transitions, next, expected } = await reauthorizing();
    const claim = claimed(
      await transitions.claimPending(pending.id, expected, returned(next)),
    );
    const out = committed(
      await transitions.disconnect(pending.id, claim.revision, 'disconnected'),
    );
    expect((await claim.complete(credentials())).kind).toBe('conflict');
    expect((await transitions.read(pending.id))?.revision).toBe(out.revision);
    expect(await transitions.discardPending(pending.id, 'generation-two')).toBe(
      'none',
    );
  });

  it('hands the attempt over when its session ends, and its callback completes it', async () => {
    for (const stage of ['open', 'claimed'] as const) {
      const { pending, transitions, next, expected } = await reauthorizing();
      const claim =
        stage === 'claimed'
          ? claimed(
              await transitions.claimPending(
                pending.id,
                expected,
                returned(next),
              ),
            )
          : undefined;
      const revision = claim?.revision ?? pending.revision;
      const handed = committed(
        (await transitions.handOver(pending.id, revision))!,
      );
      if (stage === 'open') {
        expect(handed.value).toEqual({
          version: 1,
          kind: 'authorizing',
          attempt: next,
        });
        continue;
      }
      expect(handed.value).toMatchObject({
        kind: 'claimed',
        operation: 'code',
        subject: null,
        binding: { generation: 'generation-two' },
      });
      const done = committed(await claim!.complete(credentials()));
      expect(done.value).toMatchObject({
        kind: 'ready',
        binding: { generation: 'generation-two' },
      });
    }
    // Nothing to hand over without a pending attempt, or for a stale revision.
    const s = await setup();
    const ready = await s.ready();
    expect(await s.transitions.handOver(ready.id, ready.revision)).toBe(
      undefined,
    );
    expect((await s.transitions.handOver(ready.id, 'stale'))?.kind).toBe(
      'conflict',
    );
  });

  it('drops a failed exchange’s attempt, keeping the session or retiring a handed-over claim', async () => {
    const { pending, transitions, next, expected } = await reauthorizing();
    const claim = claimed(
      await transitions.claimPending(pending.id, expected, returned(next)),
    );
    expect(
      await transitions.discardPending(pending.id, 'generation-other'),
    ).toBe('none');
    expect(await transitions.discardPending(pending.id, 'generation-two')).toBe(
      'kept',
    );
    expect((await transitions.read(pending.id))?.value).toMatchObject({
      kind: 'ready',
      binding: { generation: 'generation-one' },
    });
    expect((await claim.complete(credentials())).kind).toBe('conflict');
    const again = await reauthorizing();
    const second = claimed(
      await again.transitions.claimPending(
        again.pending.id,
        again.expected,
        returned(again.next),
      ),
    );
    committed(
      (await again.transitions.handOver(again.pending.id, second.revision))!,
    );
    expect(
      await again.transitions.discardPending(
        again.pending.id,
        'generation-two',
        'network',
      ),
    ).toBe('ended');
    expect((await again.transitions.read(again.pending.id))?.value).toEqual({
      version: 1,
      kind: 'disconnected',
      binding: expect.objectContaining({ generation: 'generation-two' }),
      reason: 'network',
    });
  });
});

describe('the address of a Pod never signed in to (#372)', () => {
  it('is saved once, kept by a sign-out and replaced by a sign-in', async () => {
    const s = await setup();
    const saved = committed(await s.transitions.remember('connection', pod));
    expect(saved.value).toEqual({
      version: 1,
      kind: 'address',
      configKey: 'app',
      connectionId: 'connection',
      podUrl: pod,
    });
    expect(await s.transitions.remember('connection', pod)).toEqual({
      kind: 'conflict',
    });
    // Nothing to retire: the address stays as it is.
    expect(
      committed(await s.transitions.disconnect(saved.id, saved.revision)),
    ).toEqual(saved);
    // Neither a code nor a refresh is claimed on it.
    await expect(
      s.transitions.claimRefresh(saved.id, saved.revision, s.attempt),
    ).rejects.toMatchObject({ problem: 'state' });
    const attempt = committed(
      await s.transitions.prepare(s.attempt, saved.revision),
    );
    expect(attempt.value).toMatchObject({ kind: 'authorizing' });
    expect(attempt.value).not.toHaveProperty('previous');
  });

  it('marks a first sign-in over it, which a failure or sign-out puts back', async () => {
    const s = await setup();
    const saved = committed(await s.transitions.remember('connection', pod));
    const attempt = committed(
      await s.transitions.prepare(s.attempt, saved.revision),
    );
    expect(attempt.value).toMatchObject({ kind: 'authorizing', address: true });
    // Signed out of (or failed): the address is back, nothing else.
    expect(
      committed(await s.transitions.disconnect(attempt.id, attempt.revision))
        .value,
    ).toEqual(saved.value);
    // A code claim keeps the mark, so a failed exchange puts it back too.
    const again = committed(
      await s.transitions.prepare(
        s.attempt,
        (await s.transitions.read(saved.id))!.revision,
      ),
    );
    const claim = claimed(
      await s.transitions.claimCode(
        again.id,
        again.revision,
        s.attempt,
        returned(s.attempt),
      ),
    );
    const stored = (await s.transitions.read(saved.id))!;
    expect(stored.value).toMatchObject({ kind: 'claimed', address: true });
    expect(
      committed(
        await s.transitions.disconnect(saved.id, stored.revision, 'expired'),
      ).value,
    ).toEqual(saved.value);
    expect(claim.kind).toBe('claimed');
  });

  it('refuses a non-canonical address and lists a malformed one as corrupt', async () => {
    const s = await setup();
    await expect(
      s.transitions.remember('connection', pod + '/'),
    ).rejects.toMatchObject({ problem: 'configuration' });
    for (const [id, value] of [
      ['slash', { podUrl: pod + '/' }],
      ['foreign', { configKey: 'other' }],
      ['moved', { connectionId: 'elsewhere' }],
    ] as const)
      await s.store.commit(id, null, {
        version: 1,
        kind: 'address',
        configKey: 'app',
        connectionId: id,
        podUrl: pod,
        ...value,
      });
    expect(await s.transitions.list()).toEqual({
      records: [],
      unreadable: [
        { id: 'foreign', problem: 'corrupt' },
        { id: 'moved', problem: 'corrupt' },
        { id: 'slash', problem: 'corrupt' },
      ],
    });
  });
});
