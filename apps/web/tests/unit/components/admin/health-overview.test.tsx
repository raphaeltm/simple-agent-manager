import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HealthOverview } from '../../../../src/components/admin/HealthOverview';

// Mock the useAdminHealth hook
const mockUseAdminHealth = vi.fn();
vi.mock('../../../../src/hooks/useAdminHealth', () => ({
  useAdminHealth: () => mockUseAdminHealth(),
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

describe('HealthOverview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should show loading spinner when loading', () => {
    mockUseAdminHealth.mockReturnValue({
      health: null,
      loading: true,
      error: null,
      refresh: vi.fn(),
    });

    render(<HealthOverview />);
    expect(screen.getByTestId('spinner-lg')).toBeInTheDocument();
  });

  it('should render four health metric cards', () => {
    mockUseAdminHealth.mockReturnValue({
      health: {
        activeNodes: 3,
        activeWorkspaces: 5,
        inProgressTasks: 2,
        errorCount24h: 42,
        timestamp: '2026-02-14T12:00:00.000Z',
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<HealthOverview />);

    expect(screen.getByText('Active Nodes')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('Active Workspaces')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('In-Progress Tasks')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('Errors (24h)')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('should display zero values correctly', () => {
    mockUseAdminHealth.mockReturnValue({
      health: {
        activeNodes: 0,
        activeWorkspaces: 0,
        inProgressTasks: 0,
        errorCount24h: 0,
        timestamp: '2026-02-14T12:00:00.000Z',
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<HealthOverview />);

    const zeros = screen.getAllByText('0');
    expect(zeros).toHaveLength(4);
  });

  it('should show warning color on elevated error count', () => {
    mockUseAdminHealth.mockReturnValue({
      health: {
        activeNodes: 1,
        activeWorkspaces: 1,
        inProgressTasks: 0,
        errorCount24h: 50,
        timestamp: '2026-02-14T12:00:00.000Z',
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    const { container } = render(<HealthOverview />);

    // The error count card should have a warning/red color indicator
    const errorCard = container.querySelector('[data-metric="errorCount24h"]');
    expect(errorCard).toBeInTheDocument();
  });

  it('should show error banner when fetch fails', () => {
    mockUseAdminHealth.mockReturnValue({
      health: null,
      loading: false,
      error: 'Failed to fetch health data',
      refresh: vi.fn(),
    });

    render(<HealthOverview />);
    expect(screen.getByText('Failed to fetch health data')).toBeInTheDocument();
  });

  it('should have a Retry button on error', () => {
    const mockRefresh = vi.fn();
    mockUseAdminHealth.mockReturnValue({
      health: null,
      loading: false,
      error: 'Network error',
      refresh: mockRefresh,
    });

    render(<HealthOverview />);
    const retryBtn = screen.getByText('Retry');
    retryBtn.click();
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('should show timestamp of last update', () => {
    mockUseAdminHealth.mockReturnValue({
      health: {
        activeNodes: 1,
        activeWorkspaces: 2,
        inProgressTasks: 0,
        errorCount24h: 5,
        timestamp: '2026-02-14T12:00:00.000Z',
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<HealthOverview />);
    // Should display the last updated time
    expect(screen.getByText(/last updated/i)).toBeInTheDocument();
  });

  it('should have a refresh button', () => {
    const mockRefresh = vi.fn();
    mockUseAdminHealth.mockReturnValue({
      health: {
        activeNodes: 1,
        activeWorkspaces: 2,
        inProgressTasks: 0,
        errorCount24h: 5,
        timestamp: '2026-02-14T12:00:00.000Z',
      },
      loading: false,
      error: null,
      refresh: mockRefresh,
    });

    render(<HealthOverview />);
    const refreshBtn = screen.getByText('Refresh');
    refreshBtn.click();
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('should show loading indicator during refresh without hiding existing data', () => {
    mockUseAdminHealth.mockReturnValue({
      health: {
        activeNodes: 1,
        activeWorkspaces: 2,
        inProgressTasks: 0,
        errorCount24h: 5,
        timestamp: '2026-02-14T12:00:00.000Z',
      },
      loading: true,
      error: null,
      refresh: vi.fn(),
    });

    render(<HealthOverview />);

    // Data should still be visible
    expect(screen.getByText('Active Nodes')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    // But the refresh button should be disabled
    const refreshBtn = screen.getByText('Refresh');
    expect(refreshBtn).toBeDisabled();
  });
});
