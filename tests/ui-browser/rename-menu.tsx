import { useRef, useState } from 'react';
import {
  useDraftGuard,
  useFieldUpdate,
  useList,
  type FieldUpdateRow,
} from '@sempods/app-sdk/react';
import type { DraftOf } from '@sempods/client-sdk/edit';
import { HeaderMenu, InlineTextEdit } from '@sempods/app-ui';
import { startRename, useRename, type Rename } from './rename-row';
import { taskFields } from './task-dialog';

type Task = DraftOf<typeof taskFields>;

/**
 * The second shape `InlineTextEdit` was checked against (#394), besides the
 * README's shopping list: Focus's list, where the title is the task's deep
 * link and Rename sits in the row's menu, so focus returns to the menu's
 * button. Its draft policy differs too: a dismissal closes an unchanged
 * field and keeps a changed one open (and guarded) instead of parking it.
 * What a rename may write over is the README's `useRename`, shared.
 */
export function RenameMenuGate() {
  const list = useList(taskFields);
  const mutate = useFieldUpdate(taskFields);
  const [open, setOpen] = useState<{
    readonly iri: string;
    readonly rename: Rename;
  } | null>(null);
  const menus = useRef(new Map<string, HTMLButtonElement>());
  const items = list.data?.items ?? [];
  useDraftGuard(
    Boolean(open && open.rename.text.trim() !== open.rename.seen),
    () => setOpen(null),
  );
  return (
    <main className="gate-main">
      <h1>Focus</h1>
      <ul aria-label="Tasks" className="gate-list">
        {items.map((item) => (
          <TaskRow
            key={item.iri}
            iri={item.iri}
            row={mutate.for(item)}
            rename={open?.iri === item.iri ? open.rename : undefined}
            settled={list.state.kind === 'ready'}
            menu={(button) => {
              if (button) menus.current.set(item.iri, button);
              else menus.current.delete(item.iri);
            }}
            onOpen={(rename) => setOpen({ iri: item.iri, rename })}
            onRename={(rename) =>
              setOpen((current) =>
                current?.iri === item.iri ? { iri: item.iri, rename } : current,
              )
            }
            onClose={() =>
              setOpen((current) => (current?.iri === item.iri ? null : current))
            }
            returnFocus={() => menus.current.get(item.iri)?.focus()}
          />
        ))}
      </ul>
      <button type="button">After the list</button>
    </main>
  );
}

function TaskRow(props: {
  readonly iri: string;
  readonly row: FieldUpdateRow<Task>;
  /** The open rename; this shape parks none. */
  readonly rename: Rename | undefined;
  readonly settled: boolean;
  readonly menu: (button: HTMLButtonElement | null) => void;
  readonly onOpen: (rename: Rename) => void;
  readonly onRename: (rename: Rename) => void;
  readonly onClose: () => void;
  readonly returnFocus: () => void;
}) {
  const { row, rename } = props;
  const title = row.data.title;
  const edit = useRename(row, rename, props.onRename, props.settled);
  // Kept here, not in the field: another row may open during a slow save.
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <li className="flex flex-wrap items-center gap-1">
      {rename ? (
        <InlineTextEdit
          className="min-w-0 flex-1"
          label={`Rename: ${title}`}
          value={rename.text}
          onChange={(text) => {
            setError(undefined);
            props.onRename({ ...rename, text });
          }}
          onSave={async () => {
            if (edit.invalid) return setError(edit.invalid);
            setSaving(true);
            const result = await edit.save();
            setSaving(false);
            if (result === 'done') props.onClose();
          }}
          onCancel={props.onClose}
          onDismiss={() => {
            if (rename.text.trim() === rename.seen) props.onClose();
          }}
          returnFocus={props.returnFocus}
          pending={saving}
          readOnly={edit.readOnly}
          error={error}
        >
          {edit.notices}
        </InlineTextEdit>
      ) : (
        <>
          <a className="min-w-0 flex-1" href={`#task-${props.iri}`}>
            {title}
          </a>
          {edit.notices}
        </>
      )}
      <HeaderMenu
        ref={props.menu}
        icon="more"
        variant="ghost"
        label={`${title}: more`}
        items={[
          {
            label: 'Rename',
            onSelect: () => {
              setError(undefined);
              props.onOpen(startRename(row));
            },
          },
        ]}
      />
    </li>
  );
}
