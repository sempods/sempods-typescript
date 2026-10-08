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
    'Usage: SEMPODS_TOKEN via environment; node main.js POD CONTEXT [list|create TITLE|create-at IRI TITLE|rename IRI TITLE|complete IRI|reopen IRI|delete IRI]',
  );
}

if (
  ![
    'list',
    'create',
    'create-at',
    'rename',
    'complete',
    'reopen',
    'delete',
  ].includes(command)
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
} else if (command === 'create' || command === 'create-at') {
  const iri = command === 'create-at' ? args[0] : newSubjectIri(view, 'tasks');
  if (!iri) throw new Error('Resource IRI required');
  const title = (command === 'create-at' ? args.slice(1) : args)
    .join(' ')
    .trim();

  const creation = prepareCreation(view, iri, taskFields, {
    title,
    done: false,
  });

  // Keep the printed IRI and title; use create-at for an explicit same-IRI retry.
  const outcome = await creation.run();
  console.log(JSON.stringify({ iri, outcome }, null, 2));
} else {
  const iri = args[0];
  if (!iri) throw new Error('Resource IRI required');

  const editor = createResourceEditor(view, iri, taskFields);
  try {
    const opened = await editor.loaded;
    if (opened.phase !== 'ready') throw new Error('Resource unavailable');

    if (command === 'delete') {
      const outcome = await editor.remove();
      console.log(JSON.stringify({ outcome, state: editor.state }, null, 2));
    } else {
      const change =
        command === 'rename'
          ? { title: args.slice(1).join(' ') }
          : { done: command === 'complete' };

      editor.change(change);
      const outcome = await editor.save();
      console.log(JSON.stringify({ outcome, state: editor.state }, null, 2));
    }
  } finally {
    editor.dispose();
  }
}
