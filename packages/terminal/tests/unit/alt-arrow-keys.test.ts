import type { Terminal as XTerm } from '@xterm/xterm';
import { describe, expect, it, vi } from 'vitest';

import { altArrowSequence, preserveAltArrowWordNavigation } from '../../src/alt-arrow-keys';

function fakeTerminal() {
  let handler: ((event: KeyboardEvent) => boolean) | null = null;
  const input = vi.fn();
  const terminal = {
    attachCustomKeyEventHandler: (fn: (event: KeyboardEvent) => boolean) => {
      handler = fn;
    },
    input,
  } as unknown as XTerm;
  const press = (init: KeyboardEventInit, type = 'keydown') => {
    const event = new KeyboardEvent(type, { cancelable: true, ...init });
    const result = handler!(event);
    return { result, event };
  };
  return { terminal, input, press };
}

describe('altArrowSequence', () => {
  it.each([
    ['ArrowLeft', false, '\x1b[1;5D'],
    ['ArrowRight', false, '\x1b[1;5C'],
    ['ArrowUp', false, '\x1b[1;5A'],
    ['ArrowDown', false, '\x1b[1;5B'],
    ['ArrowLeft', true, '\x1bb'],
    ['ArrowRight', true, '\x1bf'],
    ['ArrowUp', true, null],
    ['ArrowDown', true, null],
    ['a', false, null],
  ])('%s (mac=%s) matches xterm 5.5', (key, isMac, expected) => {
    expect(altArrowSequence(key, isMac)).toBe(expected);
  });
});

describe('preserveAltArrowWordNavigation', () => {
  it('sends the xterm 5 word-navigation bytes for Alt+Left on Linux and stops default handling', () => {
    const { terminal, input, press } = fakeTerminal();
    preserveAltArrowWordNavigation(terminal, false);

    const { result, event } = press({ key: 'ArrowLeft', altKey: true });

    expect(result).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(input).toHaveBeenCalledWith('\x1b[1;5D', true);
  });

  it('sends readline word motions on macOS', () => {
    const { terminal, input, press } = fakeTerminal();
    preserveAltArrowWordNavigation(terminal, true);

    press({ key: 'ArrowRight', altKey: true });

    expect(input).toHaveBeenCalledWith('\x1bf', true);
  });

  it.each([
    [{ key: 'ArrowLeft' }, 'keydown'],
    [{ key: 'ArrowLeft', altKey: true, shiftKey: true }, 'keydown'],
    [{ key: 'ArrowLeft', altKey: true, ctrlKey: true }, 'keydown'],
    [{ key: 'ArrowLeft', altKey: true, metaKey: true }, 'keydown'],
    [{ key: 'ArrowLeft', altKey: true }, 'keyup'],
    [{ key: 'ArrowUp', altKey: true }, 'keydown'],
    [{ key: 'b', altKey: true }, 'keydown'],
  ] as const)('leaves %o (%s) to xterm on macOS', (init, type) => {
    const { terminal, input, press } = fakeTerminal();
    preserveAltArrowWordNavigation(terminal, true);

    const { result, event } = press(init, type);

    expect(result).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(input).not.toHaveBeenCalled();
  });
});
