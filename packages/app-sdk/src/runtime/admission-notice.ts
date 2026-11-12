/** Whether a read waits for a slot (`queued`) or was sent past admission (`admitted`). */
export type AdmissionEvent = 'queued' | 'admitted';

interface Watch {
  readonly notice: (event: AdmissionEvent) => void;
  /** The loader's live priority for the reads of this run. */
  readonly current?: () => boolean;
}

const watches = new WeakMap<AbortSignal, Watch>();

/**
 * Tells a loader what happened to the Pod reads that carry its own signal, so
 * waiting for a slot never spends its recovery retry, and lets admission ask
 * the loader's priority (`current`) while those reads wait. Internal: a read
 * that passes another signal is not recognised; it counts as sent and keeps
 * only its own `priority` option, as before.
 */
export function watchAdmission(
  signal: AbortSignal,
  notice: (event: AdmissionEvent) => void,
  current?: () => boolean,
) {
  watches.set(signal, current ? { notice, current } : { notice });
}
export function noticeAdmission(
  signal: AbortSignal | undefined,
  event: AdmissionEvent,
) {
  try {
    if (signal) watches.get(signal)?.notice(event);
  } catch (error) {
    // A notice never stops a read or leaks its slot.
    queueMicrotask(() => {
      throw error;
    });
  }
}
/** The live priority a loader set for reads that carry its signal, if any. */
export function admissionPriority(
  signal: AbortSignal | undefined,
): (() => boolean) | undefined {
  return signal ? watches.get(signal)?.current : undefined;
}
