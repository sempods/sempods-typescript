// @vitest-environment jsdom
import { Suspense, startTransition, useState } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { useCommands } from './commands.js';

afterEach(cleanup);

it.each([false, true])(
  'commands keep committed inputs through suspension (new generation: %s)',
  async (newGeneration) => {
    let resolve!: () => void;
    let suspended = true;
    let attempted = false;
    const gate = new Promise<void>((done) => {
      resolve = done;
    });
    const calls: string[] = [];
    let active!: () => void;
    function Probe({ value }: { value: string }) {
      const commands = useCommands([newGeneration ? value : 'same'], {
        run: () => calls.push(value),
      });
      if (value === 'B' && suspended) {
        attempted = true;
        throw gate;
      }
      return (
        <button
          onClick={() => {
            active = commands.run;
            commands.run();
          }}
        >
          Run {value}
        </button>
      );
    }
    function Host() {
      const [value, setValue] = useState('A');
      return (
        <>
          <button onClick={() => startTransition(() => setValue('B'))}>
            Start B
          </button>
          <button onClick={() => setValue('A')}>Abandon B</button>
          <Suspense fallback={<span>Fallback</span>}>
            <Probe value={value} />
          </Suspense>
        </>
      );
    }
    render(<Host />);
    fireEvent.click(screen.getByText('Run A'));
    const original = active;
    fireEvent.click(screen.getByText('Start B'));
    expect(attempted).toBe(true);
    fireEvent.click(screen.getByText('Run A'));
    expect(active).toBe(original);
    expect(calls).toEqual(['A', 'A']);
    fireEvent.click(screen.getByText('Abandon B'));
    fireEvent.click(screen.getByText('Run A'));
    expect(active).toBe(original);

    fireEvent.click(screen.getByText('Start B'));
    await act(async () => {
      suspended = false;
      resolve();
    });
    fireEvent.click(screen.getByText('Run B'));
    expect(active === original).toBe(!newGeneration);
    original();
    expect(calls).toEqual(['A', 'A', 'A', 'B', newGeneration ? 'A' : 'B']);
  },
);
