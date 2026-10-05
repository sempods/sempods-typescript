import type { ReactNode } from 'react';
import {
  UpdateNotice,
  useAppState,
  useCreation,
  useList,
  useSdkLocale,
  useWorkflowAccess,
} from '@sempods/app-sdk/react';
import { fields, flag, text } from '@sempods/client-sdk/edit';
const schema = 'https://schema.org/';
// Same narrow Action profile as TODO, private to this library.
const taskFields = fields(
  {
    title: text(schema + 'name', { language: null }),
    done: flag(schema + 'actionStatus', {
      on: schema + 'CompletedActionStatus',
      off: schema + 'PotentialActionStatus',
    }),
  },
  { type: schema + 'Action' },
);
const emptyTask = { title: '', done: false };
import { AccessPanel } from '../recipes/sign-in.js';

/** Example-library API, not an SDK export. All widgets follow the host target. */
export type WidgetFallback =
  'hidden' | 'disabled' | { readonly content: ReactNode };
export interface WidgetProps {
  readonly fallback?: WidgetFallback | undefined;
}

function Frame({
  children,
  recovery,
  fallback,
}: WidgetProps & {
  readonly children: ReactNode;
  readonly recovery?: ReactNode;
}) {
  const { preset, view } = useAppState();
  if (!preset) throw new Error('The widget host must configure a Pod preset.');
  return (
    <AccessPanel
      podUrl={view?.podUrl ?? preset.podUrl}
      fallback={fallback ?? 'hidden'}
      recovery={recovery}
    >
      {children}
    </AccessPanel>
  );
}

/** Read-only list: the host's write grant is not required to display tasks. */
export function TaskListWidget({ fallback }: WidgetProps) {
  const { state } = useList(taskFields);
  const { language, error } = useSdkLocale();
  const source = state.kind === 'ready' ? state.data : undefined;
  const items = source?.items.filter((item) => taskFields.valid!(item.data));
  const list =
    source && items
      ? { items, skipped: source.skipped + source.items.length - items.length }
      : undefined;
  return (
    <section aria-label={language === 'de' ? 'Aufgaben' : 'Tasks'}>
      <h2>{language === 'de' ? 'Aufgaben' : 'Tasks'}</h2>
      <Frame fallback={fallback}>
        {state.kind === 'failed' ? (
          <p role="alert">{error(state.error)}</p>
        ) : null}
        {state.kind !== 'ready' && state.kind !== 'failed' ? (
          <p role="status">
            {language === 'de' ? 'Wird geladen…' : 'Loading…'}
          </p>
        ) : null}
        {list && (
          <>
            {list.items.length === 0 && (
              <p>
                {language === 'de' ? 'Noch keine Aufgaben.' : 'No tasks yet.'}
              </p>
            )}
            <ul>
              {list.items.map((item) => (
                <li key={item.iri}>
                  {item.data.title}
                  {item.data.done ? ' ✓' : ''}
                </li>
              ))}
            </ul>
            {list.skipped > 0 && (
              <p>
                {language === 'de'
                  ? 'Nicht unterstützte Einträge'
                  : 'Unsupported entries'}
                : {list.skipped}
              </p>
            )}
          </>
        )}
      </Frame>
    </section>
  );
}

/** Its mutation controller and recovery remain mounted when access is lost. */
export function QuickAddWidget({ fallback }: WidgetProps) {
  const creation = useCreation(taskFields, {
    initial: emptyTask,
    collection: 'tasks',
  });
  const access = useWorkflowAccess();
  const { language } = useSdkLocale();
  return (
    <section aria-label={language === 'de' ? 'Schnellerfassung' : 'Quick add'}>
      <h2>{language === 'de' ? 'Schnellerfassung' : 'Quick add'}</h2>
      <Frame
        fallback={fallback}
        recovery={<UpdateNotice {...creation.notice} />}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void creation.create();
          }}
        >
          <label>
            {language === 'de' ? 'Neue Aufgabe' : 'New task'}
            <input
              value={creation.draft.title}
              disabled={!access.write || !creation.canEdit}
              onChange={(event) =>
                creation.change({ title: event.target.value })
              }
            />
          </label>
          <button disabled={!creation.canCreate}>
            {language === 'de' ? 'Hinzufügen' : 'Add'}
          </button>
        </form>
      </Frame>
    </section>
  );
}
