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
