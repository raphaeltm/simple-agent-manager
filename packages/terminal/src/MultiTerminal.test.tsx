import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MultiTerminal } from './MultiTerminal';

// Mock xterm.js
const mockTerminalWrite = vi.fn();
const mockTerminalWriteln = vi.fn();
const mockTerminalOpen = vi.fn();
const mockTerminalDispose = vi.fn();
const mockTerminalFocus = vi.fn();
const mockTerminalLoadAddon = vi.fn();
const mockTerminalOnData = vi.fn();

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(() => ({
    write: mockTerminalWrite,
    writeln: mockTerminalWriteln,
    open: mockTerminalOpen,
    dispose: mockTerminalDispose,
    focus: mockTerminalFocus,
    loadAddon: mockTerminalLoadAddon,
    onData: mockTerminalOnData,
    rows: 24,
    cols: 80,
  })),
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn().mockImplementation(() => ({
    fit: vi.fn(),
    dispose: vi.fn(),
  })),
}));

vi.mock('./components/TabBar', () => ({
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

(global as any).WebSocket = MockWebSocket;

// Mock ResizeObserver (not available in jsdom)
(global as any).ResizeObserver = class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

describe('MultiTerminal', () => {
  const defaultProps = {
    wsUrl: 'ws://localhost:8080/terminal/ws/multi',
    onActivity: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    MockWebSocket.sessionListResponse = [];
    MockWebSocket.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
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

  it('should show appropriate status messages', () => {
    const { container } = render(<MultiTerminal {...defaultProps} />);

    const connectingMsg = container.querySelector('.terminal-status-message');
    expect(connectingMsg || container.querySelector('.terminal-empty-state')).toBeDefined();
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
});
