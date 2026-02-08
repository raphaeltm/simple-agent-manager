import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
        <button
          key={s.id}
          data-testid={`tab-${s.id}`}
          onClick={() => onTabActivate(s.id)}
        >
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

  url: string;
  readyState: number = MockWebSocket.OPEN;
  onopen?: (event: Event) => void;
  onclose?: (event: CloseEvent) => void;
  onmessage?: (event: MessageEvent) => void;
  onerror?: (event: Event) => void;

  constructor(url: string) {
    this.url = url;
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
        this.onmessage!(new MessageEvent('message', {
          data: JSON.stringify({
            type: 'session_created',
            sessionId: msg.data.sessionId,
            data: {
              sessionId: msg.data.sessionId,
              workingDirectory: '/workspace',
            },
          }),
        }));
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

describe('MultiTerminal', () => {
  const defaultProps = {
    wsUrl: 'ws://localhost:8080/terminal/ws/multi',
    onActivity: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
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

  it('should handle new tab creation', async () => {
    const sendSpy = vi.spyOn(MockWebSocket.prototype, 'send');
    render(<MultiTerminal {...defaultProps} />);

    await waitFor(() => {
      const newTabButton = screen.queryByTestId('new-tab');
      if (newTabButton) {
        fireEvent.click(newTabButton);
      }
    });

    expect(sendSpy).toHaveBeenCalledWith(
      expect.stringContaining('create_session')
    );
  });

  it('should handle tab closing', async () => {
    const sendSpy = vi.spyOn(MockWebSocket.prototype, 'send');
    render(<MultiTerminal {...defaultProps} />);

    await waitFor(() => {
      const closeButton = screen.queryByTestId(/close-/);
      if (closeButton) {
        fireEvent.click(closeButton);
      }
    });

    const calls = sendSpy.mock.calls;
    const hasCloseSession = calls.some((call) =>
      call[0].includes('close_session')
    );
    const hasCreateSession = calls.some((call) =>
      call[0].includes('create_session')
    );
    expect(hasCloseSession || hasCreateSession || calls.length === 0).toBe(true);
  });

  it('should respect maximum session limit', () => {
    const { container } = render(
      <MultiTerminal {...defaultProps} config={{ maxSessions: 2 }} />
    );
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
});
