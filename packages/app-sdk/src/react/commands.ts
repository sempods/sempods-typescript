import { useLayoutEffect, useMemo, useState } from 'react';

type Commands = Record<string, (...args: never[]) => unknown>;

/**
 * Internal: commands that keep their identity while `generation` stays (for
 * example one target and definition), so they fit effect dependencies, and
 * run the latest committed render's version. A command kept from an earlier generation
 * keeps running that generation's last version, so it never acts on a newer
 * target.
 */
export function useCommands<C extends Commands>(
  generation: readonly unknown[],
  commands: C,
): C {
  const [current, setCurrent] = useState(() => ({ generation, commands }));
  const same =
    current.generation.length === generation.length &&
    current.generation.every((value, i) => Object.is(value, generation[i]));
  if (!same) setCurrent({ generation, commands });
  useLayoutEffect(() => {
    current.commands = commands;
  }, [current, commands]);
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
