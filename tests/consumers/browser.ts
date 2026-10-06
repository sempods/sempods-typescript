import { bearer, createPod, decodeCatalogue } from '@sempods/client-sdk';
import { discoverPod } from '@sempods/client-sdk/oauth';
import {
  createResourceEditor,
  fields,
  listSubjects,
  newSubjectIri,
  text,
} from '@sempods/client-sdk/edit';
import { createLocale } from '@sempods/app-sdk';

function noNodeTypes() {
  // @ts-expect-error This consumer has DOM types only, no Node globals.
  return process.version;
}
void noNodeTypes;
async function main() {
  const pod = `${location.origin}/alice`;
  document.cookie = 'ambient_session=must-not-be-sent; path=/';
  const result = await discoverPod(pod, { development: 'loopback-http' });
  const contexts = decodeCatalogue(
    {
      '@id': `${pod}/_system/contexts`,
      '@type': [
        'http://www.w3.org/ns/sparql-service-description#GraphCollection',
      ],
    },
    pod,
  );
  const locale = createLocale({ locale: 'de-DE' });
  // One real read and one conditional write through the packed client.
  const reader = createPod(pod, {
    auth: bearer('consumer-token'),
    development: 'loopback-http',
  });
  const overview = await reader.sparql.select(
    'SELECT ?title ?unbound WHERE { ?s ?p ?title }',
  );
  const graph = await reader.sparql.construct('CONSTRUCT WHERE { ?s ?p ?o }');
  if (
    overview.kind !== 'ok' ||
    overview.body.rows[0]?.['title']?.type !== 'literal' ||
    overview.body.rows[0]?.['title']?.value !== 'Overview' ||
    overview.body.rows[0]?.['unbound'] !== undefined ||
    graph.kind !== 'ok' ||
    graph.body.length !== 1
  )
    throw new Error('Packed Pod queries failed');
  const tasks = reader.context(`${pod}/_system/contexts/tasks`);
  const read = await tasks.subjects.get(`${pod}/tasks/1`);
  const write =
    read.kind === 'ok'
      ? await tasks.subjects.patch(
          `${pod}/tasks/1`,
          { 'https://schema.org/name': [{ '@value': 'Done' }] },
          { ifMatch: read.etag },
        )
      : read;
  // The packed edit entry opens the same resource through the client view.
  const editor = createResourceEditor(
    tasks,
    `${pod}/tasks/1`,
    fields({ title: text('https://schema.org/name', { language: null }) }),
  );
  await editor.loaded;
  if (
    typeof listSubjects !== 'function' ||
    !newSubjectIri(tasks, 'tasks').startsWith(pod)
  )
    throw new Error('edit conveniences missing');
  document.body.textContent = `${locale.messages.reviewAccess} | ${locale.format.number(1234.5)} | ${result.issuer} | ${contexts.length} | ${read.kind} | ${write.kind} | ${editor.state.phase}`;
  document.body.dataset['ready'] = 'true';
}
void main();
