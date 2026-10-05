import { createPod, bearer } from '@sempods/client-sdk';
import {
  createResourceEditor,
  prepareCreation,
  newSubjectIri,
  listSubjects,
} from '@sempods/client-sdk/edit';
import { supportedTasks, taskFields } from '../../todo/src/domain.js';
const [podUrl, contextIri, command = 'list', ...args] = process.argv.slice(2);
if (!podUrl || !contextIri || !process.env['SEMPODS_TOKEN'])
  throw new Error(
    'Usage: SEMPODS_TOKEN via environment; node main.js POD CONTEXT [list|create TITLE|rename IRI TITLE|complete IRI|reopen IRI|delete IRI]',
  );
const token = process.env['SEMPODS_TOKEN'];
const pod = createPod(podUrl, {
  auth: bearer(token),
  ...(new URL(podUrl).protocol === 'http:'
    ? { development: 'loopback-http' as const }
    : {}),
});
const view = pod.context(contextIri);
if (command === 'list') {
  const result = await listSubjects(view, taskFields);
  if (result.kind !== 'ok') throw new Error('List unavailable');
  console.log(
    JSON.stringify(
      supportedTasks(result.body).items.map((i) => ({ iri: i.iri, ...i.data })),
      null,
      2,
    ),
  );
} else if (command === 'create') {
  const id = newSubjectIri(view, 'tasks');
  console.log(
    id,
    await prepareCreation(view, id, taskFields, {
      title: args.join(' ').trim(),
      done: false,
    }).run(),
  );
} else {
  const iri = args[0];
  if (!iri) throw new Error('Resource IRI required');
  const editor = createResourceEditor(view, iri, taskFields);
  await editor.loaded;
  if (editor.state.phase !== 'ready' || !editor.state.draft)
    throw new Error('Resource unavailable');
  if (command === 'delete') console.log(await editor.remove());
  else {
    if (!['rename', 'complete', 'reopen'].includes(command))
      throw new Error('Unknown command');
    editor.change({
      ...(command === 'rename'
        ? { title: args.slice(1).join(' ') }
        : { done: command === 'complete' }),
    });
    console.log(await editor.save());
  }
  editor.dispose();
}
