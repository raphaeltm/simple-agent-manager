import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LogStream } from '../../../../src/components/admin/LogStream';
import type { StreamLogEntry, StreamConnectionState } from '../../../../src/hooks/useAdminLogStream';

// Mock the useAdminLogStream hook
const mockUseAdminLogStream = vi.fn();
vi.mock('../../../../src/hooks/useAdminLogStream', () => ({
  useAdminLogStream: () => mockUseAdminLogStream(),
}));

// Mock the UI library components
vi.mock('@simple-agent-manager/ui', () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div data-testid="card">{children}</div>,
  Button: ({ children, onClick, disabled, size, variant }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean; size?: string; variant?: string }) => (
    <button onClick={onClick} disabled={disabled} data-size={size} data-variant={variant}>{children}</button>
  ),
  Body: ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) => (
    <p style={style}>{children}</p>
  ),
}));

function createMockEntry(overrides: Partial<StreamLogEntry> = {}): StreamLogEntry {
  return {
    timestamp: '2026-02-14T12:00:00.000Z',
    level: 'info',
    event: 'http.request',
    message: 'GET /api/health',
    details: {},
    scriptName: 'workspaces-api',
    ...overrides,
  };
}

function defaultHookReturn(overrides: Partial<ReturnType<typeof mockUseAdminLogStream>> = {}) {
  return {
    entries: [],
    state: 'connected' as StreamConnectionState,
    paused: false,
    clientCount: 1,
    filter: { levels: [], search: '' },
    setLevels: vi.fn(),
    setSearch: vi.fn(),
    togglePause: vi.fn(),
    clear: vi.fn(),
    retry: vi.fn(),
    ...overrides,
  };
}

describe('LogStream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should show connection status indicator', () => {
    mockUseAdminLogStream.mockReturnValue(defaultHookReturn({ state: 'connected' }));

    render(<LogStream />);
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByTestId('connection-indicator')).toBeInTheDocument();
  });

  it('should show connecting state', () => {
    mockUseAdminLogStream.mockReturnValue(defaultHookReturn({ state: 'connecting' }));

    render(<LogStream />);
    expect(screen.getByText('Connecting...')).toBeInTheDocument();
  });

  it('should show reconnecting state', () => {
    mockUseAdminLogStream.mockReturnValue(defaultHookReturn({ state: 'reconnecting' }));

    render(<LogStream />);
    expect(screen.getByText('Reconnecting...')).toBeInTheDocument();
  });

  it('should show disconnected state with Reconnect button', () => {
    const mockRetry = vi.fn();
    mockUseAdminLogStream.mockReturnValue(defaultHookReturn({
      state: 'disconnected',
      retry: mockRetry,
    }));

    render(<LogStream />);
    expect(screen.getByText('Disconnected')).toBeInTheDocument();

    const reconnectBtn = screen.getByText('Reconnect');
    reconnectBtn.click();
    expect(mockRetry).toHaveBeenCalledTimes(1);
  });

  it('should show empty state when connected with no entries', () => {
    mockUseAdminLogStream.mockReturnValue(defaultHookReturn({ state: 'connected' }));

    render(<LogStream />);
    expect(screen.getByText(/waiting for log entries/i)).toBeInTheDocument();
  });

  it('should show paused message when paused with no entries', () => {
    mockUseAdminLogStream.mockReturnValue(defaultHookReturn({
      state: 'connected',
      paused: true,
    }));

    render(<LogStream />);
    expect(screen.getByText(/stream paused/i)).toBeInTheDocument();
  });

  it('should render log entries', () => {
    mockUseAdminLogStream.mockReturnValue(defaultHookReturn({
      entries: [
        createMockEntry({ message: 'Request to /health', level: 'info' }),
        createMockEntry({ message: 'Database error', level: 'error' }),
      ],
    }));

    render(<LogStream />);
    expect(screen.getByText('Request to /health')).toBeInTheDocument();
    expect(screen.getByText('Database error')).toBeInTheDocument();
  });

  it('should have Pause/Resume button', () => {
    const mockTogglePause = vi.fn();
    mockUseAdminLogStream.mockReturnValue(defaultHookReturn({
      paused: false,
      togglePause: mockTogglePause,
    }));

    render(<LogStream />);
    const pauseBtn = screen.getByText('Pause');
    pauseBtn.click();
    expect(mockTogglePause).toHaveBeenCalledTimes(1);
  });

  it('should show Resume when paused', () => {
    mockUseAdminLogStream.mockReturnValue(defaultHookReturn({
      paused: true,
    }));

    render(<LogStream />);
    expect(screen.getByText('Resume')).toBeInTheDocument();
  });

  it('should have Clear button', () => {
    const mockClear = vi.fn();
    mockUseAdminLogStream.mockReturnValue(defaultHookReturn({
      entries: [createMockEntry()],
      clear: mockClear,
    }));

    render(<LogStream />);
    const clearBtn = screen.getByText('Clear');
    clearBtn.click();
    expect(mockClear).toHaveBeenCalledTimes(1);
  });

  it('should show entry count', () => {
    mockUseAdminLogStream.mockReturnValue(defaultHookReturn({
      entries: [createMockEntry(), createMockEntry()],
    }));

    render(<LogStream />);
    expect(screen.getByText('2 entries')).toBeInTheDocument();
  });

  it('should have level filter buttons', () => {
    mockUseAdminLogStream.mockReturnValue(defaultHookReturn());

    render(<LogStream />);
    expect(screen.getByText('error')).toBeInTheDocument();
    expect(screen.getByText('warn')).toBeInTheDocument();
    expect(screen.getByText('info')).toBeInTheDocument();
  });

  it('should toggle level filter on click', () => {
    const mockSetLevels = vi.fn();
    mockUseAdminLogStream.mockReturnValue(defaultHookReturn({
      setLevels: mockSetLevels,
    }));

    render(<LogStream />);
    fireEvent.click(screen.getByText('error'));
    expect(mockSetLevels).toHaveBeenCalledWith(['error']);
  });

  it('should have search input', () => {
    mockUseAdminLogStream.mockReturnValue(defaultHookReturn());

    render(<LogStream />);
    expect(screen.getByLabelText('Search stream')).toBeInTheDocument();
  });

  it('should show client count when connected', () => {
    mockUseAdminLogStream.mockReturnValue(defaultHookReturn({
      state: 'connected',
      clientCount: 3,
    }));

    render(<LogStream />);
    expect(screen.getByText('(3 clients)')).toBeInTheDocument();
  });

  it('should show singular client label', () => {
    mockUseAdminLogStream.mockReturnValue(defaultHookReturn({
      state: 'connected',
      clientCount: 1,
    }));

    render(<LogStream />);
    expect(screen.getByText('(1 client)')).toBeInTheDocument();
  });
});
