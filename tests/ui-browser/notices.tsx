import { useEffect, useState } from 'react';
import {
  AppAccess,
  Notices,
  useNotice,
  useNotices,
  type Notice,
} from '@sempods/app-sdk/react';
import {
  Button,
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@sempods/app-ui';

/** One app warning per Pod that keeps failing, as a multi-Pod app has it. */
function PodWarning({
  pod,
  failures,
}: {
  readonly pod: string;
  readonly failures: number;
}) {
  useNotice(
    failures > 0
      ? {
          key: `pod-unreachable:${pod}`,
          severity: 'warning',
          title: `${pod} cannot be reached`,
          text:
            failures === 1
              ? 'Your other Pods keep working.'
              : `Your other Pods keep working. ${failures} attempts so far.`,
        }
      : null,
  );
  return null;
}

/** The PWA pilot's notice, as `NewVersionNotice` publishes it. */
function UpdateNotice({ ready }: { readonly ready: boolean }) {
  useNotice(
    ready
      ? {
          key: 'app-update',
          text: 'A new version is ready. It is used once every window of this app has been closed.',
          duration: 'until-dismissed',
        }
      : null,
  );
  return null;
}

const items = [
  'Milk',
  'Bread',
  'Apples',
  'Coffee',
  'Rice',
  'Tomatoes',
  'Cheese',
  'Butter',
  'Eggs',
  'Lentils',
  'Oranges',
  'Yoghurt',
];

/**
 * The shared notification host (#385) on a shopping list with a composer
 * fixed at the bottom (`data-sempods-notices-avoid`) and an app dialog. With
 * `gate`, `AppAccess` shows its sign-in gate, before sign-in. The checks
 * publish through `window.noticesGate`, as the app's own code would.
 */
export function NoticesGate({ gate }: { readonly gate: boolean }) {
  const { show, dismiss } = useNotices();
  const [ready, setReady] = useState(false);
  const [failures, setFailures] = useState<Record<string, number>>({});
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    Object.assign(window, {
      noticesGate: {
        show: (notice: Notice) => show(notice),
        dismiss: (key: string) => dismiss(key),
        update: (on: boolean) => setReady(on),
        fail: (pod: string) =>
          setFailures((f) => ({ ...f, [pod]: (f[pod] ?? 0) + 1 })),
        recover: (pod: string) => setFailures((f) => ({ ...f, [pod]: 0 })),
      },
    });
  }, [show, dismiss]);
  return (
    <>
      {gate && <AppAccess appName="Konsum" />}
      <Notices />
      <UpdateNotice ready={ready} />
      {Object.entries(failures).map(([pod, count]) => (
        <PodWarning key={pod} pod={pod} failures={count} />
      ))}
      <main className="gate-main" style={{ paddingBottom: 96 }}>
        <header className="gate-header">
          <h1>Groceries</h1>
          <Button variant="outline" onPress={() => setEditing(true)}>
            Edit list
          </Button>
        </header>
        <ul aria-label="Items" className="notices-items">
          {items.map((item) => (
            <li key={item} style={{ minHeight: 48, padding: '12px 0' }}>
              {item}
            </li>
          ))}
        </ul>
      </main>
      <form
        data-sempods-notices-avoid=""
        aria-label="Add an item"
        onSubmit={(event) => event.preventDefault()}
        style={{
          position: 'fixed',
          insetInline: 0,
          bottom: 0,
          padding: 12,
          display: 'flex',
          gap: 8,
          background: 'var(--background)',
          borderTop: '1px solid var(--border)',
        }}
      >
        <input
          aria-label="New item"
          style={{
            flex: 1,
            minHeight: 44,
            padding: '0 12px',
            border: '1px solid var(--input)',
            borderRadius: 8,
            background: 'var(--background)',
            color: 'var(--foreground)',
          }}
        />
        <Button type="submit">Add</Button>
      </form>
      <Dialog isOpen={editing} onOpenChange={setEditing}>
        <DialogHeader>
          <DialogTitle>Edit list</DialogTitle>
        </DialogHeader>
        <p>Rename the list or choose its colour.</p>
        <DialogFooter>
          <Button slot="close">Done</Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}
