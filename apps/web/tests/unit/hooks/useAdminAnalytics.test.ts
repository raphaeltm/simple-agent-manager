import { act, renderHook as baseRenderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAdminAnalytics } from '../../../src/hooks/useAdminAnalytics';
import { QueryTestWrapper } from '../../test-utils/query-test-utils';

// ---------------------------------------------------------------------------
// Mock the analytics API functions the hook fetches
// ---------------------------------------------------------------------------
const mockFetchDau = vi.fn();
const mockFetchEvents = vi.fn();
const mockFetchFeatureAdoption = vi.fn();
const mockFetchForwardStatus = vi.fn();
const mockFetchWebsiteTraffic = vi.fn();

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  fetchAnalyticsAiUsage: vi.fn().mockResolvedValue(null),
  fetchAnalyticsDau: (...args: unknown[]) => mockFetchDau(...args),
  fetchAnalyticsEvents: (...args: unknown[]) => mockFetchEvents(...args),
  fetchAnalyticsFeatureAdoption: (...args: unknown[]) => mockFetchFeatureAdoption(...args),
  fetchAnalyticsForwardStatus: (...args: unknown[]) => mockFetchForwardStatus(...args),
  fetchAnalyticsWebsiteTraffic: (...args: unknown[]) => mockFetchWebsiteTraffic(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const DAU_FIXTURE = { dau: [{ date: '2026-03-27', unique_users: 5 }], periodDays: 30 };
const EVENTS_FIXTURE = {
  events: [{ event_name: 'task_submitted', count: 10, unique_users: 5, avg_response_ms: 0 }],
  period: '7d',
};
const ADOPTION_FIXTURE = {
  totals: [{ event_name: 'task_submitted', count: 42, unique_users: 10 }],
  trend: [],
  period: '30d',
};
const FORWARD_STATUS_FIXTURE = {
  enabled: false,
  lastForwardedAt: null,
  destinations: { segment: { configured: false }, ga4: { configured: false } },
  events: ['signup', 'login'],
};
const WEBSITE_TRAFFIC_FIXTURE = {
  hosts: [
    {
      host: 'www.example.com',
      totalViews: 100,
      uniqueVisitors: 50,
      uniqueSessions: 60,
      sections: [],
    },
  ],
  trend: [],
  period: '7d',
};

function setupSuccessMocks() {
  mockFetchDau.mockResolvedValue(DAU_FIXTURE);
  mockFetchEvents.mockResolvedValue(EVENTS_FIXTURE);
  mockFetchFeatureAdoption.mockResolvedValue(ADOPTION_FIXTURE);
  mockFetchForwardStatus.mockResolvedValue(FORWARD_STATUS_FIXTURE);
  mockFetchWebsiteTraffic.mockResolvedValue(WEBSITE_TRAFFIC_FIXTURE);
}

describe('useAdminAnalytics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Initial state
  // -------------------------------------------------------------------------

  it('starts in loading state with all data null', () => {
    setupSuccessMocks();
    const { result } = renderHook(() => useAdminAnalytics(0));

    expect(result.current.loading).toBe(true);
    expect(result.current.dau).toBeNull();
    expect(result.current.events).toBeNull();
    expect(result.current.featureAdoption).toBeNull();
    expect(result.current.websiteTraffic).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('defaults eventPeriod to 7d', () => {
    setupSuccessMocks();
    const { result } = renderHook(() => useAdminAnalytics(0));
    expect(result.current.eventPeriod).toBe('7d');
  });

  // -------------------------------------------------------------------------
  // Successful fetch
  // -------------------------------------------------------------------------

  it('fetches every kept data source on mount and populates state', async () => {
    setupSuccessMocks();
    const { result } = renderHook(() => useAdminAnalytics(0));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.dau).toEqual(DAU_FIXTURE);
    expect(result.current.events).toEqual(EVENTS_FIXTURE);
    expect(result.current.featureAdoption).toEqual(ADOPTION_FIXTURE);
    expect(result.current.forwardStatus).toEqual(FORWARD_STATUS_FIXTURE);
    expect(result.current.websiteTraffic).toEqual(WEBSITE_TRAFFIC_FIXTURE);
    expect(result.current.error).toBeNull();
  });

  it('passes the current eventPeriod to fetchAnalyticsWebsiteTraffic', async () => {
    setupSuccessMocks();
    const { result } = renderHook(() => useAdminAnalytics(0));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockFetchWebsiteTraffic).toHaveBeenCalledWith('7d', expect.any(AbortSignal));
  });

  it('passes the current eventPeriod to fetchAnalyticsEvents', async () => {
    setupSuccessMocks();
    const { result } = renderHook(() => useAdminAnalytics(0));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockFetchEvents).toHaveBeenCalledWith('7d', expect.any(AbortSignal));
  });

  it('passes the current eventPeriod to fetchAnalyticsFeatureAdoption', async () => {
    setupSuccessMocks();
    const { result } = renderHook(() => useAdminAnalytics(0));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockFetchFeatureAdoption).toHaveBeenCalledWith('7d', expect.any(AbortSignal));
  });

  it('forwards cancellation to fetchAnalyticsDau', async () => {
    setupSuccessMocks();
    const { result } = renderHook(() => useAdminAnalytics(0));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockFetchDau).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  it('sets error state when any fetch rejects', async () => {
    mockFetchDau.mockResolvedValue(DAU_FIXTURE);
    mockFetchEvents.mockResolvedValue(EVENTS_FIXTURE);
    mockFetchFeatureAdoption.mockRejectedValue(new Error('feature-adoption failed'));
    mockFetchForwardStatus.mockResolvedValue(FORWARD_STATUS_FIXTURE);
    mockFetchWebsiteTraffic.mockResolvedValue(WEBSITE_TRAFFIC_FIXTURE);

    const { result } = renderHook(() => useAdminAnalytics(0));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe('feature-adoption failed');
  });

  it('sets a generic error message when rejection is not an Error instance', async () => {
    mockFetchDau.mockRejectedValue('string error');
    mockFetchEvents.mockResolvedValue(EVENTS_FIXTURE);
    mockFetchFeatureAdoption.mockResolvedValue(ADOPTION_FIXTURE);
    mockFetchForwardStatus.mockResolvedValue(FORWARD_STATUS_FIXTURE);
    mockFetchWebsiteTraffic.mockResolvedValue(WEBSITE_TRAFFIC_FIXTURE);

    const { result } = renderHook(() => useAdminAnalytics(0));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe('Failed to load analytics data');
  });

  it('clears previous error on successful retry', async () => {
    mockFetchDau.mockRejectedValueOnce(new Error('network error'));
    mockFetchEvents.mockResolvedValue(EVENTS_FIXTURE);
    mockFetchFeatureAdoption.mockResolvedValue(ADOPTION_FIXTURE);
    mockFetchForwardStatus.mockResolvedValue(FORWARD_STATUS_FIXTURE);
    mockFetchWebsiteTraffic.mockResolvedValue(WEBSITE_TRAFFIC_FIXTURE);

    const { result } = renderHook(() => useAdminAnalytics(0));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('network error');

    // Now make it succeed
    mockFetchDau.mockResolvedValue(DAU_FIXTURE);

    act(() => {
      result.current.refresh();
    });

    await waitFor(() => {
      expect(result.current.error).toBeNull();
      expect(result.current.dau).toEqual(DAU_FIXTURE);
    });
  });

  // -------------------------------------------------------------------------
  // Period switching
  // -------------------------------------------------------------------------

  it('re-fetches with new period when setEventPeriod is called', async () => {
    setupSuccessMocks();
    const { result } = renderHook(() => useAdminAnalytics(0));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockFetchEvents).toHaveBeenCalledTimes(1);
    expect(mockFetchEvents).toHaveBeenLastCalledWith('7d', expect.any(AbortSignal));

    act(() => {
      result.current.setEventPeriod('30d');
    });

    await waitFor(() => expect(mockFetchEvents).toHaveBeenCalledTimes(2));
    expect(mockFetchEvents).toHaveBeenLastCalledWith('30d', expect.any(AbortSignal));
  });

  it('passes updated period to feature adoption and website traffic after period change', async () => {
    setupSuccessMocks();
    const { result } = renderHook(() => useAdminAnalytics(0));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.setEventPeriod('90d');
    });

    await waitFor(() =>
      expect(mockFetchFeatureAdoption).toHaveBeenLastCalledWith('90d', expect.any(AbortSignal))
    );
    expect(mockFetchWebsiteTraffic).toHaveBeenLastCalledWith('90d', expect.any(AbortSignal));
  });

  it('updates eventPeriod state immediately', () => {
    setupSuccessMocks();
    const { result } = renderHook(() => useAdminAnalytics(0));

    act(() => {
      result.current.setEventPeriod('24h');
    });

    expect(result.current.eventPeriod).toBe('24h');
  });

  // -------------------------------------------------------------------------
  // Refresh
  // -------------------------------------------------------------------------

  it('sets isRefreshing to true on subsequent fetches (after initial load)', async () => {
    setupSuccessMocks();
    const { result } = renderHook(() => useAdminAnalytics(0));
    await waitFor(() => expect(result.current.loading).toBe(false));

    // After initial load, refresh should use isRefreshing not loading
    let resolveTraffic!: (v: typeof WEBSITE_TRAFFIC_FIXTURE) => void;
    mockFetchWebsiteTraffic.mockReturnValue(
      new Promise((res) => {
        resolveTraffic = res;
      })
    );

    act(() => {
      result.current.refresh();
    });

    await waitFor(() => expect(result.current.isRefreshing).toBe(true));
    expect(result.current.loading).toBe(false); // loading should NOT be set again

    act(() => {
      resolveTraffic(WEBSITE_TRAFFIC_FIXTURE);
    });

    await waitFor(() => expect(result.current.isRefreshing).toBe(false));
  });

  it('refresh calls every fetcher again', async () => {
    setupSuccessMocks();
    const { result } = renderHook(() => useAdminAnalytics(0));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.refresh();
    });

    await waitFor(() => expect(mockFetchDau).toHaveBeenCalledTimes(2));
    expect(mockFetchEvents).toHaveBeenCalledTimes(2);
    expect(mockFetchFeatureAdoption).toHaveBeenCalledTimes(2);
    expect(mockFetchForwardStatus).toHaveBeenCalledTimes(2);
    expect(mockFetchWebsiteTraffic).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Auto-refresh interval
  // -------------------------------------------------------------------------

  it('does not set up an interval when refreshIntervalMs is 0', async () => {
    setupSuccessMocks();
    // Use shouldAdvanceTime so that waitFor's internal setTimeout still fires
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const { result } = renderHook(() => useAdminAnalytics(0));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const callCountAfterMount = mockFetchDau.mock.calls.length;

    act(() => {
      vi.advanceTimersByTime(120_000);
    }); // advance 2 minutes

    expect(mockFetchDau.mock.calls.length).toBe(callCountAfterMount); // no extra calls

    vi.useRealTimers();
  });

  it('triggers auto-refresh after the specified interval', async () => {
    setupSuccessMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const { result } = renderHook(() => useAdminAnalytics(5_000));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const callsAfterMount = mockFetchDau.mock.calls.length;

    act(() => {
      vi.advanceTimersByTime(5_100);
    });

    await waitFor(() => expect(mockFetchDau.mock.calls.length).toBeGreaterThan(callsAfterMount));

    vi.useRealTimers();
  });
});

vi.mock('../../../src/hooks/useQueryScope', () => ({ useQueryScope: () => 'admin-1' }));
function renderHook<T>(callback: () => T) {
  return baseRenderHook(callback, { wrapper: QueryTestWrapper });
}

it('reveals a fast analytics panel while another source is still pending', async () => {
  setupSuccessMocks();
  let resolveDau!: (value: typeof DAU_FIXTURE) => void;
  mockFetchDau.mockReturnValue(
    new Promise((resolve) => {
      resolveDau = resolve;
    })
  );
  const { result } = renderHook(() => useAdminAnalytics(0));
  await waitFor(() => expect(result.current.events).toEqual(EVENTS_FIXTURE));
  expect(result.current.loading).toBe(false);
  expect(result.current.dau).toBeNull();
  await act(async () => resolveDau(DAU_FIXTURE));
  await waitFor(() => expect(result.current.dau).toEqual(DAU_FIXTURE));
});
