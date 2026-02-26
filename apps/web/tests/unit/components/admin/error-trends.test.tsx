import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ErrorTrends } from '../../../../src/components/admin/ErrorTrends';
import type { ErrorTrendResponse } from '@simple-agent-manager/shared';

// Mock the api module
const mockFetchAdminErrorTrends = vi.fn();
vi.mock('../../../../src/lib/api', () => ({
  fetchAdminErrorTrends: (...args: unknown[]) => mockFetchAdminErrorTrends(...args),
}));

// Mock UI library components
vi.mock('@simple-agent-manager/ui', () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div data-testid="card">{children}</div>,
  Spinner: ({ size }: { size: string }) => <div data-testid={`spinner-${size}`}>Loading...</div>,
  Button: ({
    children,
    onClick,
    disabled,
    variant,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    variant?: string;
  }) => (
    <button onClick={onClick} disabled={disabled} data-variant={variant}>
      {children}
    </button>
  ),
  Body: ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) => (
    <p style={style}>{children}</p>
  ),
}));

function createMockTrends(
  range = '24h',
  interval = '1h',
  bucketCount = 24,
  fillData = false
): ErrorTrendResponse {
  const now = Date.now();
  const intervalMs = range === '1h' ? 5 * 60 * 1000 : 60 * 60 * 1000;

  const buckets = Array.from({ length: bucketCount }, (_, i) => ({
    timestamp: new Date(now - (bucketCount - i) * intervalMs).toISOString(),
    total: fillData ? (i % 3 === 0 ? 5 : 0) : 0,
    bySource: {
      client: fillData && i % 3 === 0 ? 2 : 0,
      'vm-agent': fillData && i % 3 === 0 ? 1 : 0,
      api: fillData && i % 3 === 0 ? 2 : 0,
    },
  }));

  return { range, interval, buckets };
}

describe('ErrorTrends', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should show loading spinner initially', async () => {
    mockFetchAdminErrorTrends.mockReturnValue(new Promise(() => {})); // never resolves

    render(<ErrorTrends />);

    expect(screen.getByTestId('spinner-lg')).toBeInTheDocument();
  });

  it('should render the chart with bars when data loads', async () => {
    const trends = createMockTrends('24h', '1h', 24, true);
    mockFetchAdminErrorTrends.mockResolvedValue(trends);

    render(<ErrorTrends />);

    await waitFor(() => {
      expect(screen.getByTestId('trend-chart')).toBeInTheDocument();
    });

    const bars = screen.getAllByTestId('trend-bar');
    expect(bars).toHaveLength(24);
  });

  it('should show empty state when buckets are empty array', async () => {
    mockFetchAdminErrorTrends.mockResolvedValue({
      range: '24h',
      interval: '1h',
      buckets: [],
    });

    render(<ErrorTrends />);

    await waitFor(() => {
      expect(screen.getByText('No error data for this time range')).toBeInTheDocument();
    });
  });

  it('should render range selector buttons', async () => {
    mockFetchAdminErrorTrends.mockResolvedValue(createMockTrends());

    render(<ErrorTrends />);

    await waitFor(() => {
      expect(screen.getByText('1h')).toBeInTheDocument();
    });

    expect(screen.getByText('24h')).toBeInTheDocument();
    expect(screen.getByText('7d')).toBeInTheDocument();
    expect(screen.getByText('30d')).toBeInTheDocument();
  });

  it('should fetch with new range when range button is clicked', async () => {
    mockFetchAdminErrorTrends.mockResolvedValue(createMockTrends());

    render(<ErrorTrends />);

    await waitFor(() => {
      expect(mockFetchAdminErrorTrends).toHaveBeenCalledWith('24h');
    });

    // Click 7d button
    mockFetchAdminErrorTrends.mockResolvedValue(createMockTrends('7d', '1d', 7, true));
    fireEvent.click(screen.getByText('7d'));

    await waitFor(() => {
      expect(mockFetchAdminErrorTrends).toHaveBeenCalledWith('7d');
    });
  });

  it('should show error message when fetch fails', async () => {
    mockFetchAdminErrorTrends.mockRejectedValue(new Error('Network failure'));

    render(<ErrorTrends />);

    await waitFor(() => {
      expect(screen.getByText('Network failure')).toBeInTheDocument();
    });
  });

  it('should have a retry button on error', async () => {
    mockFetchAdminErrorTrends.mockRejectedValue(new Error('Server error'));

    render(<ErrorTrends />);

    await waitFor(() => {
      expect(screen.getByText('Retry')).toBeInTheDocument();
    });

    // Click retry
    mockFetchAdminErrorTrends.mockResolvedValue(createMockTrends());
    fireEvent.click(screen.getByText('Retry'));

    await waitFor(() => {
      expect(mockFetchAdminErrorTrends).toHaveBeenCalledTimes(2);
    });
  });

  it('should render source legend with correct labels', async () => {
    mockFetchAdminErrorTrends.mockResolvedValue(createMockTrends());

    render(<ErrorTrends />);

    await waitFor(() => {
      expect(screen.getByText('Client')).toBeInTheDocument();
    });

    expect(screen.getByText('VM Agent')).toBeInTheDocument();
    expect(screen.getByText('API')).toBeInTheDocument();
  });

  it('should render legend color swatches', async () => {
    mockFetchAdminErrorTrends.mockResolvedValue(createMockTrends());

    render(<ErrorTrends />);

    await waitFor(() => {
      expect(screen.getByTestId('legend-client')).toBeInTheDocument();
    });

    expect(screen.getByTestId('legend-vm-agent')).toBeInTheDocument();
    expect(screen.getByTestId('legend-api')).toBeInTheDocument();
  });

  it('should show "Error Trends" heading', async () => {
    mockFetchAdminErrorTrends.mockResolvedValue(createMockTrends());

    render(<ErrorTrends />);

    await waitFor(() => {
      expect(screen.getByText('Error Trends')).toBeInTheDocument();
    });
  });

  it('should highlight the active range button', async () => {
    mockFetchAdminErrorTrends.mockResolvedValue(createMockTrends());

    render(<ErrorTrends />);

    await waitFor(() => {
      const btn24h = screen.getByText('24h');
      expect(btn24h.getAttribute('data-variant')).toBe('primary');
    });

    // Other buttons should be ghost
    const btn1h = screen.getByText('1h');
    expect(btn1h.getAttribute('data-variant')).toBe('ghost');
  });

  it('should disable range buttons during loading', async () => {
    mockFetchAdminErrorTrends.mockReturnValue(new Promise(() => {})); // never resolves

    render(<ErrorTrends />);

    const btn1h = screen.getByText('1h');
    expect(btn1h).toBeDisabled();
  });

  it('should keep existing data visible while loading new range', async () => {
    const trends24h = createMockTrends('24h', '1h', 24, true);
    mockFetchAdminErrorTrends.mockResolvedValue(trends24h);

    render(<ErrorTrends />);

    await waitFor(() => {
      expect(screen.getByTestId('trend-chart')).toBeInTheDocument();
    });

    // Change range — keep the chart visible while loading
    mockFetchAdminErrorTrends.mockReturnValue(new Promise(() => {}));
    fireEvent.click(screen.getByText('7d'));

    // Chart should still be visible (old data)
    expect(screen.getByTestId('trend-chart')).toBeInTheDocument();
  });
});
