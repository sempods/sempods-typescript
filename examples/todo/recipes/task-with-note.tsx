import type { BrowserRuntime } from '@sempods/app-sdk';
import { fields, iri, text } from '@sempods/client-sdk/edit';
import {
  AppAccess,
  SempodsProvider,
  UpdateNotice,
  useCreation,
} from '@sempods/app-sdk/react';

const schema = 'https://schema.org/';
const task = fields(
  { title: text(schema + 'name', { language: null }) },
  { type: schema + 'Action' },
);
const note = fields(
  {
    text: text(schema + 'text', { language: null }),
    about: iri(schema + 'about'),
  },
  { type: schema + 'Comment' },
);

/**
 * One input, two Contexts: the task goes into a shared Context, its private
 * note into a personal one and points to the task (`schema:about`). Pick the
 * two Context IRIs with `useContexts()` or fix them with presets.
 *
 * These are two separate creations, each with its own outcome: there is no
 * transaction across Contexts. The task is created first, and the note keeps
 * its IRI from the first attempt on, also when the task's answer was lost.
 * The note is sent once the task is confirmed: at once, or after its check
 * and acknowledgement; a task found absent is retried under the same IRI.
 * A refused or unconfirmed note keeps its own draft for a retry that sends
 * only the note. The task is never created twice, and nothing is resent by
 * itself.
 */
export function TaskWithNote({
  shared,
  personal,
}: {
  readonly shared: string;
  readonly personal: string;
}) {
  const taskCreation = useCreation(task, {
    initial: { title: '' },
    collection: 'tasks',
    context: shared,
  });
  const noteCreation = useCreation(note, {
    initial: { text: '', about: '' },
    collection: 'notes',
    context: personal,
  });
  // The note points to the one task this form writes, from its first attempt.
  const linked = noteCreation.draft.about !== '';
  // The task still needs sending: its first attempt, or the retry of the same
  // IRI after a check found it absent. An unresolved task waits for its check.
  const taskToSend =
    !linked || (!taskCreation.canEdit && taskCreation.canCreate);
  const taskUnresolved = !taskCreation.canEdit && !taskCreation.canCreate;
  const hasNote = noteCreation.draft.text.trim() !== '';

  async function save() {
    if (!hasNote || taskUnresolved) return;
    if (taskToSend) {
      const outcome = await taskCreation.create();
      if (outcome) noteCreation.change({ about: outcome.iri });
      if (outcome?.kind !== 'created') return;
    }
    await noteCreation.create();
  }

  return (
    <section aria-label="New task with a private note">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label>
          Task
          <input
            disabled={linked || !taskCreation.canEdit}
            value={taskCreation.draft.title}
            onChange={(e) => taskCreation.change({ title: e.target.value })}
          />
        </label>
        <label>
          Private note
          <textarea
            disabled={!noteCreation.canEdit}
            value={noteCreation.draft.text}
            onChange={(e) => noteCreation.change({ text: e.target.value })}
          />
        </label>
        <button
          disabled={
            !hasNote ||
            taskUnresolved ||
            (taskToSend ? !taskCreation.canCreate : !noteCreation.canCreate)
          }
        >
          {linked ? 'Save the note again' : 'Save'}
        </button>
      </form>
      {linked && !taskToSend && !taskUnresolved && (
        <p role="status">The task is saved; its private note is not yet.</p>
      )}
      {/* Each part reports its own outcome. */}
      <UpdateNotice {...taskCreation.notice} quiet />
      <UpdateNotice {...noteCreation.notice} quiet />
      {(taskCreation.refused || noteCreation.refused) && (
        <p role="alert">This app cannot write into one of these Contexts.</p>
      )}
    </section>
  );
}

/** The host creates/disposes the stable runtime and serves this on the callback too. */
export function TaskWithNoteExample({
  runtime,
  shared,
  personal,
}: {
  readonly runtime: BrowserRuntime;
  readonly shared: string;
  readonly personal: string;
}) {
  return (
    <SempodsProvider runtime={runtime} contextSelection="on-demand">
      <AppAccess appName="Tasks" />
      <TaskWithNote shared={shared} personal={personal} />
    </SempodsProvider>
  );
}
