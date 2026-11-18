import { Fragment, useState, type ReactNode } from 'react';
import { Menu, Popover, Text } from 'react-aria-components';
import { ChevronDownIcon } from 'lucide-react';
import {
  useApp,
  useAppState,
  useContexts,
  usePodContexts,
  useSdkLocale,
  type PodContextChoice,
  type PodContextGroup,
} from '@sempods/app-sdk/react';
import { Badge } from '../components/badge.js';
import { Button } from '../components/button.js';
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '../components/dropdown-menu.js';
import { useAdapterTexts, type AdapterTexts } from './texts.js';

/**
 * The app's own wording, already in its current language. Each one replaces
 * a generic message that says "context", so an app can name its Contexts
 * ("Liste", "Listen") with the gender and plural its language needs; an
 * omitted one keeps the adapter's English or German default.
 */
export interface ContextSwitchTexts {
  /** Sharing on a Pod that shares no readable Context, e.g. "Share lists …". */
  readonly shareContexts?: string;
  /** The trigger's second line while nothing is selected. */
  readonly chooseContext?: string;
  /** A Pod whose Contexts are still loading. */
  readonly contextsLoading?: string;
  /** A Pod whose Contexts could not be loaded. */
  readonly contextsFailed?: string;
  /** A ready Pod that shares no readable Context. */
  readonly contextsEmpty?: string;
  /** A retained Context that cannot be selected now. */
  readonly switchUnavailable?: string;
  /** A sharing or sign-in action that did not complete. */
  readonly actionNotCompleted?: string;
  /** The menu without any connected Pod. */
  readonly noPods?: string;
}

export interface ContextSwitchProps {
  /** App name; kept as an h1 for screen readers when a Context is selected. */
  readonly title: string;
  /** The app's word for a Context, for example "List". Defaults to "Context". */
  readonly label?: string;
  /** Decorative app icon, sized to the visible title block. */
  readonly icon?: ReactNode;
  /** Optional configured Pod names, keyed by exact Pod URL; no extra requests. */
  readonly podNames?: Readonly<Record<string, string>>;
  /**
   * The app's word for its Contexts in the adapter's messages; recovery and
   * Pod feedback stay the adapter's.
   */
  readonly texts?: ContextSwitchTexts;
}

