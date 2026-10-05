import type { JsonLd, WriteOptions, WriteResult } from '../results.js';
import {
  isFieldDefinition,
  owned,
  type Field,
  type FieldDefinition,
} from './fields.js';
import {
  fetchResource,
  problemOf,
  writeProblem,
  type EditProblem,
  type ResourceSource,
} from './source.js';
import {
  frozenCopy,
  sameData,
  sameNode,
  sameTerms,
  termsOf,
  type Term,
} from './terms.js';
import { ABSOLUTE_IRI } from '../iri.js';

/**
 * What a person saw for one subject. Only `snapshots()` creates one; it is
 * bound to its source and definition and rejected anywhere else. Its evidence
 * is a private copy, so later changes to the query data cannot alter it.
 */
export interface Snapshot<D> {
  readonly iri: string;
  readonly data: D;
}
export interface SnapshotList<D> {
  readonly items: readonly Snapshot<D>[];
  /** Nodes that are not mappable subjects of this definition. */
  readonly skipped: number;
}

interface Evidence {
  readonly source: ResourceSource;
  readonly definition: FieldDefinition<unknown>;
  /** Per field: the owned terms that were seen (including their absence). */
  readonly terms: ReadonlyMap<string, readonly Term[]>;
  /** The whole description that was seen, for deleting exactly that version. */
  readonly node: JsonLd;
}
const evidence = new WeakMap<object, Evidence>();

function seen(
  definition: FieldDefinition<unknown>,
  node: JsonLd,
): Map<string, readonly Term[]> {
  return new Map(
    Object.entries(definition.fields as Record<string, Field>).map(
      ([name, field]) => [name, owned(field, termsOf(node, field.predicate))],
    ),
  );
}

function capture<D>(
  source: ResourceSource,
  definition: FieldDefinition<D>,
  node: JsonLd,
): Snapshot<D> {
  const id = node['@id'];
  // Only an absolute IRI can be read and written again; blank nodes (`_:…`)
  // and relative identifiers are not editable subjects.
  if (typeof id !== 'string' || !ABSOLUTE_IRI.test(id))
    throw new TypeError('A subject needs an absolute IRI.');
  const copy = frozenCopy(node);
  const data = frozenCopy(definition.read(copy));
  const snapshot = Object.freeze({ iri: id, data });
  evidence.set(snapshot, {
    source,
    definition: definition as FieldDefinition<unknown>,
    terms: seen(definition as FieldDefinition<unknown>, copy),
    node: copy,
  });
  return snapshot;
}

/**
 * Snapshots from query nodes (for example `CONSTRUCT { ?s ?p ?o }`). The query
 * must return the fields' terms completely; strict per item, tolerant per list.
 * Nodes without an absolute IRI (blank nodes) are skipped: they cannot be
 * addressed by a later update or deletion.
 * Deleting from a snapshot additionally needs the subject's whole description
 * in the target context; a projection makes `removeSnapshot` report a change.
 */
export function snapshots<D>(
  source: ResourceSource,
  nodes: readonly JsonLd[],
  definition: FieldDefinition<D>,
): SnapshotList<D> {
  if (!isFieldDefinition(definition))
    throw new TypeError('Snapshots need a definition created by fields().');
  const items: Snapshot<D>[] = [];
  const ids = new Set<string>();
  let skipped = 0;
  for (const node of nodes) {
    try {
      const snapshot = capture(source, definition, node);
      if (ids.has(snapshot.iri)) throw new TypeError('Duplicate subject.');
      ids.add(snapshot.iri);
      items.push(snapshot);
    } catch {
      skipped++;
    }
  }
  return Object.freeze({ items: Object.freeze(items), skipped });
}

type Failed = { readonly reason: EditProblem['kind'] };
export type UpdateOutcome<D> =
  | { readonly kind: 'saved' }
  /**
   * What this operation depends on changed. `current` is a fresh snapshot to
   * decide on, `null` when the resource is absent, `undefined` when it could
   * not be read.
   */
  | {
      readonly kind: 'changed-on-pod';
      readonly current: Snapshot<D> | null | undefined;
    }
  /** The answer was lost; never resent. `desiredObserved` is not proof. */
  | {
      readonly kind: 'unconfirmed';
      readonly current: Snapshot<D> | null | undefined;
      readonly desiredObserved: boolean;
    }
  | ({ readonly kind: 'not-saved' } & Failed);
