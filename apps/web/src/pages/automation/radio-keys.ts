/**
 * Keyboard behaviour for a radiogroup built from buttons (the WAI-ARIA radio pattern): the group
 * is one tab stop, arrow keys move both the choice and focus, and Home/End jump to the ends.
 * Disabled options are skipped. Used by the filter chips and the choice cards.
 */
import { type KeyboardEvent, useRef } from 'react';

export function useRadioKeys<T extends string>(
  options: ReadonlyArray<{ id: T; disabled?: boolean }>,
  value: T | null,
  onChange: (id: T) => void
) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const enabled = options.flatMap((option, index) => (option.disabled ? [] : [index]));
  const selected = options.findIndex((option) => option.id === value);
  const tabStop = selected >= 0 && enabled.includes(selected) ? selected : enabled[0];

  return (index: number) => ({
    ref: (element: HTMLButtonElement | null) => {
      refs.current[index] = element;
    },
    tabIndex: index === tabStop ? 0 : -1,
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
      const at = enabled.indexOf(index);
      const step =
        event.key === 'ArrowRight' || event.key === 'ArrowDown'
          ? 1
          : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
            ? -1
            : 0;
      const next = step
        ? enabled[(at + step + enabled.length) % enabled.length]
        : event.key === 'Home'
          ? enabled[0]
          : event.key === 'End'
            ? enabled.at(-1)
            : undefined;
      const option = next === undefined ? undefined : options[next];
      if (next === undefined || !option) return;
      event.preventDefault();
      onChange(option.id);
      refs.current[next]?.focus();
    },
  });
}
