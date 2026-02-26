import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ErrorList } from '../../../../src/components/admin/ErrorList';
import type { PlatformError } from '@simple-agent-manager/shared';

// Mock the useAdminErrors hook
const mockUseAdminErrors = vi.fn();
vi.mock('../../../../src/hooks/useAdminErrors', () => ({
  useAdminErrors: () => mockUseAdminErrors(),
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

function createMockEntry(overrides: Partial<PlatformError> = {}): PlatformError {
  return {
    id: `err-${Math.random().toString(36).slice(2)}`,
    source: 'client',
    level: 'error',
    message: 'Test error',
    stack: null,
    context: null,
    userId: null,
    nodeId: null,
    workspaceId: null,
    ipAddress: null,
    userAgent: null,
    timestamp: '2026-02-14T12:00:00.000Z',
    ...overrides,
  };
}

function defaultHookReturn(overrides: Record<string, unknown> = {}) {
  return {
    errors: [] as PlatformError[],
    loading: false,
    error: null,
    hasMore: false,
    total: 0,
    filter: { source: 'all' as const, level: 'all' as const, search: '', timeRange: '24h' as const },
    setSource: vi.fn(),
    setLevel: vi.fn(),
    setSearch: vi.fn(),
    setTimeRange: vi.fn(),
    loadMore: vi.fn(),
    refresh: vi.fn(),
    ...overrides,
  };
}

describe('ErrorList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should show loading spinner when loading with no errors', () => {
    mockUseAdminErrors.mockReturnValue(defaultHookReturn({ loading: true }));
    render(<ErrorList />);
    expect(screen.getByTestId('spinner-lg')).toBeInTheDocument();
  });

  it('should show empty state when no errors match filters', () => {
    mockUseAdminErrors.mockReturnValue(defaultHookReturn());
    render(<ErrorList />);
    expect(screen.getByText(/No errors match/)).toBeInTheDocument();
  });

  it('should render error entries', () => {
    const errors = [
      createMockEntry({ message: 'Error A' }),
      createMockEntry({ message: 'Error B' }),
    ];
    mockUseAdminErrors.mockReturnValue(defaultHookReturn({ errors, total: 2 }));
    render(<ErrorList />);

    expect(screen.getByText('Error A')).toBeInTheDocument();
    expect(screen.getByText('Error B')).toBeInTheDocument();
  });

  it('should show summary count', () => {
    const errors = [createMockEntry()];
    mockUseAdminErrors.mockReturnValue(defaultHookReturn({ errors, total: 5 }));
    render(<ErrorList />);

    expect(screen.getByText(/Showing 1 of 5 errors/)).toBeInTheDocument();
  });

  it('should show Load More button when hasMore is true', () => {
    const errors = [createMockEntry()];
    mockUseAdminErrors.mockReturnValue(defaultHookReturn({ errors, total: 10, hasMore: true }));
    render(<ErrorList />);

    expect(screen.getByText('Load More')).toBeInTheDocument();
  });

  it('should not show Load More button when hasMore is false', () => {
    const errors = [createMockEntry()];
    mockUseAdminErrors.mockReturnValue(defaultHookReturn({ errors, total: 1, hasMore: false }));
    render(<ErrorList />);

    expect(screen.queryByText('Load More')).not.toBeInTheDocument();
  });

  it('should show error banner with retry button', () => {
    const refresh = vi.fn();
    mockUseAdminErrors.mockReturnValue(defaultHookReturn({ error: 'Network error', refresh }));
    render(<ErrorList />);

    expect(screen.getByText('Network error')).toBeInTheDocument();
    expect(screen.getByText('Retry')).toBeInTheDocument();
  });

  it('should show filter controls', () => {
    mockUseAdminErrors.mockReturnValue(defaultHookReturn());
    render(<ErrorList />);

    // Filter dropdowns should be present (rendered by ObservabilityFilters)
    expect(screen.getByLabelText('Filter by source')).toBeInTheDocument();
    expect(screen.getByLabelText('Filter by level')).toBeInTheDocument();
    expect(screen.getByLabelText('Filter by time range')).toBeInTheDocument();
    expect(screen.getByLabelText('Search error messages')).toBeInTheDocument();
  });

  it('should show refresh button', () => {
    mockUseAdminErrors.mockReturnValue(defaultHookReturn());
    render(<ErrorList />);

    // "Refresh" button in the summary bar
    expect(screen.getByText('Refresh')).toBeInTheDocument();
  });
});