export type RemoveSnapshotOutcome<D> =
  | { readonly kind: 'removed' }
  | {
      readonly kind: 'changed-on-pod';
      readonly current: Snapshot<D> | null | undefined;
    }
  | {
      readonly kind: 'unconfirmed';
      readonly current: Snapshot<D> | null | undefined;
      readonly desiredObserved: boolean;
    }
  | ({ readonly kind: 'not-removed' } & Failed);

function verified<D>(
  source: ResourceSource,
  snapshot: Snapshot<D>,
  definition: FieldDefinition<D>,
): Evidence {
  const proof = evidence.get(snapshot);
  if (
    !isFieldDefinition(definition) ||
    !proof ||
    proof.source !== source ||
    proof.definition !== definition
  )
    throw new TypeError(
      'This snapshot was taken from another source or definition.',
    );
  return proof;
}

type Current<D> =
  | {
      readonly kind: 'ok';
      readonly body: JsonLd;
      readonly etag: string;
      readonly snapshot: Snapshot<D>;
    }
  | { readonly kind: 'absent' }
  | { readonly kind: 'problem'; readonly problem: EditProblem };

async function current<D>(
  source: ResourceSource,
  iri: string,
  definition: FieldDefinition<D>,
  signal?: AbortSignal,
): Promise<Current<D>> {
  const fetched = await fetchResource(source, iri, signal);
  if (fetched.kind === 'not-found') return { kind: 'absent' };
  if (fetched.kind === 'problem') return fetched;
  try {
    const body = frozenCopy({ ...fetched.body, '@id': iri });
    return {
      kind: 'ok',
      body,
      etag: fetched.etag,
      snapshot: capture(source, definition, body),
    };
  } catch (error) {
    return { kind: 'problem', problem: problemOf(error) };
  }
}

function seenAgain(
  proof: Evidence,
  definition: FieldDefinition<unknown>,
  body: JsonLd,
  names: readonly string[],
): boolean {
  const now = seen(definition, body);
  return names.every((name) =>
    sameTerms(proof.terms.get(name) ?? [], now.get(name) ?? []),
  );
}

const known = <D>(after: Current<D>): Snapshot<D> | null | undefined =>
  after.kind === 'ok'
    ? after.snapshot
    : after.kind === 'absent'
      ? null
      : undefined;

/** Shared tail: a write against the current version, then the standard review. */
async function conditional<D, O>(
  source: ResourceSource,
  snapshot: Snapshot<D>,
  definition: FieldDefinition<D>,
  unchanged: (proof: Evidence, body: JsonLd) => boolean,
  /** Field updates may rebase once; a deletion never retries against a new version. */
  rebase: boolean,
  write: (now: Current<D> & { kind: 'ok' }) => Promise<WriteResult>,
  desired: (now: Current<D>) => boolean,
  outcome: {
    readonly done: O;
    readonly failed: (reason: EditProblem['kind']) => O;
    readonly changed: (current: Snapshot<D> | null | undefined) => O;
    readonly unconfirmed: (
      current: Snapshot<D> | null | undefined,
      desiredObserved: boolean,
    ) => O;
  },
  options: WriteOptions,
): Promise<O> {
  const proof = verified(source, snapshot, definition);
  let now = await current(source, snapshot.iri, definition, options.signal);
  if (now.kind === 'problem') return outcome.failed(now.problem.kind);
  if (now.kind === 'absent') return outcome.changed(null);
  if (!unchanged(proof, now.body)) return outcome.changed(now.snapshot);
  let result: WriteResult;
  for (let retried = false; ; retried = true) {
    try {
      result = await write(now);
    } catch (error) {
      return outcome.failed(problemOf(error).kind);
    }
    if (result.kind !== 'precondition-failed') break;
    // Reconciliation reads stay cancellable; a cancelled one is unknown.
    const after = await current(
      source,
      snapshot.iri,
      definition,
      options.signal,
    );
    // Bounded rebase: once, when what this operation depends on still holds.
    if (
      !rebase ||
      retried ||
      after.kind !== 'ok' ||
      !unchanged(proof, after.body)
    )
      return outcome.changed(known(after));
    now = after;
  }
  switch (result.kind) {
    case 'applied':
      return outcome.done;
    case 'uncertain': {
      const after = await current(
        source,
        snapshot.iri,
        definition,
        options.signal,
      );
      return outcome.unconfirmed(
        known(after),
        after.kind !== 'problem' && desired(after),
      );
    }
    default:
      return outcome.failed(writeProblem(result).kind);
  }
}

