import { useState } from 'react';
import { AppAccess, TargetScreen } from '@sempods/app-sdk/react';
import { Input } from '@sempods/app-ui';
import { MarkdownField, MarkdownView } from '@sempods/app-ui/markdown';
import { TaskNotes } from './task-notes';

/**
 * Notes as another app may have stored them: Markdown with emphasis, a
 * typed and a hard line break, lists and a web link, beside embedded HTML, an image,
 * a script address and an image in HTML that a reader must not fetch.
 */
const SAMPLE = [
  '# Plan',
  '',
  'Call **before noon** and ask for *Ms Weber*.',
  'The second line of the paragraph.',
  '',
  'Bring the key  ',
  'and the ladder.',
  '',
  '- Shut off the water',
  '- Read the [manual](https://manual.example/tap)',
  '',
  '1. Photo of the tap',
  '2. Model number',
  '',
  '<img src="https://media.example/html.gif" alt="html"> <b>not bold</b>',
  '',
  '![Photo of the tap](https://media.example/tap.png)',
  '',
  '[run](javascript:window.hacked=1)',
].join('\n');

/** A long draft: 400 headings, each with a paragraph. */
const LONG = Array.from(
  { length: 400 },
  (_, i) => `## Step ${i + 1}\n\nCheck **part ${i + 1}** twice.`,
).join('\n\n');

/**
 * The Markdown entry (`?screen=markdown`, #395). Without `part`, no
 * sign-in: a reading view of `SAMPLE`, and a form with a title and the
 * notes as a `MarkdownField`, followed by a button. `notes=empty` starts the
 * notes empty, `notes=short` with “Buy milk”, `notes=marks` with marks between letters, `notes=boundary` with bold next to a space, `notes=long` with a long draft, `write` in the write
 * presentation. The draft and the number of changes the field reported are
 * on the page. With `part=editor`, after sign-in, the README's
 * `task-notes.tsx` edits the fixture's plumber task in its source Context.
 */
export function MarkdownGate({
  part,
  notes,
  write,
}: {
  readonly part: string | null;
  readonly notes: string | null;
  readonly write: boolean;
}) {
  if (part === 'editor')
    return (
      <main className="gate-main">
        <AppAccess appName="Focus" />
        <TargetScreen>
          <h1>Call the plumber</h1>
          <TaskNotes
            subject={location.origin + '/alice/tasks/1'}
            context={location.origin + '/alice/_system/contexts/work'}
          />
        </TargetScreen>
      </main>
    );
  return <MarkdownForm notes={notes} write={write} />;
}

function MarkdownForm({
  notes,
  write,
}: {
  readonly notes: string | null;
  readonly write: boolean;
}) {
  const [title, setTitle] = useState('Call the plumber');
  const [value, setValue] = useState(
    () =>
      ({
        empty: '',
        short: 'Buy milk',
        marks: 'a**b**c ab~~c~~',
        boundary: 'Keep **(optional)** items',
        long: LONG,
      })[notes ?? ''] ?? SAMPLE,
  );
  const [changes, setChanges] = useState(0);
  return (
    <main className="gate-main">
      <section aria-label="Task details">
        <h2>Task details</h2>
        <MarkdownView source={SAMPLE} />
      </section>
      <form className="grid gap-5" onSubmit={(event) => event.preventDefault()}>
        <h2>Edit</h2>
        <label className="grid gap-1.5">
          Title
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <MarkdownField
          label="Notes"
          value={value}
          defaultPresentation={write ? 'write' : 'read'}
          onChange={(source) => {
            setChanges((n) => n + 1);
            setValue(source);
          }}
        />
        <button type="button">After the notes</button>
      </form>
      <output data-draft={JSON.stringify(value)} data-changes={changes} />
    </main>
  );
}
