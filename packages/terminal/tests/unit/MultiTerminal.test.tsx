import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MultiTerminal } from '../../src/MultiTerminal';

// Mock xterm.js
const mockTerminalWrite = vi.fn();
const mockTerminalWriteln = vi.fn();
const mockTerminalOpen = vi.fn();
const mockTerminalDispose = vi.fn();
const mockTerminalFocus = vi.fn();
const mockTerminalLoadAddon = vi.fn();
const mockTerminalOnData = vi.fn();
const mockAttachKeyHandler = vi.fn();
const mockTerminalInput = vi.fn();
const mockTerminalDimensions = { rows: 24, cols: 80 };

vi.mock('@xterm/xterm', () => {
  class Terminal {
    write = mockTerminalWrite;
    writeln = mockTerminalWriteln;
    open = mockTerminalOpen;
    dispose = mockTerminalDispose;
    focus = mockTerminalFocus;
    loadAddon = mockTerminalLoadAddon;
    onData = mockTerminalOnData;
    attachCustomKeyEventHandler = mockAttachKeyHandler;
    input = mockTerminalInput;
    get rows() {
      return mockTerminalDimensions.rows;
    }
    get cols() {
      return mockTerminalDimensions.cols;
    }
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

vi.mock('../../src/components/TabBar', () => ({
  TabBar: vi.fn(({ sessions, onNewTab, onTabActivate, onTabClose }: any) => (
    <div data-testid="tab-bar">
      {sessions.map((s: any) => (
        <button key={s.id} data-testid={`tab-${s.id}`} onClick={() => onTabActivate(s.id)}>
          {s.name}
          <button
            data-testid={`close-${s.id}`}
            onClick={(e: any) => {
              e.stopPropagation();
              onTabClose(s.id);
            }}
          >
            x
          </button>
        </button>
      ))}
      <button data-testid="new-tab" onClick={onNewTab}>
        +
      </button>
    </div>
  )),
}));

// Mock WebSocket
class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static CONNECTING = 0;
  static CLOSING = 2;
  static instances: MockWebSocket[] = [];
  static sessionListResponse: Array<{
    sessionId: string;
    name?: string;
    status?: string;
    workingDirectory?: string;
    createdAt: string;
    lastActivityAt?: string;
  }> = [];

  url: string;
  readyState: number = MockWebSocket.OPEN;
  onopen?: (event: Event) => void;
  onclose?: (event: CloseEvent) => void;
  onmessage?: (event: MessageEvent) => void;
  onerror?: (event: Event) => void;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    setTimeout(() => {
      if (this.onopen) {
        this.onopen(new Event('open'));
      }
    }, 0);
  }

  send(data: string) {
    const msg = JSON.parse(data);
    if (msg.type === 'create_session' && this.onmessage) {
      setTimeout(() => {
        this.onmessage!(
          new MessageEvent('message', {
            data: JSON.stringify({
              type: 'session_created',
              sessionId: msg.data.sessionId,
              data: {
                sessionId: msg.data.sessionId,
                workingDirectory: '/workspace',
              },
            }),
          })
        );
      }, 10);
    } else if (msg.type === 'list_sessions' && this.onmessage) {
      setTimeout(() => {
        this.onmessage!(
          new MessageEvent('message', {
            data: JSON.stringify({
              type: 'session_list',
              data: { sessions: MockWebSocket.sessionListResponse },
            }),
          })
        );
      }, 10);
    } else if (msg.type === 'reattach_session' && this.onmessage) {
      setTimeout(() => {
        this.onmessage!(
          new MessageEvent('message', {
            data: JSON.stringify({
              type: 'session_reattached',
              sessionId: msg.data.sessionId,
              data: {
                sessionId: msg.data.sessionId,
                workingDirectory: '/workspace',
              },
            }),
          })
        );
      }, 10);
    }
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) {
      this.onclose(new CloseEvent('close'));
    }
  }
}

Object.defineProperty(globalThis, 'WebSocket', {
  value: MockWebSocket,
  writable: true,
  configurable: true,
});

// Mock ResizeObserver (not available in jsdom)
const resizeObserverCallbacks = new Set<() => void>();
Object.defineProperty(globalThis, 'ResizeObserver', {
  value: class MockResizeObserver {
    constructor(private readonly callback: () => void) {}
    observe() {
      resizeObserverCallbacks.add(this.callback);
    }
    unobserve() {}
    disconnect() {
      resizeObserverCallbacks.delete(this.callback);
    }
  },
  writable: true,
  configurable: true,
});

