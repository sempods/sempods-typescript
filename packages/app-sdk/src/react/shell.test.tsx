// @vitest-environment jsdom
import { useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import {
  AccessNotice,
  AppAccess,
  SempodsProvider,
  useAppState,
  useSdkLocale,
  useWorkflowAccess,
} from './index.js';
import { fixture } from '../runtime/fixture.test.js';

/**
 * What an app overlay library does when its overlay opens (React Aria's
 * `ariaHideOutside` with `inert`, as the UI kit's Dialog uses it): it marks
 * the highest elements outside the overlay inert and spares top-layer
 * elements that exist by then, with their ancestors.
 */
export function markOutside(overlay: Element) {
  const spared = [
    overlay,
    ...document.querySelectorAll('[data-react-aria-top-layer]'),
  ];
  const visit = (element: Element) => {
    if (spared.includes(element)) return;
    if (!spared.some((node) => element.contains(node))) {
      element.setAttribute('inert', '');
      return;
    }
    for (const child of element.children) visit(child);
  };
  for (const child of document.body.children) visit(child);
}

/**
 * The standard composition the tests share: an app header with the
 * management button, `AppAccess` beside the content, content once storage is
 * durable, and the read-only notice.
 */
export function TestShell({
  children,
  title = 'sempods',
  mode,
  components,
}: {
  readonly children?: ReactNode;
  readonly title?: string;
  readonly mode?: 'single' | 'multiple';
  readonly components?: ComponentProps<typeof AppAccess>['components'];
}) {
  const [open, setOpen] = useState(false);
  const target = useRef<HTMLButtonElement>(null);
  const { messages } = useSdkLocale();
  const state = useAppState();
  const access = useWorkflowAccess();
  return (
    <main>
      <header>
        <h1>{title}</h1>
        <button
          ref={target}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {messages.controls.dataAccess}
        </button>
      </header>
      <AppAccess
        appName={title}
        headingLevel={2}
        open={open}
        focusTarget={target}
        {...(mode ? { mode } : {})}
        {...(components ? { components } : {})}
      />
      {!open &&
        access.read &&
        !access.write &&
        access.connection?.catalogue.kind === 'ready' && <AccessNotice />}
      {state.startup?.storage === 'durable' && !state.startupError && children}
    </main>
  );
}

afterEach(cleanup);
it('renders the management button and keeps content until storage settles', async () => {
  const f = fixture();
  render(
    <SempodsProvider runtime={f.runtime}>
      <TestShell>
        <p>Content</p>
      </TestShell>
    </SempodsProvider>,
  );
  expect(
    await screen.findByRole('button', { name: 'Pods & sharing' }),
  ).toBeTruthy();
  expect(await screen.findByText('Content')).toBeTruthy();
  f.runtime.dispose();
});
