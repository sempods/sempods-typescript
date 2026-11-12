import { Fragment, useState, type ReactNode } from 'react';
import { Menu, Popover, Text } from 'react-aria-components';
import { ChevronDownIcon, EyeIcon, PencilIcon } from 'lucide-react';
import {
  useApp,
  useAppState,
  useContexts,
  usePodContexts,
  useSdkLocale,
  type PodContextChoice,
  type PodContextGroup,
} from '@sempods/app-sdk/react';
import { Button } from '../components/button.js';
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/dropdown-menu.js';
import { useAdapterTexts } from './texts.js';

export interface ContextSwitchProps {
  /** App name; kept as an h1 for screen readers when a Context is selected. */
  readonly title: string;
  /** The app's word for a Context, for example "List". Defaults to "Context". */
  readonly label?: string;
  /** Decorative app icon, shown in a fixed leading column. */
  readonly icon?: ReactNode;
  /** Optional configured Pod names, keyed by exact Pod URL; no extra requests. */
  readonly podNames?: Readonly<Record<string, string>>;
  /** Domain wording only; generic feedback and recovery belong to the adapter. */
  readonly texts?: { readonly shareMore?: string };
}

/**
 * The standard chooser for an app working in one Context at a time. Mount it
 * outside TargetScreen, alongside AppAccess (which still owns access management).
 * It groups by Pod, keeps permission and selection separate, and uses the SDK's
 * guarded actions. Like useContexts, it initially selects the active Pod's first
 * writable, else readable Context when none was remembered or configured.
 * It reads no data beyond the hooks' bounded catalogue/label demand.
 */
