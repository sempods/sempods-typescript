import { useState } from 'react';
import { HeaderMenu } from '@sempods/app-ui';
import { ConfirmDialog } from './confirm-dialog';

/**
 * A screen's menu whose action asks first (#391): the README's
 * `ConfirmDialog` opens while the menu is still in its exit animation. The
 * last action and answer show on the page.
 */
export function MenuConfirmGate() {
  const [asking, setAsking] = useState(false);
  const [done, setDone] = useState('none');
  return (
    <main className="gate-main">
      <header className="gate-header">
        <h1>Groceries</h1>
        <HeaderMenu
          label="Menu"
          items={[
            { label: 'Rename list', onSelect: () => setDone('rename') },
            { label: 'Delete bought items', onSelect: () => setAsking(true) },
          ]}
        />
      </header>
      <output data-done={done}>{done}</output>
      <ConfirmDialog
        isOpen={asking}
        onOpenChange={setAsking}
        title="Delete bought items?"
        cancel="Cancel"
        confirm="Delete"
        onConfirm={() => setDone('deleted')}
      >
        All bought items of this list are deleted.
      </ConfirmDialog>
    </main>
  );
}
