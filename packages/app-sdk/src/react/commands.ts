import { useMemo, useRef } from 'react';

type Commands = Record<string, (...args: never[]) => unknown>;

/**
 * Internal: commands that keep their identity while `generation` stays (for
 * example one target and definition), so they fit effect dependencies, and
 * run the latest render's version. A command kept from an earlier generation
 * keeps running that generation's last version, so it never acts on a newer
 * target.
 */
export function useCommands<C extends Commands>(
  generation: readonly unknown[],
  commands: C,
): C {
  const box = useRef<{ generation: readonly unknown[]; commands: C } | null>(
    null,
  );
  const same =
    box.current !== null &&
    box.current.generation.length === generation.length &&
    box.current.generation.every((value, i) => Object.is(value, generation[i]));
  if (same) box.current!.commands = commands;
  else box.current = { generation, commands };
  const current = box.current!;
  return useMemo(
    () =>
      Object.fromEntries(
        Object.keys(current.commands).map((name) => [
          name,
          (...args: never[]) => current.commands[name]!(...args),
        ]),
      ) as C,
    [current],
  );
}
