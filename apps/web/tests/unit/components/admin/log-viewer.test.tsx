import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LogViewer } from '../../../../src/components/admin/LogViewer';
import type { AdminLogEntry } from '@simple-agent-manager/shared';

// Mock the useAdminLogQuery hook
const mockUseAdminLogQuery = vi.fn();
vi.mock('../../../../src/hooks/useAdminLogQuery', () => ({
  useAdminLogQuery: () => mockUseAdminLogQuery(),
}));

// Mock the UI library components
vi.mock('@simple-agent-manager/ui', () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div data-testid="card">{children}</div>,
  Spinner: ({ size }: { size: string }) => <div data-testid={`spinner-${size}`}>Loading...</div>,
  Button: ({ children, onClick, disabled }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) => (
    <button onClick={onClick} disabled={disabled}>{children}</button>
  ),
  Body: ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) => (
    <p style={style}>{children}</p>
  ),
}));

function createMockLog(overrides: Partial<AdminLogEntry> = {}): AdminLogEntry {
  return {
    timestamp: '2026-02-14T12:00:00.000Z',
    level: 'info',
    event: 'http.request',
    message: 'GET /api/health',
    details: {},
    ...overrides,
  };
}

function defaultHookReturn(overrides: Partial<ReturnType<typeof mockUseAdminLogQuery>> = {}) {
  return {
    logs: [],
    loading: false,
    error: null,
    hasMore: false,
    filter: { levels: [], search: '', timeRange: '1h' },
    setLevels: vi.fn(),
    setSearch: vi.fn(),
    setTimeRange: vi.fn(),
    loadMore: vi.fn(),
    refresh: vi.fn(),
    ...overrides,
  };
}

describe('LogViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should show loading spinner when loading with no logs', () => {
    mockUseAdminLogQuery.mockReturnValue(defaultHookReturn({ loading: true }));

    render(<LogViewer />);
    expect(screen.getByTestId('spinner-lg')).toBeInTheDocument();
  });

  it('should show empty state when no logs found', () => {
    mockUseAdminLogQuery.mockReturnValue(defaultHookReturn());

    render(<LogViewer />);
    expect(screen.getByText(/no logs found/i)).toBeInTheDocument();
  });

  it('should render log entries', () => {
    mockUseAdminLogQuery.mockReturnValue(defaultHookReturn({
      logs: [
        createMockLog({ message: 'Request to /api/health', level: 'info' }),
        createMockLog({ message: 'Database error', level: 'error' }),
      ],
    }));

    render(<LogViewer />);
    expect(screen.getByText('Request to /api/health')).toBeInTheDocument();
    expect(screen.getByText('Database error')).toBeInTheDocument();
  });

  it('should show error banner with Retry button', () => {
    const mockRefresh = vi.fn();
    mockUseAdminLogQuery.mockReturnValue(defaultHookReturn({
      error: 'Cloudflare API unavailable',
      refresh: mockRefresh,
    }));

    render(<LogViewer />);
    expect(screen.getByText('Cloudflare API unavailable')).toBeInTheDocument();

    const retryBtn = screen.getByText('Retry');
    retryBtn.click();
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('should show Load More button when hasMore is true', () => {
    const mockLoadMore = vi.fn();
    mockUseAdminLogQuery.mockReturnValue(defaultHookReturn({
      logs: [createMockLog()],
      hasMore: true,
      loadMore: mockLoadMore,
    }));

    render(<LogViewer />);
    const loadMoreBtn = screen.getByText('Load More');
    loadMoreBtn.click();
    expect(mockLoadMore).toHaveBeenCalledTimes(1);
  });

  it('should have filter controls', () => {
    mockUseAdminLogQuery.mockReturnValue(defaultHookReturn());

    render(<LogViewer />);
    // Time range selector
    expect(screen.getByLabelText('Time range')).toBeInTheDocument();
    // Search input
    expect(screen.getByLabelText('Search logs')).toBeInTheDocument();
    // Level toggle buttons
    expect(screen.getByText('Error')).toBeInTheDocument();
    expect(screen.getByText('Warn')).toBeInTheDocument();
    expect(screen.getByText('Info')).toBeInTheDocument();
  });

  it('should have a Refresh button', () => {
    const mockRefresh = vi.fn();
    mockUseAdminLogQuery.mockReturnValue(defaultHookReturn({ refresh: mockRefresh }));

    render(<LogViewer />);
    const refreshBtn = screen.getByText('Refresh');
    refreshBtn.click();
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('should show loading state during pagination', () => {
    mockUseAdminLogQuery.mockReturnValue(defaultHookReturn({
      logs: [createMockLog()],
      loading: true,
    }));

    render(<LogViewer />);
    // Logs should still be visible
    expect(screen.getByText('GET /api/health')).toBeInTheDocument();
    // Small spinner for pagination
    expect(screen.getByTestId('spinner-sm')).toBeInTheDocument();
  });
});
