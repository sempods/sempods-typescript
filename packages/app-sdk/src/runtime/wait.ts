/** A caller can stop waiting without cancelling a shared operation. */
export function waitFor<T>(
  promise: Promise<T>,
  ...signals: (AbortSignal | undefined)[]
): Promise<T> {
  const active = signals.filter((s): s is AbortSignal => s !== undefined);
  return new Promise((resolve, reject) => {
    const cleanup = () =>
      active.forEach((s) => s.removeEventListener('abort', abort));
    const abort = () => {
      cleanup();
      reject(active.find((s) => s.aborted)?.reason);
    };
    active.forEach((s) => s.addEventListener('abort', abort, { once: true }));
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
    if (active.some((s) => s.aborted)) abort();
  });
}
