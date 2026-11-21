import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AppAccess,
  Notices,
  useNotice,
  useNotices,
  type Notice,
  type NoticeProps,
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

/**
 * A replacement renderer that asks before it runs the action, in its own
 * modal dialog in a portal: the stack waits under it, its owner stays.
 * Escape closes the question, not the notice.
 */
function ConfirmingNotice({ notice }: NoticeProps) {
  return <AskingNotice notice={notice} portal />;
}

/**
 * The same question in an ARIA dialog the renderer mounts inside the notice,
 * already marked modal.
 */
function AriaConfirmingNotice({ notice }: NoticeProps) {
  return <AskingNotice notice={notice} portal={false} />;
}

function AskingNotice({
  notice,
  portal,
}: NoticeProps & { readonly portal: boolean }) {
  const [asking, setAsking] = useState(false);
  const action = notice.actions[0];
  const dialog = action && (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${action.label}?`}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setAsking(false);
      }}
      style={{
        position: 'fixed',
        inset: 0,
        display: 'grid',
        placeItems: 'center',
        background: 'rgb(0 0 0 / 0.4)',
      }}
    >
      <Button
        onPress={() => {
          setAsking(false);
          action.run();
        }}
      >
        Confirm
      </Button>
    </div>
  );
  return (
    <div className="notices-confirming">
      <p>{notice.text}</p>
      {action && (
        <Button variant="outline" onPress={() => setAsking(true)}>
          {action.label}
        </Button>
      )}
      {asking && (portal ? createPortal(dialog, document.body) : dialog)}
    </div>
  );
}

/**
 * The same question in a native `<dialog>` inside the notice, opened with
 * `showModal()`: the stack keeps this notice drawn, so the dialog stays.
 */
function InlineConfirmingNotice({ notice }: NoticeProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const action = notice.actions[0];
  return (
    <div className="notices-confirming">
      <p>{notice.text}</p>
      {action && (
        <>
          <Button variant="outline" onPress={() => dialog.current?.showModal()}>
            {action.label}
          </Button>
          <dialog ref={dialog} aria-label={`${action.label}?`}>
            <Button
              onPress={() => {
                dialog.current?.close();
                action.run();
              }}
            >
              Confirm
            </Button>
          </dialog>
        </>
      )}
    </div>
  );
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
 * `gate`, `AppAccess` shows its sign-in gate, before sign-in; with `beside`,
 * `AppAccess` keeps its own prompt stack beside the host; with `confirm`, a
 * replacement renderer confirms an action in its own portal dialog, with
 * `confirm=inline` in a native dialog inside the notice and with
 * `confirm=aria` in an ARIA dialog it mounts there; `limit` is the host's.
 * The
 * checks publish through `window.noticesGate`, as the app's own code would.
 */
export function NoticesGate({
  gate,
  beside,
  confirm,
  limit,
}: {
  readonly gate: boolean;
  readonly beside: boolean;
  readonly confirm: 'portal' | 'inline' | 'aria' | null;
  readonly limit: number | undefined;
}) {
  const { show, dismiss } = useNotices();
  const [ready, setReady] = useState(false);
  const [failures, setFailures] = useState<Record<string, number>>({});
  const [editing, setEditing] = useState(false);
  // Focus after a focused notice goes; behind the gate it is inert.
  const edit = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    Object.assign(window, {
      noticesGate: {
        show: (notice: Notice) => show(notice),
        dismiss: (key: string) => dismiss(key),
        update: (on: boolean) => setReady(on),
        fail: (pod: string) =>
          setFailures((f) => ({ ...f, [pod]: (f[pod] ?? 0) + 1 })),
        recover: (pod: string) => setFailures((f) => ({ ...f, [pod]: 0 })),
        /** An undo notice whose action counts its runs in `restored`. */
        undo: (duration?: number) =>
          show({
            key: 'undo',
            text: 'Milk deleted.',
            ...(duration ? { duration } : {}),
            action: {
              label: 'Restore',
              run: () => {
                const w = window as unknown as { restored?: number };
                w.restored = (w.restored ?? 0) + 1;
              },
            },
          }),
      },
    });
  }, [show, dismiss]);
  return (
    <>
      {(gate || beside) && <AppAccess appName="Konsum" />}
      <Notices
        focusTarget={edit}
        accessPrompts={!beside}
        limit={limit}
        components={
          confirm
            ? {
                Notice:
                  confirm === 'inline'
                    ? InlineConfirmingNotice
                    : confirm === 'aria'
                      ? AriaConfirmingNotice
                      : ConfirmingNotice,
              }
            : undefined
        }
      />
      <UpdateNotice ready={ready} />
      {Object.entries(failures).map(([pod, count]) => (
        <PodWarning key={pod} pod={pod} failures={count} />
      ))}
      <main className="gate-main" style={{ paddingBottom: 96 }}>
        <header className="gate-header">
          <h1>Groceries</h1>
          <Button ref={edit} variant="outline" onPress={() => setEditing(true)}>
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