export function ContextSwitch({
  title,
  label,
  icon,
  podNames,
  texts,
}: ContextSwitchProps) {
  const lists = usePodContexts(podNames ? { podNames } : {});
  const active = useContexts();
  const actions = useApp();
  const { signIn, activeId } = useAppState();
  const { messages, error } = useSdkLocale();
  const t = useAdapterTexts();
  const noun = label ?? t.context;
  const selected = lists.selected;
  const [open, setOpen] = useState(false);
  const [addresses, setAddresses] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const run = async (action: () => Promise<void>) => {
    setProblem(null);
    try {
      await action();
    } catch (cause) {
      setProblem(error(cause));
    }
  };
  const select = (choice: PodContextChoice) =>
    void run(async () => {
      const result = await lists.select(choice);
      if (result.kind === 'blocked') setProblem(t.switchBlocked);
      if (result.kind === 'unavailable') setProblem(t.switchUnavailable);
    });
  const status = (pod: PodContextGroup) => {
    switch (pod.status) {
      case 'failed':
        return t.contextsFailed;
      case 'unknown':
      case 'loading':
        return t.contextsLoading;
      case 'restoring':
        return t.podRestoring;
      case 'leaving':
        return t.podLeaving;
      case 'signed-out':
      case 'ended':
        return t.podSignedOut;
      case 'ready':
        return pod.choices.length === 0 ? t.contextsEmpty : null;
    }
  };
  const permission = (writable: boolean) =>
    writable ? messages.controls.canChange : messages.controls.canRead;
  const permissionIcon = (writable: boolean) =>
    writable ? (
      <PencilIcon aria-hidden="true" className="size-4 shrink-0" />
    ) : (
      <EyeIcon aria-hidden="true" className="size-4 shrink-0" />
    );
  return (
    <div className="grid min-w-0 max-w-full gap-1" data-slot="context-switch">
      <h1 className="sr-only">{title}</h1>
      <DropdownMenuTrigger isOpen={open} onOpenChange={setOpen}>
        <Button
          variant="ghost"
          className="h-16 min-w-48 max-w-full justify-start gap-3 rounded-xl px-4 text-start whitespace-normal"
          aria-label={
            selected
              ? `${noun}: ${selected.label} · ${selected.podLabel}`
              : `${noun}: ${title}`
          }
        >
          {icon && (
            <span
              aria-hidden="true"
              className="flex size-7 shrink-0 items-center justify-center overflow-hidden [&_svg]:size-7"
            >
              {icon}
            </span>
          )}
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="truncate text-lg font-semibold">
              {selected?.label ?? title}
            </span>
            <span className="truncate text-xs font-normal text-muted-foreground">
              {selected?.podLabel ?? t.chooseContext}
            </span>
          </span>
          <ChevronDownIcon
            aria-hidden="true"
            className="ms-1 size-4 shrink-0"
          />
        </Button>
        <Popover
          placement="bottom start"
          offset={6}
          className="z-50 w-88 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none"
        >
          <Menu aria-label={noun} className="outline-none">
            {lists.pods.map((pod) => (
              <Fragment key={pod.connectionId}>
                <DropdownMenuGroup
                  selectionMode="single"
                  selectedKeys={
                    selected?.connectionId === pod.connectionId
                      ? [selected.key]
                      : []
                  }
                >
                  <DropdownMenuLabel className="px-4 py-2 wrap-anywhere">
                    {pod.label}
                  </DropdownMenuLabel>
                  {pod.choices.map((choice) => (
                    <DropdownMenuItem
                      key={choice.key}
                      id={choice.key}
                      textValue={choice.label}
                      isDisabled={!choice.selectable}
                      onAction={() => select(choice)}
                      className="min-h-13 gap-3 py-3 ps-4 pe-10 [&>[data-slot=dropdown-menu-radio-item-indicator]]:right-4"
                    >
                      {permissionIcon(choice.writable)}
                      <Text slot="label" className="min-w-0 wrap-anywhere">
                        {choice.label}
                      </Text>
                      <Text
                        slot="description"
                        className="sr-only"
                      >{`${pod.label} · ${permission(choice.writable)}${choice.selectable ? '' : ` · ${t.switchUnavailable}`}`}</Text>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
                <DropdownMenuGroup aria-label={pod.label}>
                  {status(pod) && (
                    <DropdownMenuItem
                      id={`status:${pod.connectionId}`}
                      textValue={status(pod)!}
                      isDisabled
                      className="min-h-11 px-4 py-2 whitespace-normal"
                    >
                      {status(pod)}
                    </DropdownMenuItem>
                  )}
                  {(pod.status === 'failed' || pod.restorable) && (
                    <DropdownMenuItem
                      id={`retry:${pod.connectionId}`}
                      textValue={`${messages.controls.retry}: ${pod.label}`}
                      aria-label={`${messages.controls.retry}: ${pod.label}`}
                      shouldCloseOnSelect={false}
                      className="min-h-11 px-4"
                      onAction={() => void run(() => pod.retry())}
                    >
                      {messages.controls.retry}
                    </DropdownMenuItem>
                  )}
                  {(pod.status === 'signed-out' || pod.status === 'ended') &&
                    !pod.restorable &&
                    signIn !== 'none' && (
                      <DropdownMenuItem
                        id={`signin:${pod.connectionId}`}
                        className="min-h-11 px-4"
                        onAction={() =>
                          void run(async () => {
                            if (!(await actions.authorize(pod.connectionId)))
                              setProblem(t.actionNotCompleted);
                          })
                        }
                      >
                        {t.signInPod}
                      </DropdownMenuItem>
                    )}
                </DropdownMenuGroup>
              </Fragment>
            ))}
            {lists.pods.length === 0 && (
              <DropdownMenuItem id="empty" isDisabled className="min-h-11 px-4">
                {t.noPods}
              </DropdownMenuItem>
            )}
            {active.canShare && <DropdownMenuSeparator />}
            {active.canShare && (
              <DropdownMenuItem
                id="share"
                className="min-h-11 px-4"
                onAction={() =>
                  void run(async () => {
                    if (activeId && !(await actions.authorize(activeId)))
                      setProblem(t.actionNotCompleted);
                  })
                }
              >
                {texts?.shareMore ?? t.shareContexts}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              id="addresses"
              className="min-h-11 px-4"
              shouldCloseOnSelect={false}
              onAction={() => setAddresses((shown) => !shown)}
            >
              {addresses ? t.hideAddresses : t.showAddresses}
            </DropdownMenuItem>
          </Menu>
          <div className="mt-2 border-t px-4 pt-3 text-xs text-muted-foreground">
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              <span className="flex items-center gap-2">
                {permissionIcon(true)}
                {permission(true)}
              </span>
              <span className="flex items-center gap-2">
                {permissionIcon(false)}
                {permission(false)}
              </span>
            </div>
            {addresses && (
              <div className="grid gap-2 pb-3 wrap-anywhere">
                {lists.pods.map((pod) => (
                  <dl key={pod.connectionId}>
                    <dt className="font-medium">{pod.label}</dt>
                    <dd>{pod.podUrl}</dd>
                    {pod.choices.map((choice) => (
                      <Fragment key={choice.key}>
                        <dt>{choice.label}</dt>
                        <dd>{choice.contextIri}</dd>
                      </Fragment>
                    ))}
                  </dl>
                ))}
              </div>
            )}
          </div>
        </Popover>
      </DropdownMenuTrigger>
      {problem && (
        <p
          role="alert"
          className="max-w-sm text-sm text-destructive wrap-anywhere"
        >
          {problem}
        </p>
      )}
    </div>
  );
}
