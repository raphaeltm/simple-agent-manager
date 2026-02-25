import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAdminErrors } from '../../../src/hooks/useAdminErrors';

// Mock the API
const mockFetchAdminErrors = vi.fn();
vi.mock('../../../src/lib/api', () => ({
  fetchAdminErrors: (...args: unknown[]) => mockFetchAdminErrors(...args),
}));

describe('useAdminErrors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchAdminErrors.mockResolvedValue({
      errors: [],
      cursor: null,
      hasMore: false,
      total: 0,
    });
  });

  it('should start in loading state', () => {
    const { result } = renderHook(() => useAdminErrors());
    expect(result.current.loading).toBe(true);
  });

  it('should fetch errors on mount', async () => {
    const mockErrors = [
      { id: 'err-1', source: 'client', level: 'error', message: 'Test', stack: null, context: null, userId: null, nodeId: null, workspaceId: null, ipAddress: null, userAgent: null, timestamp: '2026-02-14T12:00:00.000Z' },
    ];
    mockFetchAdminErrors.mockResolvedValue({
      errors: mockErrors,
      cursor: null,
      hasMore: false,
      total: 1,
    });

    const { result } = renderHook(() => useAdminErrors());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.errors).toHaveLength(1);
    expect(result.current.total).toBe(1);
    expect(result.current.error).toBeNull();
  });

  it('should have default filter state', () => {
    const { result } = renderHook(() => useAdminErrors());
    expect(result.current.filter).toEqual({
      source: 'all',
      level: 'all',
      search: '',
      timeRange: '24h',
    });
  });

  it('should update source filter', async () => {
    const { result } = renderHook(() => useAdminErrors());

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.setSource('client');
    });

    expect(result.current.filter.source).toBe('client');
  });

  it('should update level filter', async () => {
    const { result } = renderHook(() => useAdminErrors());

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.setLevel('warn');
    });

    expect(result.current.filter.level).toBe('warn');
  });

  it('should update search filter', async () => {
    const { result } = renderHook(() => useAdminErrors());

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.setSearch('timeout');
    });

    expect(result.current.filter.search).toBe('timeout');
  });

  it('should update time range filter', async () => {
    const { result } = renderHook(() => useAdminErrors());

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.setTimeRange('7d');
    });

    expect(result.current.filter.timeRange).toBe('7d');
  });

  it('should handle API errors', async () => {
    mockFetchAdminErrors.mockRejectedValue(new Error('Network failure'));

    const { result } = renderHook(() => useAdminErrors());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('Network failure');
    expect(result.current.errors).toEqual([]);
  });

  it('should pass filter params to fetchAdminErrors', async () => {
    const { result } = renderHook(() => useAdminErrors());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockFetchAdminErrors).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 50,
      })
    );
  });

  it('should support pagination via loadMore', async () => {
    mockFetchAdminErrors.mockResolvedValueOnce({
      errors: [{ id: 'err-1', source: 'client', level: 'error', message: 'First', stack: null, context: null, userId: null, nodeId: null, workspaceId: null, ipAddress: null, userAgent: null, timestamp: '2026-02-14T12:00:00.000Z' }],
      cursor: 'cursor-1',
      hasMore: true,
      total: 2,
    });

    const { result } = renderHook(() => useAdminErrors());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.hasMore).toBe(true);
    expect(result.current.errors).toHaveLength(1);

    mockFetchAdminErrors.mockResolvedValueOnce({
      errors: [{ id: 'err-2', source: 'api', level: 'error', message: 'Second', stack: null, context: null, userId: null, nodeId: null, workspaceId: null, ipAddress: null, userAgent: null, timestamp: '2026-02-14T11:00:00.000Z' }],
      cursor: null,
      hasMore: false,
      total: 2,
    });

    act(() => {
      result.current.loadMore();
    });

    await waitFor(() => {
      expect(result.current.errors).toHaveLength(2);
    });

    expect(result.current.hasMore).toBe(false);
  });

  it('should reset cursor on filter change', async () => {
    mockFetchAdminErrors.mockResolvedValue({
      errors: [],
      cursor: null,
      hasMore: false,
      total: 0,
    });

    const { result } = renderHook(() => useAdminErrors());

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Change filter
    act(() => {
      result.current.setSource('api');
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Should have fetched without cursor
    const lastCall = mockFetchAdminErrors.mock.calls[mockFetchAdminErrors.mock.calls.length - 1];
    expect(lastCall[0].cursor).toBeUndefined();
  });

  it('should refresh by re-fetching without cursor', async () => {
    const { result } = renderHook(() => useAdminErrors());

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.refresh();
    });

    // Should have been called multiple times
    expect(mockFetchAdminErrors.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
