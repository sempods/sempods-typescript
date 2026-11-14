import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
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

/**
 * One provider's startup screen: the `AppStartup` instances, oldest first
 * (the first shows), and the container beside the content that it renders
 * into.
 */
interface Hosts {
  readonly mounted: symbol[];
  readonly listeners: Set<() => void>;
  container: HTMLElement | null;
}
const registry = new WeakMap<object, Hosts>();
function hostsOf(app: object) {
  let hosts = registry.get(app);
  if (!hosts) {
    hosts = { mounted: [], listeners: new Set(), container: null };
    registry.set(app, hosts);
  }
  return hosts;
}
function notify(hosts: Hosts) {
  hosts.listeners.forEach((listener) => listener());
}
function useHosts<T>(read: (hosts: Hosts) => T): T {
  const hosts = hostsOf(useController());
  const get = () => read(hosts);
  return useSyncExternalStore(
    (listener) => {
      hosts.listeners.add(listener);
      return () => hosts.listeners.delete(listener);
    },
    get,
    get,
  );
}

/**
 * The startup screen while the app starts (`useAppState().starting`): a
 * full-viewport layer with the app's `icon` and `appName`, centred like the
 * sign-in screen's header. It renders through a portal into a container the
 * provider keeps beside the app's content, so it keeps the React context
 * where it is placed (a nested `SdkLocaleProvider`, the providers an `icon`
 * uses) and the theme its DOM ancestors set (`--sempods-*` tokens,
 * `color-scheme`), while the content stays mounted and is inert and hidden from
 * assistive technology meanwhile (as behind the gate), and `TargetScreen`
 * demands and reads already start. After 350 ms it adds a progress
 * indicator and a status (`controls.starting`), announced politely. It has
 * no controls and never takes focus. One shows per provider, the first
 * mounted; `AppAccess` places one unless `startup="none"`. Match a static
 * HTML splash to it (see the startup sequence in the React guide), so the
 * hand-over is invisible.
 */
export function AppStartup(props: AppStartupProps) {
  const hosts = hostsOf(useController());
  const [token] = useState(() => Symbol('startup'));
  // Before paint, so the first frame already covers the content.
  useLayoutEffect(() => {
    hosts.mounted.push(token);
    notify(hosts);
    return () => {
      hosts.mounted.splice(hosts.mounted.indexOf(token), 1);
      notify(hosts);
    };
  }, [hosts, token]);
  const starting = useAppFacts(selectStarting);
  const first = useHosts((h) => h.mounted[0] === token);
  const container = useHosts((h) => h.container);
  const shows = starting && first && container !== null;
  // The portal leaves the DOM ancestors of this placement. Where they set a
  // different theme (`--sempods-*` tokens, `color-scheme`) than the portal's
  // own ancestors, a wrapper carries the difference, so the layer inherits
  // what the gate, rendered in place, would; its own `className` and `style`
  // still win. Values the portal shares (for example on `:root`) are not
  // copied and follow changes by themselves; the copied ones are read again
  // on any DOM change while the screen shows, so an app that loads its theme
  // during startup is followed.
  const anchor = useRef<HTMLSpanElement>(null);
  const [theme, setTheme] = useState<Theme>(noTheme);
  useLayoutEffect(() => {
    const placed = anchor.current;
    if (!shows || !placed || !container) return;
    const read = () => {
      const next = placementTheme(placed, container);
      setTheme((current) => (sameTheme(current, next) ? current : next));
    };
    read();
    if (typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(read);
    observer.observe(placed.ownerDocument.documentElement, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, [shows, container]);
  return (
    <>
      <span ref={anchor} hidden data-sempods-startup-anchor="" />
      {shows &&
        createPortal(
          <div
            data-sempods-startup-theme=""
            style={{ display: 'contents', ...theme } as CSSProperties}
          >
            <StartupLayer {...props} />
          </div>,
          container,
        )}
    </>
  );
}

type Theme = Readonly<Record<string, string>>;
const noTheme: Theme = Object.freeze({});
/** The access surfaces' tokens (see `styles.tsx`), as a host may set them. */
const tokens = [
  'bg',
  'text',
  'muted',
  'line',
  'accent',
  'on-accent',
  'field-line',
  'primary-bg',
  'primary-text',
  'primary-border',
  'secondary-bg',
  'secondary-text',
  'secondary-border',
  'focus',
  'font',
  'radius',
].map((name) => `--sempods-${name}`);
/**
 * What the placement inherits differently from the portal's container: each
 * token whose value differs (`initial` where only the container has one, so
 * the default applies as at the placement) and a differing `color-scheme`.
 */
function placementTheme(placed: Element, container: Element): Theme {
  const here = getComputedStyle(placed);
  const there = getComputedStyle(container);
  const theme: Record<string, string> = {};
  for (const token of tokens) {
    const value = here.getPropertyValue(token).trim();
    if (value !== there.getPropertyValue(token).trim())
      theme[token] = value || 'initial';
  }
  const scheme = here.getPropertyValue('color-scheme').trim() || 'normal';
  if (scheme !== (there.getPropertyValue('color-scheme').trim() || 'normal'))
    theme.colorScheme = scheme;
  return theme;
}
function sameTheme(a: Theme, b: Theme) {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k])
  );
}

/** Internal: whether a startup screen covers the content now. */
export function useStartupCover() {
  const starting = useAppFacts(selectStarting);
  const placed = useHosts((h) => h.mounted.length > 0);
  return starting && placed;
}

/**
 * Internal: the provider's container for the startup screen, beside (not
 * inside) the content that turns inert behind it.
 */
export function StartupHost() {
  const hosts = hostsOf(useController());
  const attach = useCallback(
    (node: HTMLDivElement | null) => {
      hosts.container = node;
      notify(hosts);
    },
    [hosts],
  );
  return <div ref={attach} style={{ display: 'contents' }} />;
}

function StartupLayer({ appName, icon, className, style }: AppStartupProps) {
  const { messages: m, direction } = useSdkLocale();
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
