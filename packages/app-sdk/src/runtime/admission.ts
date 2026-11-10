import { RuntimeError } from './errors.js';
import type { BrowserRuntimeOptions } from './types.js';

type PodReadLimit = NonNullable<BrowserRuntimeOptions['podReadLimit']>;

/** After this many priority admissions in a row, a waiting normal read goes next. */
const PRIORITY_RUN = 3;

interface Job {
  readonly pod: string;
  readonly priority: boolean;
  /** Arrival order across Pods. */
  readonly seq: number;
  readonly admit: () => void;
}

/** Frees one admitted slot; later calls do nothing. */
export type Release = () => void;

/**
 * Bounded admission of explicit Pod reads (`podReadLimit`). A slot is held
 * from admission until the caller releases it, which `bindPod` does when the
 * client request settles, not when the caller stops waiting. Waiting Pods take
 * turns; a priority read goes first within its Pod and across Pods, but after
 * `PRIORITY_RUN` priority admissions in a row, overall or on one Pod, a
 * waiting normal read (of any Pod, or of that Pod) is next.
 */
export interface Admission {
  /**
   * A slot for one read on `pod`, or `undefined` once `signal` aborts while
   * the read waits: it is removed at once and never admitted. `queued` is
   * called when the read has to wait.
   */
  acquire(
    pod: string,
    priority: boolean,
    signal: AbortSignal,
    queued: () => void,
  ): Promise<Release | undefined>;
}

/** `undefined` without a limit: every read is admitted at once, as before. */
export function createAdmission(
  limit: PodReadLimit | undefined,
): Admission | undefined {
  if (limit === undefined) return undefined;
  const bound = (value: number | undefined) => {
    if (value === undefined) return Infinity;
    if (!Number.isInteger(value) || value < 1)
      throw new RuntimeError('configuration');
    return value;
  };
  const total = bound(limit.total);
  const perPod = bound(limit.perPod);
  if (total === Infinity && perPod === Infinity) return undefined;
  let running = 0;
  const inFlight = new Map<string, number>();
  /** Waiting reads per Pod in arrival order; a Pod without waiting reads has no entry. */
  const waiting = new Map<string, Job[]>();
  /**
   * When each Pod last had a read admitted (of either kind). The eligible Pod
   * admitted least recently goes next, also after its queue emptied and
   * filled again.
   */
  const turns = new Map<string, number>();
  let turn = 0;
  /** Priority admissions since the last normal one, across all Pods. */
  let streak = 0;
  /** Priority admissions since each Pod's last normal one. */
  const streaks = new Map<string, number>();
  let arrivals = 0;

  const free = (pod: string) =>
    running < total && (inFlight.get(pod) ?? 0) < perPod;
  const normal = (pod: string) => waiting.get(pod)!.find((j) => !j.priority);
  function take(pod: string, job: Job) {
    const queue = waiting.get(pod)!;
    queue.splice(queue.indexOf(job), 1);
    if (!queue.length) waiting.delete(pod);
  }
  /** The next read to admit, or `undefined` when none may start now. */
  function next(): Job | undefined {
    if (running >= total) return undefined;
    const pods = [...waiting.keys()].filter(free);
    if (!pods.length) return undefined;
    /**
     * The oldest waiting priority read of an eligible Pod. `bounded` skips a
     * Pod whose normal read waits behind `PRIORITY_RUN` priority admissions.
     */
    const priority = (bounded: boolean) => {
      let oldest: Job | undefined;
      for (const pod of pods) {
        if (bounded && (streaks.get(pod) ?? 0) >= PRIORITY_RUN && normal(pod))
          continue;
        const job = waiting.get(pod)!.find((j) => j.priority);
        if (job && (!oldest || job.seq < oldest.seq)) oldest = job;
      }
      return oldest;
    };
    if (streak < PRIORITY_RUN) {
      const job = priority(true);
      if (job) return job;
    }
    // Round robin: of the eligible Pods with a waiting normal read, the one
    // admitted least recently (a read of either kind) goes next.
    let chosen: Job | undefined;
    let oldest = Infinity;
    for (const pod of pods) {
      const job = normal(pod);
      const at = turns.get(pod) ?? -1;
      if (job && at < oldest) {
        chosen = job;
        oldest = at;
      }
    }
    // Only priority reads wait: no normal read to make room for.
    return chosen ?? priority(false);
  }
  function start(pod: string, priority: boolean): Release {
    turns.set(pod, turn++);
    if (priority) {
      streak++;
      streaks.set(pod, (streaks.get(pod) ?? 0) + 1);
    } else {
      streak = 0;
      streaks.delete(pod);
    }
    running++;
    inFlight.set(pod, (inFlight.get(pod) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      running--;
      const count = inFlight.get(pod)! - 1;
      if (count) inFlight.set(pod, count);
      else inFlight.delete(pod);
      pump();
    };
  }
  function pump() {
    for (let job = next(); job; job = next()) {
      take(job.pod, job);
      job.admit();
    }
  }
  return {
    acquire(pod, priority, signal, queued) {
      if (signal.aborted) return Promise.resolve(undefined);
      // Nothing waits that this read could overtake: a free slot is never
      // left while an eligible read waits, since every release admits.
      if (free(pod) && !waiting.has(pod))
        return Promise.resolve(start(pod, priority));
      return new Promise((resolve) => {
        const job: Job = {
          pod,
          priority,
          seq: arrivals++,
          admit: () => {
            signal.removeEventListener('abort', abort);
            resolve(start(pod, priority));
          },
        };
        const abort = () => {
          take(pod, job);
          resolve(undefined);
        };
        // Before the read joins the queue, so a failing notice leaves no job.
        queued();
        signal.addEventListener('abort', abort, { once: true });
        const queue = waiting.get(pod);
        if (queue) queue.push(job);
        else waiting.set(pod, [job]);
      });
    },
  };
}