/**
 * One-click update from a list (for example "Done"): reads the current
 * version, checks that the changed fields still hold what the person saw,
 * then patches conditionally. Other fields keep their current values.
 */
export async function updateFields<D>(
  source: ResourceSource,
  snapshot: Snapshot<D>,
  definition: FieldDefinition<D>,
  change: Partial<D>,
  options: WriteOptions = {},
): Promise<UpdateOutcome<D>> {
  // One command, captured before any await: checked, written and compared alike.
  const command = frozenCopy(
    Object.fromEntries(
      Object.entries(change).filter(([, value]) => value !== undefined),
    ),
  ) as Partial<D>;
  const names = Object.keys(command);
  for (const name of names)
    if (!(name in definition.fields))
      throw new TypeError(`Unknown field: ${name}`);
  let wanted: D | undefined;
  return conditional<D, UpdateOutcome<D>>(
    source,
    snapshot,
    definition,
    (proof, body) =>
      seenAgain(proof, definition as FieldDefinition<unknown>, body, names),
    true,
    (now) => {
      wanted = { ...now.snapshot.data, ...command };
      if (definition.valid && !definition.valid(wanted))
        throw new TypeError('The changed values are not valid.');
      const patch = definition.patch(now.body, wanted);
      // Nothing differs: no request; settles as saved like an applied patch.
      if (Object.keys(patch).length === 0)
        return Promise.resolve({ kind: 'applied', status: 204 } as const);
      return source.subjects.patch(
        snapshot.iri,
        patch,
        { ifMatch: now.etag },
        options,
      );
    },
    (now) =>
      now.kind === 'ok' &&
      wanted !== undefined &&
      names.every((name) =>
        sameData(
          (now.snapshot.data as Record<string, unknown>)[name],
          (wanted as Record<string, unknown>)[name],
        ),
      ),
    {
      done: { kind: 'saved' },
      failed: (reason) => ({ kind: 'not-saved', reason }),
      changed: (current) => ({ kind: 'changed-on-pod', current }),
      unconfirmed: (current, desiredObserved) => ({
        kind: 'unconfirmed',
        current,
        desiredObserved,
      }),
    },
    options,
  );
}

/**
 * Deletes the version the person saw: the whole current description must
 * equal the seen one (not only the mapped fields), and the delete is
 * conditional on the version just read.
 */
export async function removeSnapshot<D>(
  source: ResourceSource,
  snapshot: Snapshot<D>,
  definition: FieldDefinition<D>,
  options: WriteOptions = {},
): Promise<RemoveSnapshotOutcome<D>> {
  return conditional<D, RemoveSnapshotOutcome<D>>(
    source,
    snapshot,
    definition,
    (proof, body) => sameNode(proof.node, body),
    false,
    (now) =>
      source.subjects.delete(snapshot.iri, { ifMatch: now.etag }, options),
    (now) => now.kind === 'absent',
    {
      done: { kind: 'removed' },
      failed: (reason) => ({ kind: 'not-removed', reason }),
      changed: (current) => ({ kind: 'changed-on-pod', current }),
      unconfirmed: (current, desiredObserved) => ({
        kind: 'unconfirmed',
        current,
        desiredObserved,
      }),
    },
    options,
  );
}
