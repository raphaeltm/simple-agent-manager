import type { Terminal as XTerm } from '@xterm/xterm';

const ESC = '\x1b';

/** Same platform test xterm.js uses for its own macOS keyboard handling. */
function detectMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return ['Macintosh', 'MacIntel', 'MacPPC', 'Mac68K'].includes(navigator.platform);
}

/**
 * Bytes xterm.js 5.x sent for Alt+Arrow (with no other modifier). xterm 6 dropped this
 * mapping (xtermjs/xterm.js#5346) and now sends `ESC[1;3X`, which readline does not bind,
 * so Option/Alt+Left/Right stop moving by word. These values are copied from xterm 5.5.0
 * `src/common/input/Keyboard.ts`.
 */
export function altArrowSequence(key: string, isMac: boolean): string | null {
  switch (key) {
    case 'ArrowLeft':
      return isMac ? `${ESC}b` : `${ESC}[1;5D`;
    case 'ArrowRight':
      return isMac ? `${ESC}f` : `${ESC}[1;5C`;
    case 'ArrowUp':
      return isMac ? null : `${ESC}[1;5A`;
    case 'ArrowDown':
      return isMac ? null : `${ESC}[1;5B`;
    default:
      return null;
  }
}

/**
 * Keep the xterm 5 Alt+Arrow word-navigation behavior on an xterm 6 terminal.
 * xterm allows one custom key handler per terminal and a second call replaces this one, so
 * any future key handling must be added here rather than attached separately.
 */
export function preserveAltArrowWordNavigation(terminal: XTerm, isMac = detectMac()): void {
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;
    if (!event.altKey || event.ctrlKey || event.shiftKey || event.metaKey) return true;

    const sequence = altArrowSequence(event.key, isMac);
    if (!sequence) return true;

    event.preventDefault();
    event.stopPropagation();
    terminal.input(sequence, true);
    return false;
  });
}
