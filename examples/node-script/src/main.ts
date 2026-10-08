import { bearer, createPod } from '@sempods/client-sdk';
import {
  createResourceEditor,
  listSubjects,
  newSubjectIri,
  prepareCreation,
} from '@sempods/client-sdk/edit';
import { supportedTasks, taskFields } from '../../todo/src/domain.js';

const [podUrl, contextIri, command = 'list', ...args] = process.argv.slice(2);
const token = process.env['SEMPODS_TOKEN'];

if (!podUrl || !contextIri || !token) {
  throw new Error(
    'Usage: SEMPODS_TOKEN via environment; node main.js POD CONTEXT [list|create TITLE|rename IRI TITLE|complete IRI|reopen IRI|delete IRI]',
  );
}

if (
  !['list', 'create', 'rename', 'complete', 'reopen', 'delete'].includes(
    command,
  )
) {
  throw new Error('Unknown command');
}

const pod = createPod(podUrl, {
  auth: bearer(token),
  ...(new URL(podUrl).protocol === 'http:'
    ? { development: 'loopback-http' as const }
    : {}),
});
const view = pod.context(contextIri);

if (command === 'list') {
  const result = await listSubjects(view, taskFields);
  if (result.kind !== 'ok') throw new Error(`List unavailable: ${result.kind}`);

  const tasks = supportedTasks(result.body);
  console.log(
    JSON.stringify(
      tasks.items.map((item) => ({ iri: item.iri, ...item.data })),
      null,
      2,
    ),
  );
} else if (command === 'create') {
  const iri = newSubjectIri(view, 'tasks');
  const creation = prepareCreation(view, iri, taskFields, {
    title: args.join(' ').trim(),
    done: false,
  });

  // An unconfirmed outcome keeps this IRI; do not create a replacement task.
  console.log(iri, await creation.run());
} else {
  const iri = args[0];
  if (!iri) throw new Error('Resource IRI required');

  const editor = createResourceEditor(view, iri, taskFields);
  try {
    const opened = await editor.loaded;
    if (opened.phase !== 'ready') throw new Error('Resource unavailable');

    if (command === 'delete') {
      const outcome = await editor.remove();
      console.log({ outcome, state: editor.state });
    } else {
      const change =
        command === 'rename'
          ? { title: args.slice(1).join(' ') }
          : { done: command === 'complete' };

      editor.change(change);
      const outcome = await editor.save();
      console.log({ outcome, state: editor.state });
    }
  } finally {
    editor.dispose();
  }
}
