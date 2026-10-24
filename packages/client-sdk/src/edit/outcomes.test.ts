import { expect, it, vi } from 'vitest';
import { SdkError, type JsonLd, type WriteResult } from '../index.js';
import {
  fields,
  text,
  snapshots,
  updateFields,
  removeSnapshot,
  prepareCreation,
  type EditProblem,
  type ResourceSource,
} from './index.js';

const definition = fields({ title: text('urn:title', { language: null }) });
const body: JsonLd = {
  '@id': 'urn:item',
  'urn:title': [{ '@value': 'Before' }],
};
function setup() {
  const get = vi
    .fn<ResourceSource['subjects']['get']>()
    .mockResolvedValue({ kind: 'ok', body, etag: '"v1"' });
  const write = vi
    .fn<() => Promise<WriteResult>>()
    .mockResolvedValue({ kind: 'applied', status: 204 });
  const source: ResourceSource = {
    subjects: { get, patch: write, put: write, delete: write },
  };
  const snapshot = snapshots(source, [body], definition).items[0]!;
  return {
    get,
    write,
    creation: prepareCreation(source, 'urn:new', bodyWithoutId()),
    run: {
      update: () =>
        updateFields(source, snapshot, definition, { title: 'After' }),
      remove: () => removeSnapshot(source, snapshot, definition),
      create: () => prepareCreation(source, 'urn:new', bodyWithoutId()).run(),
    },
  };
}
function bodyWithoutId() {
  return { 'urn:title': [{ '@value': 'New' }] };
}

it.each(['update', 'remove', 'create'] as const)(
  '#122: %s retains refusal and not-sent detail',
  async (operation) => {
    const cases: readonly [WriteResult, EditProblem][] = [
      [
        { kind: 'refused', status: 401 },
        { kind: 'refused', status: 401 },
      ],
      [
        { kind: 'refused', status: 403 },
        { kind: 'refused', status: 403 },
      ],
      [
        { kind: 'not-sent', reason: 'cancelled' },
        { kind: 'unavailable', reason: 'cancelled' },
      ],
      [
        { kind: 'not-sent', reason: 'stopped' },
        { kind: 'unavailable', reason: 'stopped' },
      ],
      [{ kind: 'not-found' }, { kind: 'not-found' }],
    ];
    for (const [result, problem] of cases) {
      const f = setup();
      f.write.mockResolvedValue(result);
      const outcome = await f.run[operation]();
      expect(outcome).toEqual({
        kind:
          operation === 'update'
            ? 'not-saved'
            : operation === 'remove'
              ? 'not-removed'
              : 'not-created',
        reason: problem.kind,
        problem,
      });
    }
  },
);
it.each(['update', 'remove', 'create'] as const)(
  '#122: %s preserves an SDK failure raised before sending',
  async (operation) => {
    const f = setup();
    f.write.mockRejectedValue(
      new SdkError({ code: 'authentication' }, 'diagnostic only'),
    );
    expect(await f.run[operation]()).toMatchObject({
      reason: 'failure',
      problem: { kind: 'failure', failure: { code: 'authentication' } },
    });
  },
);
it.each(['update', 'remove'] as const)(
  '#122: %s retains mapping and read-invalidation detail',
  async (operation) => {
    const f = setup();
    f.get.mockResolvedValue({
      kind: 'ok',
      body: {
        ...body,
        'urn:title': [{ '@value': 'One' }, { '@value': 'Two' }],
      },
      etag: '"v2"',
    });
    expect(await f.run[operation]()).toMatchObject({
      reason: 'not-mappable',
      problem: { kind: 'not-mappable', predicate: 'urn:title' },
    });
    f.get.mockResolvedValue({ kind: 'invalidated' });
    expect(await f.run[operation]()).toMatchObject({
      reason: 'unavailable',
      problem: { kind: 'unavailable', reason: 'invalidated' },
    });
    f.get.mockResolvedValue({ kind: 'refused', status: 401 });
    expect(await f.run[operation]()).toMatchObject({
      reason: 'refused',
      problem: { kind: 'refused', status: 401 },
    });
    expect(f.write).not.toHaveBeenCalled();
  },
);
it.each(['update', 'remove', 'create'] as const)(
  '#122: %s never turns a lost answer into a definite failure',
  async (operation) => {
    const f = setup();
    f.write.mockResolvedValue({
      kind: 'uncertain',
      failure: { code: 'transport', problem: 'network' },
    });
    const outcome = await f.run[operation]();
    expect(outcome.kind).toBe('unconfirmed');
    expect(outcome).not.toHaveProperty('problem');
    expect(outcome).not.toHaveProperty('reason');
    await f.creation.run();
    f.write.mockResolvedValue({ kind: 'refused', status: 403 });
    expect(await f.creation.run()).toEqual({ kind: 'unconfirmed' });
  },
);
