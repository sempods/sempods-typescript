/** Whether a read waits for a slot (`queued`) or was sent past admission (`admitted`). */
export type AdmissionEvent = 'queued' | 'admitted';

const notices = new WeakMap<AbortSignal, (event: AdmissionEvent) => void>();

/**
 * Tells a loader what happened to the Pod reads that carry its own signal, so
 * waiting for a slot never spends its recovery retry. Internal: a read that
 * passes another signal is not recognised and counts as sent, as before.
 */
export function watchAdmission(
  signal: AbortSignal,
  notice: (event: AdmissionEvent) => void,
) {
  notices.set(signal, notice);
}
export function noticeAdmission(
  signal: AbortSignal | undefined,
  event: AdmissionEvent,
) {
  try {
    if (signal) notices.get(signal)?.(event);
  } catch (error) {
    // A notice never stops a read or leaks its slot.
    queueMicrotask(() => {
      throw error;
    });
  }
}
