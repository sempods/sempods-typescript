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
function claimed<T extends { kind: 'claimed' } | { kind: 'conflict' }>(
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
    expect(JSON.stringify(saved)).not.toContain('refresh-one');
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
