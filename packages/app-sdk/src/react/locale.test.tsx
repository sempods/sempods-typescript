// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SdkLocaleProvider, useSdkLocale } from './index.js';

afterEach(cleanup);
it('retranslates without replacing a child draft', () => {
  function Content() {
    const [draft, setDraft] = useState('');
    const { messages, format } = useSdkLocale();
    return (
      <>
        <input
          aria-label="draft"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <p>{messages.reviewAccess}</p>
        <p>{format.number(1234.5)}</p>
      </>
    );
  }
  const view = render(
    <SdkLocaleProvider locale="en-US">
      <Content />
    </SdkLocaleProvider>,
  );
  fireEvent.change(screen.getByLabelText('draft'), {
    target: { value: 'Unfinished' },
  });
  view.rerender(
    <SdkLocaleProvider locale="de-CH">
      <Content />
    </SdkLocaleProvider>,
  );
  expect(screen.getByDisplayValue('Unfinished')).toBeTruthy();
  expect(screen.getByText('Zugriff prüfen')).toBeTruthy();
  expect(screen.getByText(/^1['’]234\.5$/)).toBeTruthy();
});
