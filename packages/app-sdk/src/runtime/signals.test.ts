import { expect, it, vi } from 'vitest';
import { combineSignals } from './signals.js';

it('uses the first already aborted input and detaches earlier live inputs', () => {
  const live = new AbortController();
  const first = new AbortController();
  const second = new AbortController();
  first.abort('first');
  second.abort('second');
  const remove = vi.spyOn(live.signal, 'removeEventListener');
  const combined = combineSignals(live.signal, first.signal, second.signal);
  expect(combined.signal.aborted).toBe(true);
  expect(combined.signal.reason).toBe('first');
  expect(remove).toHaveBeenCalledTimes(1);
  combined.dispose();
  expect(remove).toHaveBeenCalledTimes(1);
});

it('propagates the first abort without cancelling other inputs and releases listeners', () => {
  const caller = new AbortController();
  const lifetime = new AbortController();
  const removals = [caller, lifetime].map((c) =>
    vi.spyOn(c.signal, 'removeEventListener'),
  );
  const combined = combineSignals(caller.signal, lifetime.signal);
  caller.abort('caller');
  expect(combined.signal.aborted).toBe(true);
  expect(combined.signal.reason).toBe('caller');
  expect(lifetime.signal.aborted).toBe(false);
  lifetime.abort('later');
  expect(combined.signal.reason).toBe('caller');
  for (const remove of removals) expect(remove).toHaveBeenCalledTimes(1);
});

it('releases long-lived source listeners when an operation finishes without aborting', () => {
  const source = new AbortController();
  const add = vi.spyOn(source.signal, 'addEventListener');
  const remove = vi.spyOn(source.signal, 'removeEventListener');
  const combined = combineSignals(source.signal, undefined, source.signal);
  expect(add).toHaveBeenCalledTimes(1);
  combined.dispose();
  combined.dispose();
  expect(remove).toHaveBeenCalledTimes(1);
  source.abort();
  expect(combined.signal.aborted).toBe(false);
});