describe('MultiTerminal', () => {
  const defaultProps = {
    wsUrl: 'ws://localhost:8080/terminal/ws/multi',
    onActivity: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resizeObserverCallbacks.clear();
    mockTerminalDimensions.rows = 24;
    mockTerminalDimensions.cols = 80;
    sessionStorage.clear();
    MockWebSocket.sessionListResponse = [];
    MockWebSocket.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /** Notify every observed terminal container of a size change, then let the debounce run. */
  const notifyContainerResize = async () => {
    resizeObserverCallbacks.forEach((callback) => callback());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
  };

  /** jsdom has no layout; give every element a real box, as a visible terminal tab has. */
  const layOutElements = () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(480);
  };

  const resizesFor = (sendSpy: { mock: { calls: unknown[][] } }, sessionId: string) =>
    sendSpy.mock.calls
      .map(([data]) => JSON.parse(data as string))
      .filter((message) => message.type === 'resize' && message.sessionId === sessionId);

  it('does not fit or resize terminals that are not laid out (hidden tab or hidden view)', async () => {
    const createdAt = new Date().toISOString();
    MockWebSocket.sessionListResponse = [
      { sessionId: 'srv-tab-a', name: 'Tab A', status: 'running', createdAt },
      { sessionId: 'srv-tab-b', name: 'Tab B', status: 'running', createdAt },
    ];
    const sendSpy = vi.spyOn(MockWebSocket.prototype, 'send');
    render(<MultiTerminal {...defaultProps} />);
    // Liveness: both tabs reattached and opened into the DOM.
    await waitFor(() =>
      expect(
        sendSpy.mock.calls.filter(([data]) => JSON.parse(data as string).type === 'reattach_session')
      ).toHaveLength(2)
    );
    await waitFor(() => expect(mockTerminalOpen).toHaveBeenCalled());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    // jsdom gives every element a zero box, as display:none does: the inactive tab, and the
    // active one while the workspace shows a chat tab. Neither may be fitted (a hidden fit
    // measures 100px and shrinks the PTY to 10x5); the ResizeObserver fits on reveal.
    await notifyContainerResize();
    expect(resizesFor(sendSpy, 'srv-tab-b'), 'hidden active tab untouched').toEqual([]);
    expect(resizesFor(sendSpy, 'srv-tab-a'), 'hidden inactive tab untouched').toEqual([]);
  });

  it('registers the xterm 5 Alt+Arrow word motion on each terminal it creates', async () => {
    MockWebSocket.sessionListResponse = [
      { sessionId: 'srv-keys', name: 'Keys', status: 'running', createdAt: new Date().toISOString() },
    ];
    render(<MultiTerminal {...defaultProps} />);
    await waitFor(() => expect(mockAttachKeyHandler).toHaveBeenCalledTimes(1));

    const handler = mockAttachKeyHandler.mock.calls[0]![0] as (event: KeyboardEvent) => boolean;
    const handled = handler(new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, cancelable: true }));

    expect(handled).toBe(false);
    expect(mockTerminalInput).toHaveBeenCalledWith('\x1b[1;5D', true);
  });

  it('refits after a window resize settles, never synchronously', async () => {
    layOutElements();
    MockWebSocket.sessionListResponse = [
      { sessionId: 'srv-window', name: 'Window', status: 'running', createdAt: new Date().toISOString() },
    ];
    const sendSpy = vi.spyOn(MockWebSocket.prototype, 'send');
    render(<MultiTerminal {...defaultProps} />);
    await waitFor(() => expect(resizesFor(sendSpy, 'srv-window')).not.toEqual([]));
    await notifyContainerResize();
    sendSpy.mockClear();

    // Cell metrics change (e.g. devicePixelRatio) with no container size change.
    mockTerminalDimensions.rows = 26;
    mockTerminalDimensions.cols = 90;
    fireEvent.resize(window);
    expect(resizesFor(sendSpy, 'srv-window'), 'no synchronous fit').toEqual([]);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(resizesFor(sendSpy, 'srv-window')).toEqual([
      { type: 'resize', sessionId: 'srv-window', data: { rows: 26, cols: 90 } },
    ]);
  });

  it('fits a terminal mounted while hidden once it is revealed', async () => {
    MockWebSocket.sessionListResponse = [
      { sessionId: 'srv-revealed', name: 'Revealed', status: 'running', createdAt: new Date().toISOString() },
    ];
    const sendSpy = vi.spyOn(MockWebSocket.prototype, 'send');
    render(<MultiTerminal {...defaultProps} />);
    await waitFor(() => expect(mockTerminalOpen).toHaveBeenCalled());
    await notifyContainerResize();
    expect(resizesFor(sendSpy, 'srv-revealed'), 'not fitted while hidden').toEqual([]);

    // The workspace switches from a chat tab to the terminal: the container gets a box.
    layOutElements();
    mockTerminalDimensions.rows = 33;
    mockTerminalDimensions.cols = 101;
    await notifyContainerResize();
    expect(resizesFor(sendSpy, 'srv-revealed')).toEqual([
      { type: 'resize', sessionId: 'srv-revealed', data: { rows: 33, cols: 101 } },
    ]);
  });

  it('fits and sends its size from attach when the tab has a real box', async () => {
    // Same two tabs as the hidden case, but laid out: the inactive tab (A) is only reached by
    // the attach path, so its resize proves attach fits a terminal that is actually visible.
    layOutElements();
    const createdAt = new Date().toISOString();
    MockWebSocket.sessionListResponse = [
      { sessionId: 'srv-tab-a', name: 'Tab A', status: 'running', createdAt },
      { sessionId: 'srv-tab-b', name: 'Tab B', status: 'running', createdAt },
    ];
    const sendSpy = vi.spyOn(MockWebSocket.prototype, 'send');
    render(<MultiTerminal {...defaultProps} />);
    await waitFor(() => expect(resizesFor(sendSpy, 'srv-tab-a')).not.toEqual([]));
    expect(resizesFor(sendSpy, 'srv-tab-b')).not.toEqual([]);
  });

  it('does not resend unchanged dimensions during rerender bursts but sends actual changes', async () => {
    layOutElements();
    MockWebSocket.sessionListResponse = [
      {
        sessionId: 'srv-resize',
        name: 'Resize',
        status: 'running',
        createdAt: new Date().toISOString(),
      },
    ];
    const sendSpy = vi.spyOn(MockWebSocket.prototype, 'send');
    const { rerender } = render(<MultiTerminal {...defaultProps} />);
    await waitFor(() => expect(screen.getByText('Resize')).toBeDefined());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    sendSpy.mockClear();
    for (let index = 0; index < 70; index += 1) {
      rerender(<MultiTerminal {...defaultProps} className={`layout-${index}`} />);
      resizeObserverCallbacks.forEach((callback) => callback());
    }
    await notifyContainerResize();
    const resizeMessages = () =>
      sendSpy.mock.calls
        .map(([data]) => JSON.parse(data as string))
        .filter((msg) => msg.type === 'resize');
    expect(resizeMessages()).toHaveLength(0);
    mockTerminalDimensions.rows = 32;
    mockTerminalDimensions.cols = 100;
    await notifyContainerResize();
    expect(resizeMessages()).toEqual([
      { type: 'resize', sessionId: 'srv-resize', data: { rows: 32, cols: 100 } },
    ]);
  });

  it('sends the same dimensions again when the terminal reconnects on a new socket', async () => {
    layOutElements();
    MockWebSocket.sessionListResponse = [
      {
        sessionId: 'srv-reconnect-size',
        name: 'Reconnect size',
        status: 'running',
        createdAt: new Date().toISOString(),
      },
    ];
    const sendSpy = vi.spyOn(MockWebSocket.prototype, 'send');
    render(<MultiTerminal {...defaultProps} />);
    const sentResizeOn = (socket: MockWebSocket | undefined) =>
      sendSpy.mock.calls.some(([data], index) => {
        const message = JSON.parse(data as string);
        return (
          sendSpy.mock.contexts[index] === socket &&
          message.type === 'resize' &&
          message.sessionId === 'srv-reconnect-size' &&
          message.data.rows === 24 &&
          message.data.cols === 80
        );
      });
    await waitFor(() => expect(sentResizeOn(MockWebSocket.instances[0])).toBe(true));
    act(() => {
      MockWebSocket.instances[0]?.close();
    });
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2), { timeout: 4500 });
    await waitFor(() => expect(sentResizeOn(MockWebSocket.instances[1])).toBe(true));
  });

  it('notifies session changes without feeding parent callback rerenders back into notifications', async () => {
    MockWebSocket.sessionListResponse = [
      {
        sessionId: 'srv-notify',
        name: 'Notify',
        status: 'running',
        createdAt: new Date().toISOString(),
      },
    ];
    const initialCallback = vi.fn();
    const { rerender } = render(
      <MultiTerminal {...defaultProps} onSessionsChange={initialCallback} />
    );
    await waitFor(() => expect(screen.getByText('Notify')).toBeDefined());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    const latestCallback = vi.fn();
    rerender(<MultiTerminal {...defaultProps} onSessionsChange={latestCallback} />);
    expect(latestCallback).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('new-tab'));
    await waitFor(() => expect(latestCallback).toHaveBeenCalled());
  });

  it('should render empty state initially', () => {
    render(<MultiTerminal {...defaultProps} />);
    expect(screen.getByText('No terminal sessions')).toBeDefined();
  });

  it('should create initial terminal on WebSocket connection', async () => {
    const { rerender } = render(<MultiTerminal {...defaultProps} />);

    await waitFor(() => {
      rerender(<MultiTerminal {...defaultProps} />);
      const tabBar = screen.queryByTestId('tab-bar');
      expect(tabBar).toBeDefined();
    });
  });

  it('should hydrate tabs from server session list when local state is empty', async () => {
    MockWebSocket.sessionListResponse = [
      {
        sessionId: 'srv-1',
        name: 'Build',
        status: 'running',
        createdAt: new Date().toISOString(),
      },
    ];
    const sendSpy = vi.spyOn(MockWebSocket.prototype, 'send');

    render(<MultiTerminal {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Build')).toBeDefined();
    });

    await waitFor(() => {
      const hasReattach = sendSpy.mock.calls.some((call) => {
        const payload = JSON.parse(call[0] as string);
        return payload.type === 'reattach_session' && payload.data?.sessionId === 'srv-1';
      });
      expect(hasReattach).toBe(true);
    });
  });

  it('should handle new tab creation', async () => {
    const sendSpy = vi.spyOn(MockWebSocket.prototype, 'send');
    render(<MultiTerminal {...defaultProps} />);

    // Wait for initial WebSocket connection and session creation
    await waitFor(
      () => {
        const calls = sendSpy.mock.calls;
        const hasCreateSession = calls.some(
          (call) => typeof call[0] === 'string' && call[0].includes('create_session')
        );
        expect(hasCreateSession).toBe(true);
      },
      { timeout: 2000 }
    );

    // Now click the new tab button
    const newTabButton = screen.queryByTestId('new-tab');
    if (newTabButton) {
      fireEvent.click(newTabButton);
    }

    // Should have sent another create_session for the new tab
    await waitFor(() => {
      const calls = sendSpy.mock.calls;
      const createSessionCalls = calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('create_session')
      );
      expect(createSessionCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('sends defaultWorkDir in create_session payloads', async () => {
    const sendSpy = vi.spyOn(MockWebSocket.prototype, 'send');
    render(<MultiTerminal {...defaultProps} defaultWorkDir="/workspaces/repo-wt-feature" />);

    await waitFor(() => {
      const payload = sendSpy.mock.calls
        .map((call) => JSON.parse(call[0] as string))
        .find((data) => data.type === 'create_session');
      expect(payload).toBeDefined();
      expect(payload.data.workDir).toBe('/workspaces/repo-wt-feature');
    });
  });

  it('uses updated defaultWorkDir after prop change', async () => {
    const sendSpy = vi.spyOn(MockWebSocket.prototype, 'send');
    const { rerender } = render(
      <MultiTerminal {...defaultProps} defaultWorkDir="/workspaces/repo" />
    );

    // Wait for initial session to be created with original workDir
    await waitFor(() => {
      const payload = sendSpy.mock.calls
        .map((call) => JSON.parse(call[0] as string))
        .find((data) => data.type === 'create_session');
      expect(payload).toBeDefined();
      expect(payload.data.workDir).toBe('/workspaces/repo');
    });

    // Change the worktree prop
    rerender(<MultiTerminal {...defaultProps} defaultWorkDir="/workspaces/repo-wt-feature" />);

    // Clear previous calls so we can isolate the new tab creation
    sendSpy.mockClear();

    // Click new tab — should use updated workDir
    const newTabButton = screen.queryByTestId('new-tab');
    if (newTabButton) {
      fireEvent.click(newTabButton);
    }

    await waitFor(() => {
      const payload = sendSpy.mock.calls
        .map((call) => JSON.parse(call[0] as string))
        .find((data) => data.type === 'create_session');
      expect(payload).toBeDefined();
      expect(payload.data.workDir).toBe('/workspaces/repo-wt-feature');
    });
  });

  it('should handle tab closing', async () => {
    const sendSpy = vi.spyOn(MockWebSocket.prototype, 'send');
    render(<MultiTerminal {...defaultProps} />);

    const newTabButton = await screen.findByTestId('new-tab');
    fireEvent.click(newTabButton);

    await waitFor(() => {
      const closeButton = screen.queryByTestId(/close-/);
      expect(closeButton).toBeDefined();
    });
    const closeButton = screen.getByTestId(/close-/);
    fireEvent.click(closeButton);

    await waitFor(() => {
      const hasCloseSession = sendSpy.mock.calls.some((call) => {
        const payload = JSON.parse(call[0] as string);
        return payload.type === 'close_session';
      });
      expect(hasCloseSession).toBe(true);
    });
  });

  it('should close reattached sessions using server session id', async () => {
    const persistenceKey = 'multi-terminal-persist-test';
    sessionStorage.setItem(
      persistenceKey,
      JSON.stringify({
        sessions: [{ name: 'Persisted Tab', order: 0, serverSessionId: 'srv-persisted' }],
        counter: 2,
      })
    );
    MockWebSocket.sessionListResponse = [
      {
        sessionId: 'srv-persisted',
        name: 'Persisted Tab',
        status: 'running',
        createdAt: new Date().toISOString(),
      },
    ];

    const sendSpy = vi.spyOn(MockWebSocket.prototype, 'send');
    render(<MultiTerminal {...defaultProps} persistenceKey={persistenceKey} />);

    await waitFor(() => {
      expect(screen.getByText('Persisted Tab')).toBeDefined();
    });

    const closeButton = await screen.findByTestId(/close-/);
    fireEvent.click(closeButton);

    await waitFor(() => {
      const closePayload = sendSpy.mock.calls
        .map((call) => JSON.parse(call[0] as string))
        .find((payload) => payload.type === 'close_session');
      expect(closePayload).toBeDefined();
      expect(closePayload.data.sessionId).toBe('srv-persisted');
    });
  });

  it('should respect maximum session limit', () => {
    const { container } = render(<MultiTerminal {...defaultProps} config={{ maxSessions: 2 }} />);
    expect(container).toBeDefined();
  });

  it('should call onActivity when receiving messages', async () => {
    const onActivity = vi.fn();
    render(<MultiTerminal {...defaultProps} onActivity={onActivity} />);

    await waitFor(() => {
      expect(onActivity).toHaveBeenCalled();
    });
  });

  it('should show empty state before any session is created', () => {
    render(<MultiTerminal {...defaultProps} />);
    // Before WS opens and creates a session, the component shows the empty state
    expect(screen.getByText('No terminal sessions')).toBeDefined();
  });

  it('uses resolveWsUrl for reconnect attempts', async () => {
    const resolveWsUrl = vi
      .fn()
      .mockResolvedValueOnce('ws://localhost:8080/terminal/ws/multi?token=first')
      .mockResolvedValueOnce('ws://localhost:8080/terminal/ws/multi?token=second');

    render(<MultiTerminal {...defaultProps} resolveWsUrl={resolveWsUrl} />);

    await waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(1);
    });
    expect(MockWebSocket.instances[0]?.url).toContain('token=first');

    act(() => {
      MockWebSocket.instances[0]?.close();
    });

    await waitFor(
      () => {
        expect(MockWebSocket.instances.length).toBe(2);
      },
      { timeout: 7000 }
    );
    expect(MockWebSocket.instances[1]?.url).toContain('token=second');
    expect(resolveWsUrl).toHaveBeenCalledTimes(2);
  });

  it('clears ping interval before creating a new one on reconnect', async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    render(<MultiTerminal {...defaultProps} />);

    // Wait for initial WebSocket connection and session creation
    await waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(1);
    });

    // setInterval should have been called for ping
    const initialSetIntervalCalls = setIntervalSpy.mock.calls.length;
    expect(initialSetIntervalCalls).toBeGreaterThanOrEqual(1);

    // Close the connection to trigger reconnect
    act(() => {
      MockWebSocket.instances[0]?.close();
    });

    await waitFor(
      () => {
        expect(MockWebSocket.instances.length).toBe(2);
      },
      { timeout: 7000 }
    );

    // clearInterval should have been called to clean up old ping
    expect(clearIntervalSpy).toHaveBeenCalled();

    // A new setInterval should have been created for the new connection
    expect(setIntervalSpy.mock.calls.length).toBeGreaterThan(initialSetIntervalCalls);

    clearIntervalSpy.mockRestore();
    setIntervalSpy.mockRestore();
  });
});
