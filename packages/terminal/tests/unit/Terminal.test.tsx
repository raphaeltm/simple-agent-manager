import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Terminal } from '../../src/Terminal';

const mockAttachKeyHandler = vi.fn();
const mockTerminalInput = vi.fn();

vi.mock('@xterm/xterm', () => {
  class Terminal {
    rows = 24;
    cols = 80;
    open = vi.fn();
    dispose = vi.fn();
    loadAddon = vi.fn();
    onData = vi.fn();
    write = vi.fn();
    writeln = vi.fn();
    attachCustomKeyEventHandler = mockAttachKeyHandler;
    input = mockTerminalInput;
  }
  return { Terminal };
});

vi.mock('@xterm/addon-fit', () => {
  class FitAddon {
    fit = vi.fn();
    dispose = vi.fn();
  }
  return { FitAddon };
});

vi.mock('../../src/useWebSocket', () => ({
  useWebSocket: () => ({ socket: null, state: 'connecting', retryCount: 0, retry: vi.fn() }),
}));

describe('Terminal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    );
  });

  it('registers the xterm 5 Alt+Arrow word motion on its terminal', () => {
    render(<Terminal wsUrl="ws://localhost/terminal/ws" />);
    expect(mockAttachKeyHandler).toHaveBeenCalledTimes(1);

    const handler = mockAttachKeyHandler.mock.calls[0]![0] as (event: KeyboardEvent) => boolean;
    const handled = handler(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, cancelable: true }));

    expect(handled).toBe(false);
    expect(mockTerminalInput).toHaveBeenCalledWith('\x1b[1;5C', true);
  });
});
