/** Combine operation lifetimes without requiring AbortSignal.any in browsers. */
export function combineSignals(...signals: (AbortSignal | undefined)[]) {
  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();
  const dispose = () => {
    for (const [signal, listener] of listeners)
      signal.removeEventListener('abort', listener);
    listeners.clear();
  };
  for (const signal of signals) {
    if (!signal || listeners.has(signal)) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      dispose();
      break;
    }
    const abort = () => {
      controller.abort(signal.reason);
      dispose();
    };
    listeners.set(signal, abort);
    signal.addEventListener('abort', abort, { once: true });
  }
  return { signal: controller.signal, dispose };
}
