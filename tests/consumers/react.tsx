import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createFormatters } from '@sempods/app-sdk';
import { SdkLocaleProvider, useSdkLocale } from '@sempods/app-sdk/react';

function Task() {
  const [draft, setDraft] = useState('');
  const { messages } = useSdkLocale();
  return (
    <>
      <input
        aria-label="draft"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <p>{messages.reviewAccess}</p>
    </>
  );
}
function App() {
  const [locale, setLocale] = useState('en-US');
  return (
    <SdkLocaleProvider locale={locale}>
      <Task />
      <button onClick={() => setLocale('de-DE')}>Deutsch</button>
      <output>{createFormatters(locale).number(1234.5)}</output>
    </SdkLocaleProvider>
  );
}
const host = document.getElementById('app');
if (!host) throw new Error('Missing consumer mount point.');
createRoot(host).render(<App />);
