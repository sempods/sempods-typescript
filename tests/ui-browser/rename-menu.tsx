import { useRef, useState } from 'react';
import {
  LoadNotice,
  useDraftGuard,
  useFieldUpdate,
  useList,
  type FieldUpdateRow,
} from '@sempods/app-sdk/react';
import type { DraftOf } from '@sempods/client-sdk/edit';
import { HeaderMenu, InlineTextEdit } from '@sempods/app-ui';
import { edited, startRename, useRename, type Rename } from './rename-row';
import { taskFields } from './task-dialog';

type Task = DraftOf<typeof taskFields>;

/**
 * The second shape `InlineTextEdit` was checked against (#394), besides the
 * README's shopping list: Focus's list, where the title is the task's deep
 * link and Rename sits in the row's menu, so focus returns to the menu's
 * button. Its draft policy differs too: a dismissal closes an unchanged
 * field and keeps a changed one open (and guarded) instead of parking it,
 * also while another row is renamed. What a rename may write over is the
 * README's `useRename`, shared.
 */
export function RenameMenuGate() {
  const list = useList(taskFields);
  const mutate = useFieldUpdate(taskFields);
  // The open renames by IRI: each row keeps its own until it closes.
  const [renames, setRenames] = useState<ReadonlyMap<string, Rename>>(
    new Map(),
  );
  const menus = useRef(new Map<string, HTMLButtonElement>());
  const items = list.data?.items ?? [];
  useDraftGuard([...renames.values()].some(edited), () =>
    setRenames(new Map()),
  );
  const set = (iri: string, rename: Rename | null, only?: boolean) =>
    setRenames((all) => {
      if (only && !all.has(iri)) return all;
      const next = new Map(all);
      if (rename) next.set(iri, rename);
      else next.delete(iri);
      return next;
    });
  return (
    <main className="gate-main">
      <h1>Focus</h1>
      <LoadNotice state={list.state} reload={list.reload} />
      <ul aria-label="Tasks" className="gate-list">
        {items.map((item) => (
          <TaskRow
            key={item.iri}
            iri={item.iri}
            row={mutate.for(item)}
            rename={renames.get(item.iri)}
            reading={list.state.kind === 'loading'}
            menu={(button) => {
              if (button) menus.current.set(item.iri, button);
              else menus.current.delete(item.iri);
            }}
            onOpen={(rename) => set(item.iri, rename)}
            // Only while it is open: a late change never reopens it.
            onRename={(rename) => set(item.iri, rename, true)}
            onClose={() => set(item.iri, null)}
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
  readonly reading: boolean;
  readonly menu: (button: HTMLButtonElement | null) => void;
  readonly onOpen: (rename: Rename) => void;
  readonly onRename: (rename: Rename) => void;
  readonly onClose: () => void;
  readonly returnFocus: () => void;
}) {
  const { row, rename } = props;
  const title = row.data.title;
  const edit = useRename(row, rename, props.onRename, props.reading);
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
            if (!edited(rename)) props.onClose();
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
            // Already open: its draft is never replaced.
            onSelect: () => {
              if (rename) return;
              setError(undefined);
              props.onOpen(startRename(row));
            },
          },
        ]}
      />
    </li>
  );
}
