import { useState } from 'react';
import { Button } from '@sempods/app-ui';
import { NotToday } from './not-today';

/**
 * The README's "Not today" action (`?screen=date-choice`, #400): a task
 * that waits until 25 November 2026, with today fixed at 19 November 2026 so
 * the checks see the same presets and minimum on every run. The stored day
 * shows on the page.
 */
export function DateChoiceGate() {
  const [open, setOpen] = useState(false);
  const [until, setUntil] = useState<string | null>('2026-11-25');
  return (
    <main className="gate-main">
      <h1>Call the plumber</h1>
      <output data-until={until ?? 'none'}>{until ?? 'none'}</output>
      <Button variant="outline" className="h-11" onPress={() => setOpen(true)}>
        Not today
      </Button>
      <NotToday
        open={open}
        today="2026-11-19"
        until={until}
        postpone={setUntil}
        close={() => setOpen(false)}
      />
    </main>
  );
}
