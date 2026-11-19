import { useRef, useState } from 'react';
import {
  UpdateNotice,
  useDraftGuard,
  useFieldUpdate,
  useList,
} from '@sempods/app-sdk/react';
import { HeaderMenu, InlineTextEdit } from '@sempods/app-ui';
import { taskFields } from './task-dialog';

/**
 * The second shape `InlineTextEdit` was checked against (#394), besides the
 * README's shopping list: Focus's list, where the title is the task's deep
 * link and Rename sits in the row's menu, so focus returns to the menu's
 * button. Its draft policy differs too: a dismissal closes an unchanged
 * field and keeps a changed one open (and guarded) instead of parking it.
 */
export function RenameMenuGate() {
  const list = useList(taskFields);
  const mutate = useFieldUpdate(taskFields);
  const [open, setOpen] = useState<{
    readonly iri: string;
    readonly draft: string;
  } | null>(null);
  // The item whose rename is being written.
  const [saving, setSaving] = useState<string | null>(null);
  const menus = useRef(new Map<string, HTMLButtonElement>());
  const items = list.data?.items ?? [];
  const editing = items.find((item) => item.iri === open?.iri);
  const shown = editing && mutate.for(editing).data.title;
  useDraftGuard(Boolean(open && open.draft !== shown), () => setOpen(null));
  return (
    <main className="gate-main">
      <h1>Focus</h1>
      <ul aria-label="Tasks" className="gate-list">
        {items.map((item) => {
          const row = mutate.for(item);
          const title = row.data.title;
          const close = () =>
            setOpen((current) => (current?.iri === item.iri ? null : current));
          return (
            <li key={item.iri} className="flex flex-wrap items-center gap-1">
              {open?.iri === item.iri ? (
                <InlineTextEdit
                  className="min-w-0 flex-1"
                  label={`Rename: ${title}`}
                  value={open.draft}
                  onChange={(draft) => setOpen({ iri: item.iri, draft })}
                  onSave={async () => {
                    const name = open.draft.trim();
                    if (name === title) return close();
                    setSaving(item.iri);
                    const outcome = await row.update({ title: name });
                    setSaving(null);
                    if (outcome.kind === 'saved') close();
                  }}
                  onCancel={close}
                  onDismiss={() => {
                    if (open.draft === title) close();
                  }}
                  returnFocus={() => menus.current.get(item.iri)?.focus()}
                  pending={saving === item.iri}
                  readOnly={!row.canMutate}
                >
                  <UpdateNotice {...row.notice} quiet />
                </InlineTextEdit>
              ) : (
                <>
                  <a className="min-w-0 flex-1" href={`#task-${item.iri}`}>
                    {title}
                  </a>
                  <UpdateNotice {...row.notice} quiet />
                </>
              )}
              <HeaderMenu
                ref={(button) => {
                  if (button) menus.current.set(item.iri, button);
                  else menus.current.delete(item.iri);
                }}
                icon="more"
                variant="ghost"
                label={`${title}: more`}
                items={[
                  {
                    label: 'Rename',
                    onSelect: () => setOpen({ iri: item.iri, draft: title }),
                  },
                ]}
              />
            </li>
          );
        })}
      </ul>
      <button type="button">After the list</button>
    </main>
  );
}
