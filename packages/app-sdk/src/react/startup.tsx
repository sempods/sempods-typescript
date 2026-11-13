import {
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react';
import type { AppSnapshot } from '../authoring/app.js';
import { useAppFacts, useController } from './app.js';
import { useSdkLocale } from './locale.js';
import { layered, SdkStyles } from './styles.js';

/** What `AppStartup` receives: the app's name and icon as `AppAccess` shows them. */
export interface AppStartupProps {
  readonly appName: string;
  /** App-owned decorative icon, for example <img src="/icon.png" alt="" />. */
  readonly icon?: ReactNode;
  readonly className?: string;
  /** Custom properties such as `--sempods-*` tokens also cover the layer. */
  readonly style?: CSSProperties;
}

/**
 * How long a start may take before the startup screen adds its progress: a
 * fast start shows only the app's icon and name, so nothing flickers.
 */
const PROGRESS_DELAY = 350;
const selectStarting = (s: AppSnapshot) => s.starting;

/** The mounted `AppStartup` instances of one provider, oldest first. */
/**
 * What one `AppStartup` registers: its props and the locale where it is
 * mounted, as the host renders outside a nested `SdkLocaleProvider`.
 */
interface Shown {
  readonly props: AppStartupProps;
  readonly locale: ReturnType<typeof useSdkLocale>;
}
interface Hosts {
  readonly mounted: { shown: Shown | null }[];
  readonly listeners: Set<() => void>;
  shown: Shown | null;
}
const registry = new WeakMap<object, Hosts>();
function hostsOf(app: object) {
  let hosts = registry.get(app);
  if (!hosts) {
    hosts = { mounted: [], listeners: new Set(), shown: null };
    registry.set(app, hosts);
  }
  return hosts;
}
function changed(hosts: Hosts) {
  const shown = hosts.mounted[0]?.shown ?? null;
  if (shown === hosts.shown) return;
  hosts.shown = shown;
  hosts.listeners.forEach((listener) => listener());
}
function useShown() {
  const hosts = hostsOf(useController());
  return useSyncExternalStore(
    (listener) => {
      hosts.listeners.add(listener);
      return () => hosts.listeners.delete(listener);
    },
    () => hosts.shown,
    () => hosts.shown,
  );
}

/**
 * The startup screen while the app starts (`useAppState().starting`): a
 * full-viewport layer with the app's `icon` and `appName`, centred like the
 * sign-in screen's header. The provider renders it beside the app's content,
 * which stays mounted and is inert and hidden from assistive technology
 * meanwhile (as behind the gate), so `TargetScreen` demands and reads
 * already start. After 350 ms it adds a progress indicator and a status
 * (`controls.starting`), announced politely. It has no controls and never
 * takes focus. One shows per provider, from the first mounted instance;
 * `AppAccess` places one unless `startup="none"`. Match a static HTML splash
 * to it (see the startup sequence in the React guide), so the hand-over is
 * invisible.
 */
export function AppStartup(props: AppStartupProps) {
  const hosts = hostsOf(useController());
  // The texts and direction where it is mounted, also under a nested
  // `SdkLocaleProvider`: the host renders beside the content, outside it.
  const locale = useSdkLocale();
  const [entry] = useState<{ shown: Shown | null }>(() => ({ shown: null }));
  // Before paint, so the first frame already shows the screen. Registered
  // once; the props follow below.
  useLayoutEffect(() => {
    hosts.mounted.push(entry);
    // Also when mounted again (StrictMode) with props already set.
    changed(hosts);
    return () => {
      hosts.mounted.splice(hosts.mounted.indexOf(entry), 1);
      changed(hosts);
    };
  }, [hosts, entry]);
  useLayoutEffect(() => {
    if (entry.shown?.props === props && entry.shown.locale === locale) return;
    entry.shown = { props, locale };
    changed(hosts);
  });
  return null;
}

/** Internal: whether a startup screen covers the content now. */
export function useStartupCover() {
  const starting = useAppFacts(selectStarting);
  const shown = useShown();
  return starting && shown !== null;
}

/** Internal: the provider's place for the startup screen, beside the content. */
export function StartupHost() {
  const starting = useAppFacts(selectStarting);
  const shown = useShown();
  return starting && shown ? (
    <StartupLayer {...shown.props} locale={shown.locale} />
  ) : null;
}

function StartupLayer({
  appName,
  icon,
  className,
  style,
  locale,
}: AppStartupProps & { readonly locale: Shown['locale'] }) {
  const { messages: m, direction } = locale;
  const [progress, setProgress] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setProgress(true), PROGRESS_DELAY);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div
      data-sempods-ui="startup"
      data-sempods-startup=""
      dir={direction}
      className={className}
      style={style}
    >
      <SdkStyles />
      <style href="sempods-startup" precedence="sempods">
        {layered(styles)}
      </style>
      <div className="sp-startup-content">
        {icon && (
          <div className="sp-startup-icon" aria-hidden="true">
            {icon}
          </div>
        )}
        <h1>{appName}</h1>
        {/* Present from the first frame and filled later, so assistive
            technology announces the status only for a start that takes a while. */}
        <p role="status" className="sp-startup-status">
          {progress ? (
            <>
              <span className="sp-startup-progress" aria-hidden="true" />
              {m.controls.starting ?? m.controls.loading}
            </>
          ) : null}
        </p>
      </div>
    </div>
  );
}

const styles = `
[data-sempods-startup] { position:fixed; inset:0; z-index:999; display:grid; align-items:center; overflow:auto; padding:clamp(16px,4vw,32px); text-align:center; background:var(--sp-bg); color:var(--sp-text); }
[data-sempods-startup] .sp-startup-content { width:100%; max-width:22rem; margin-inline:auto; }
[data-sempods-startup] .sp-startup-icon { margin:0 auto 20px; width:56px; height:56px; }
[data-sempods-startup] .sp-startup-icon > * { width:100%; height:100%; object-fit:contain; }
[data-sempods-startup] h1 { font-size:1.75rem; font-weight:500; line-height:1.25; margin:0; }
[data-sempods-startup] .sp-startup-status { min-height:1.5em; margin:28px 0 0; display:flex; align-items:center; justify-content:center; gap:10px; color:var(--sp-muted); font-size:.875rem; }
[data-sempods-startup] .sp-startup-progress { flex:none; width:16px; height:16px; border-radius:50%; border:2px solid var(--sp-line); border-block-start-color:var(--sp-muted); animation:sp-startup-spin .9s linear infinite; }
@media (prefers-reduced-motion: reduce) {
  [data-sempods-startup] .sp-startup-progress { animation:none; border-color:var(--sp-muted); }
}
@keyframes sp-startup-spin { to { transform:rotate(1turn); } }
`;