/**
 * The standard chooser for an app working in one Context at a time. Mount it
 * outside TargetScreen, alongside AppAccess, which owns changing what is
 * shared, connecting Pods and signing out. It groups by Pod, marks read-only
 * Contexts, keeps the selection's check separate, offers each Pod's own
 * recovery and sharing only where that Pod shares nothing readable, and uses
 * the SDK's guarded actions. Like useContexts, it initially selects the active
 * Pod's first writable, else readable Context when none was remembered or
 * configured.
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
  // Selects the first writable, else readable Context when none is known.
  useContexts();
  const actions = useApp();
  const { signIn } = useAppState();
  const { messages, error } = useSdkLocale();
  const t = withTexts(useAdapterTexts(), texts);
  const noun = label ?? t.context;
  const selected = lists.selected;
  const showSubtitle = !selected || lists.pods.length > 1;
  const shareLabel = t.shareContexts;
  // Loading or failure is not an empty grant: only a loaded Pod offers it.
  const shareEmpty = (pod: PodContextGroup) =>
    signIn !== 'none' && pod.status === 'ready' && pod.choices.length === 0;
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
  const shareItem = (pod: PodContextGroup) => (
    <DropdownMenuItem
      key={`share:${pod.connectionId}`}
      id={`share:${pod.connectionId}`}
      textValue={`${shareLabel}: ${pod.label}`}
      aria-label={`${shareLabel}: ${pod.label}`}
      className="min-h-11 px-4 py-2"
      onAction={() =>
        void run(async () => {
          // The Pod shows its consent page even when it could reuse the grant.
          if (
            !(await actions.authorize(pod.connectionId, {
              intent: 'change-sharing',
            }))
          )
            setProblem(t.actionNotCompleted);
        })
      }
    >
      <Text
        slot="label"
        className="sr-only"
      >{`${shareLabel}: ${pod.label}`}</Text>
      <span aria-hidden="true" className="min-w-0 wrap-anywhere">
        {shareLabel}
      </span>
    </DropdownMenuItem>
  );
  // The qualifier tells equal names within one Pod apart, more quietly.
  const contextText = (choice: PodContextChoice) =>
    choice.qualifier ? (
      <>
        {choice.contextLabel}
        <span className="font-normal text-muted-foreground">
          {` · ${choice.qualifier}`}
        </span>
      </>
    ) : (
      choice.contextLabel
    );
  const permission = (writable: boolean) =>
    writable ? messages.controls.canChange : messages.controls.canRead;
  return (
    <div className="grid min-w-0 max-w-full gap-1" data-slot="context-switch">
      <h1 className="sr-only">{title}</h1>
      <DropdownMenuTrigger>
        <Button
          variant="ghost"
          className="h-16 w-fit min-w-11 max-w-full justify-start gap-2 rounded-xl px-4 text-start whitespace-normal"
          aria-label={
            selected
              ? `${noun}: ${selected.label} · ${selected.podLabel}`
              : `${noun}: ${title}`
          }
        >
          {icon && (
            <span
              aria-hidden="true"
              className={`flex shrink-0 items-center justify-center overflow-hidden [&_svg]:size-full! [&_img]:size-full [&_img]:object-contain ${showSubtitle ? 'size-10 translate-y-[2px] text-4xl/none' : 'size-7 text-xl/none'}`}
            >
              {icon}
            </span>
          )}
          <span className="grid min-w-0 gap-0.5">
            <span className="flex min-w-0 items-center gap-1">
              <span className="truncate text-lg font-semibold">
                {selected ? contextText(selected) : title}
              </span>
              <ChevronDownIcon aria-hidden="true" className="size-4 shrink-0" />
            </span>
            {/* With one Pod its name says nothing to choose between; the
                accessible name keeps it. */}
            {showSubtitle && (
              <span className="truncate text-xs font-normal text-muted-foreground">
                {selected?.podLabel ?? t.chooseContext}
              </span>
            )}
          </span>
        </Button>
        <Popover
          placement="bottom start"
          offset={6}
          className="z-50 w-88 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none"
        >
          <Menu aria-label={noun} className="outline-none">
            {lists.pods.map((pod) => (
              <Fragment key={pod.connectionId}>
                {pod.choices.length > 0 && (
                  <DropdownMenuGroup
                    className="mt-2 first:mt-0"
                    selectionMode="single"
                    selectedKeys={
                      selected?.connectionId === pod.connectionId
                        ? [selected.key]
                        : []
                    }
                  >
                    <DropdownMenuLabel className="px-2 py-1 wrap-anywhere">
                      {pod.label}
                    </DropdownMenuLabel>
                    {pod.choices.map((choice) => (
                      <DropdownMenuItem
                        key={choice.key}
                        id={choice.key}
                        textValue={choice.label}
                        isDisabled={!choice.selectable}
                        onAction={() => select(choice)}
                        className="min-h-11 gap-2 px-4 py-1.5 [&>[data-slot=dropdown-menu-radio-item-indicator]]:static [&>[data-slot=dropdown-menu-radio-item-indicator]]:order-last [&>[data-slot=dropdown-menu-radio-item-indicator]]:min-w-4"
                      >
                        <Text
                          slot="label"
                          className="min-w-0 flex-1 wrap-anywhere"
                        >
                          {contextText(choice)}
                        </Text>
                        {/* Editable needs no marker; the description says
                            both to assistive technology. */}
                        {!choice.writable && (
                          <Badge variant="secondary" aria-hidden="true">
                            {permission(false)}
                          </Badge>
                        )}
                        <Text
                          slot="description"
                          className="sr-only"
                        >{`${pod.label} · ${permission(choice.writable)}${choice.selectable ? '' : ` · ${t.switchUnavailable}`}`}</Text>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                )}
                {(status(pod) || pod.restorable) && (
                  <DropdownMenuGroup
                    className={
                      pod.choices.length === 0 ? 'mt-2 first:mt-0' : undefined
                    }
                    aria-label={
                      pod.choices.length > 0
                        ? `${pod.label}: ${t.podActions}`
                        : undefined
                    }
                  >
                    {pod.choices.length === 0 && (
                      <DropdownMenuLabel className="px-2 py-1 wrap-anywhere">
                        {pod.label}
                      </DropdownMenuLabel>
                    )}
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
                          textValue={`${t.signInPod}: ${pod.label}`}
                          aria-label={`${t.signInPod}: ${pod.label}`}
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
                    {shareEmpty(pod) && shareItem(pod)}
                  </DropdownMenuGroup>
                )}
              </Fragment>
            ))}
            {lists.pods.length === 0 && (
              <DropdownMenuItem id="empty" isDisabled className="min-h-11 px-4">
                {t.noPods}
              </DropdownMenuItem>
            )}
          </Menu>
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

// An app's supplied wording over the defaults; an omitted key keeps its default.
function withTexts(
  defaults: AdapterTexts,
  texts: ContextSwitchTexts = {},
): AdapterTexts {
  const own = Object.entries(texts).filter(([, text]) => text !== undefined);
  return { ...defaults, ...Object.fromEntries(own) };
}
