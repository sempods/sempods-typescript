// Scheduling rules of `podReadLimit` (#244), without a runtime.
import { expect, it } from 'vitest';
import { createAdmission, type Release } from './admission.js';
import { RuntimeError } from './errors.js';

const never = new AbortController().signal;
const noop = () => {};

it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
  'rejects %s as a limit',
  (value) => {
    for (const limit of [{ total: value }, { perPod: value }])
      expect(() => createAdmission(limit)).toThrow(
        new RuntimeError('configuration'),
      );
  },
);

it('has no queue without a limit', () => {
  expect(createAdmission(undefined)).toBeUndefined();
  expect(createAdmission({})).toBeUndefined();
});

/** Queues reads in order; `order` records the admissions, `held` their releases. */
function queue(limit: { total?: number; perPod?: number }) {
  const admission = createAdmission(limit)!;
  const order: string[] = [];
  const held: Release[] = [];
  const running = new Map<string, number>();
  let total = 0;
  const maxima = { total: 0, perPod: 0 };
  function add(name: string, pod: string, priority = false, signal = never) {
    const queued = { value: false };
    const slot = admission.acquire(pod, priority, signal, () => {
      queued.value = true;
    });
    void slot.then((release) => {
      if (!release) return;
      order.push(name);
      total++;
      running.set(pod, (running.get(pod) ?? 0) + 1);
      maxima.total = Math.max(maxima.total, total);
      maxima.perPod = Math.max(maxima.perPod, running.get(pod)!);
      held.push(() => {
        total--;
        running.set(pod, running.get(pod)! - 1);
        release();
      });
    });
    return { slot, queued };
  }
  /** Releases the oldest held slot and lets its successor's admission settle. */
  async function finish() {
    held.shift()!();
    await flush();
  }
  return { add, finish, order, held, maxima };
}
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

it('admits up to the per-Pod and total limits and lets waiting Pods take turns', async () => {
  const q = queue({ perPod: 2, total: 3 });
  for (let i = 0; i < 6; i++) q.add(`a${i}`, 'A');
  for (let i = 0; i < 6; i++) q.add(`b${i}`, 'B');
  await flush();
  // A fills its two slots, B gets the third.
  expect(q.order).toEqual(['a0', 'a1', 'b0']);
  while (q.held.length) await q.finish();
  expect(q.order).toHaveLength(12);
  expect(q.maxima).toEqual({ total: 3, perPod: 2 });
  // Neither Pod drains first: B is served throughout, not after A.
  expect(q.order.indexOf('b5')).toBeLessThan(q.order.indexOf('a5') + 3);
  expect(q.order.indexOf('a5')).toBeLessThan(q.order.indexOf('b5') + 3);
});

it('serves every waiting Pod before a Pod whose queue emptied and filled again', async () => {
  const q = queue({ total: 1 });
  for (let i = 0; i < 5; i++) q.add(`a${i}`, 'A');
  for (const pod of ['B', 'C', 'D', 'E']) q.add(pod.toLowerCase(), pod);
  await flush();
  while (q.held.length) await q.finish();
  expect(q.order).toEqual(['a0', 'b', 'c', 'd', 'e', 'a1', 'a2', 'a3', 'a4']);
  // A Pod that waited longest goes first, though it arrived after A again.
  const r = queue({ total: 1 });
  r.add('a0', 'A');
  r.add('b0', 'B');
  r.add('b1', 'B');
  await flush();
  await r.finish(); // a0; A's queue is empty now, B's turn
  r.add('a1', 'A');
  while (r.held.length) await r.finish();
  expect(r.order).toEqual(['a0', 'b0', 'a1', 'b1']);
});

it('a free slot goes to a read of another Pod while one Pod is at its limit', async () => {
  const q = queue({ perPod: 1, total: 4 });
  q.add('a0', 'A');
  const waiting = q.add('a1', 'A');
  const other = q.add('b0', 'B');
  await flush();
  expect(q.order).toEqual(['a0', 'b0']);
  expect(waiting.queued.value).toBe(true);
  expect(other.queued.value).toBe(false);
});

it('gives priority reads at most three admissions in a row while a normal read waits', async () => {
  const q = queue({ perPod: 1 });
  q.add('blocker', 'A');
  for (let i = 1; i <= 3; i++) q.add(`n${i}`, 'A');
  for (let i = 1; i <= 5; i++) q.add(`p${i}`, 'A', true);
  await flush();
  while (q.held.length) await q.finish();
  expect(q.order).toEqual([
    'blocker',
    'p1',
    'p2',
    'p3',
    'n1',
    'p4',
    'p5',
    'n2',
    'n3',
  ]);
});

it('takes the oldest priority read across Pods and never exceeds a limit for it', async () => {
  const q = queue({ perPod: 1, total: 2 });
  q.add('a0', 'A');
  q.add('b0', 'B');
  q.add('bn', 'B');
  q.add('ap', 'A', true);
  q.add('bp', 'B', true);
  await flush();
  // Both Pods are at their limit: priority waits like any other read.
  expect(q.order).toEqual(['a0', 'b0']);
  await q.finish(); // a0: A is free, so A's priority read goes next.
  expect(q.order.at(-1)).toBe('ap');
  await q.finish(); // b0: B's priority read before its older normal one.
  expect(q.order.at(-1)).toBe('bp');
  while (q.held.length) await q.finish();
  expect(q.order).toEqual(['a0', 'b0', 'ap', 'bp', 'bn']);
});

it('drops a read whose signal aborts while it waits, and admits the next one', async () => {
  const q = queue({ perPod: 1 });
  q.add('a0', 'A');
  const stop = new AbortController();
  const dropped = q.add('a1', 'A', false, stop.signal);
  q.add('a2', 'A');
  await flush();
  stop.abort();
  expect(await dropped.slot).toBeUndefined();
  await q.finish();
  expect(q.order).toEqual(['a0', 'a2']);
  const aborted = new AbortController();
  aborted.abort();
  const late = queue({ perPod: 1 });
  const read = late.add('x', 'A', false, aborted.signal);
  expect(await read.slot).toBeUndefined();
  expect(read.queued.value).toBe(false);
});

it('frees a slot once, however often it is released', async () => {
  const admission = createAdmission({ perPod: 1 })!;
  const first = (await admission.acquire('A', false, never, noop))!;
  const order: string[] = [];
  void admission
    .acquire('A', false, never, noop)
    .then(() => order.push('second'));
  void admission
    .acquire('A', false, never, noop)
    .then(() => order.push('third'));
  first();
  first();
  await flush();
  expect(order).toEqual(['second']);
});
