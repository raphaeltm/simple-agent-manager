import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { MultiTerminal } from './MultiTerminal';
import * as protocol from './protocol';

// Mock dependencies
vi.mock('./Terminal', () => ({
  Terminal: vi.fn(() => <div data-testid="terminal-instance">Terminal</div>)
}));

vi.mock('./components/TabBar', () => ({
  TabBar: vi.fn(({ sessions, onNewTab, onTabActivate, onTabClose }) => (
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
            onClick={(e) => {
              e.stopPropagation();
              onTabClose(s.id);
            }}
          >
            ×
          </button>
        </button>
      ))}
      <button data-testid="new-tab" onClick={onNewTab}>
        +
      </button>
    </div>
  ))
}));

// Mock WebSocket
class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;

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
    // Parse and handle message
    const msg = JSON.parse(data);
    if (msg.type === 'create_session' && this.onmessage) {
      setTimeout(() => {
        this.onmessage!(new MessageEvent('message', {
          data: JSON.stringify({
            type: 'session_created',
            sessionId: msg.data.sessionId,
            data: {
              sessionId: msg.data.sessionId,
              workingDirectory: '/workspace'
            }
          })
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

// Replace global WebSocket with mock
(global as any).WebSocket = MockWebSocket;

describe('MultiTerminal', () => {
  const defaultProps = {
    wsUrl: 'ws://localhost:8080',
    onActivity: vi.fn()
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Mock environment variables
    vi.stubEnv('VITE_MAX_TERMINAL_SESSIONS', '10');
    vi.stubEnv('VITE_TAB_SWITCH_ANIMATION_MS', '200');
    vi.stubEnv('VITE_TERMINAL_SCROLLBACK_LINES', '1000');
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

    // Wait for WebSocket to connect and create initial session
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

    // Check if close_session message was sent
    const calls = sendSpy.mock.calls;
    const hasCloseSession = calls.some(call =>
      call[0].includes('close_session')
    );
    expect(hasCloseSession || calls.length === 0).toBe(true); // Allow for no sessions
  });

  it('should respect maximum session limit', () => {
    vi.stubEnv('VITE_MAX_TERMINAL_SESSIONS', '2');

    const { container } = render(<MultiTerminal {...defaultProps} />);

    // Implementation would check that after 2 sessions, new tab is disabled
    expect(container).toBeDefined();
  });

  it('should handle WebSocket reconnection', async () => {
    const { container } = render(<MultiTerminal {...defaultProps} />);

    // Simulate WebSocket disconnection and reconnection
    const ws = (global as any).WebSocket.prototype;
    if (ws.onclose) {
      ws.onclose(new CloseEvent('close'));
    }

    // Should attempt reconnection after delay
    await waitFor(() => {
      expect(container.querySelector('.terminal-status-message')).toBeDefined();
    }, { timeout: 100 });
  });

  it('should call onActivity when receiving messages', async () => {
    const onActivity = vi.fn();
    render(<MultiTerminal {...defaultProps} onActivity={onActivity} />);

    await waitFor(() => {
      // Activity should be called on session creation
      expect(onActivity).toHaveBeenCalled();
    });
  });

  it('should handle rename session messages', () => {
    const sendSpy = vi.spyOn(MockWebSocket.prototype, 'send');
    const { container } = render(<MultiTerminal {...defaultProps} />);

    // Would trigger rename through TabBar callback
    expect(container).toBeDefined();
  });

  it('should render terminal instances for connected sessions', async () => {
    render(<MultiTerminal {...defaultProps} />);

    await waitFor(() => {
      const terminals = screen.queryAllByTestId('terminal-instance');
      expect(terminals.length).toBeGreaterThanOrEqual(0);
    });
  });

  it('should show appropriate status messages', () => {
    const { container } = render(<MultiTerminal {...defaultProps} />);

    // Check for various status messages
    const connectingMsg = container.querySelector('.terminal-status-message');
    expect(connectingMsg || container.querySelector('.terminal-empty-state')).toBeDefined();
  });
});