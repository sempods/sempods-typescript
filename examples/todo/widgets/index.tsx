import { useEffect, useRef, type ReactNode } from 'react';
import {
  AccessNotice,
  LoadNotice,
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

/** Example-library API, not an SDK export. All widgets follow the host target. */
export type WidgetFallback =
  'hidden' | 'disabled' | { readonly content: ReactNode };
export interface WidgetProps {
  readonly fallback?: WidgetFallback | undefined;
}

/** Keep this region mounted for its target lifetime. Eligibility is a view fact. */
function AccessPanel({
  podUrl,
  children,
  recovery,
  fallback = 'hidden',
}: {
  readonly podUrl: string;
  readonly children: ReactNode;
  readonly recovery?: ReactNode;
  readonly fallback?: 'hidden' | 'disabled' | { readonly content: ReactNode };
}) {
  const access = useWorkflowAccess();
  const readable =
    access.connection?.podUrl === podUrl && access.current && access.read;
  const notice = useRef<HTMLDivElement>(null);
  const focusInside = useRef(false);
  const { messages } = useSdkLocale();
  useEffect(() => {
    if (!readable && focusInside.current) {
      notice.current?.focus();
      focusInside.current = false;
    }
  }, [readable]);
  return (
    <>
      <div ref={notice} tabIndex={-1} aria-label={messages.reviewAccess}>
        {access.connection?.podUrl === podUrl ? (
          <AccessNotice />
        ) : (
          <p role="status">{messages.controls.noTarget}</p>
        )}
        {recovery}
        {!readable && typeof fallback === 'object' && fallback.content}
      </div>
      <div
        hidden={!readable && fallback !== 'disabled'}
        inert={!readable}
        onFocusCapture={() => {
          focusInside.current = true;
        }}
        onBlurCapture={(event) => {
          if (
            event.relatedTarget &&
            !event.currentTarget.contains(event.relatedTarget)
          )
            focusInside.current = false;
        }}
      >
        {children}
      </div>
    </>
  );
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
  // Rows the definition cannot show are already skipped and counted.
  const list = useList(taskFields);
  const { language } = useSdkLocale();
  const items = list.data?.items;
  return (
    <section aria-label={language === 'de' ? 'Aufgaben' : 'Tasks'}>
      <h2>{language === 'de' ? 'Aufgaben' : 'Tasks'}</h2>
      <Frame fallback={fallback}>
        <LoadNotice {...list} />
        {items?.length === 0 && (
          <p>{language === 'de' ? 'Noch keine Aufgaben.' : 'No tasks yet.'}</p>
        )}
        {items && (
          <ul>
            {items.map((item) => (
              <li key={item.iri}>
                {item.data.title}
                {item.data.done ? ' ✓' : ''}
              </li>
            ))}
          </ul>
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
