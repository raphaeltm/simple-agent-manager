import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTokenRefresh } from '../../../src/hooks/useTokenRefresh';

describe('useTokenRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should fetch token on mount when enabled', async () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const fetchToken = vi.fn().mockResolvedValue({ token: 'tok-123', expiresAt });

    const { result } = renderHook(() =>
      useTokenRefresh({ fetchToken, enabled: true })
    );

    // Let the microtask (Promise resolution) flush
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchToken).toHaveBeenCalledTimes(1);
    expect(result.current.token).toBe('tok-123');
    expect(result.current.error).toBe(null);
  });

  it('should not fetch when disabled', async () => {
    const fetchToken = vi.fn().mockResolvedValue({
      token: 'tok',
      expiresAt: new Date().toISOString(),
    });

    const { result } = renderHook(() =>
      useTokenRefresh({ fetchToken, enabled: false })
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.token).toBe(null);
    expect(result.current.loading).toBe(false);
    expect(fetchToken).not.toHaveBeenCalled();
  });

  it('should set error on fetch failure', async () => {
    const fetchToken = vi.fn().mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() =>
      useTokenRefresh({ fetchToken, enabled: true })
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.error).toBe('Network error');
    expect(result.current.token).toBe(null);
  });

  it('should schedule refresh before expiry', async () => {
    const now = Date.now();
    // Token expires in 10 minutes, buffer is 5 minutes => refresh in ~5 minutes
    const expiresAt = new Date(now + 10 * 60 * 1000).toISOString();
    const refreshedExpiresAt = new Date(now + 70 * 60 * 1000).toISOString();

    const fetchToken = vi
      .fn()
      .mockResolvedValueOnce({ token: 'tok-1', expiresAt })
      .mockResolvedValueOnce({ token: 'tok-2', expiresAt: refreshedExpiresAt });

    const { result } = renderHook(() =>
      useTokenRefresh({ fetchToken, enabled: true, refreshBufferMs: 5 * 60 * 1000 })
    );

    // Wait for initial fetch
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.token).toBe('tok-1');
    expect(fetchToken).toHaveBeenCalledTimes(1);

    // Advance to just past the refresh point (~5 minutes from initial fetch)
    await act(async () => {
      vi.advanceTimersByTime(5 * 60 * 1000 + 500);
    });

    // The timer fires and starts the async fetch; flush microtask queue
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchToken).toHaveBeenCalledTimes(2);
    expect(result.current.token).toBe('tok-2');
  });

  it('should support manual refresh', async () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const fetchToken = vi
      .fn()
      .mockResolvedValueOnce({ token: 'tok-1', expiresAt })
      .mockResolvedValueOnce({ token: 'tok-refreshed', expiresAt });

    const { result } = renderHook(() =>
      useTokenRefresh({ fetchToken, enabled: true })
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.token).toBe('tok-1');

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.token).toBe('tok-refreshed');
    expect(fetchToken).toHaveBeenCalledTimes(2);
  });

  it('should enforce minimum delay for nearly-expired tokens', async () => {
    const now = Date.now();
    // Token expires in 1 second (well within the 5-min buffer), so delay would be negative
    // The hook enforces MIN_REFRESH_DELAY_MS = 1000ms
    const expiresAt = new Date(now + 1000).toISOString();
    const laterExpiry = new Date(now + 60 * 60 * 1000).toISOString();

    const fetchToken = vi
      .fn()
      .mockResolvedValueOnce({ token: 'tok-short', expiresAt })
      .mockResolvedValueOnce({ token: 'tok-long', expiresAt: laterExpiry });

    const { result } = renderHook(() =>
      useTokenRefresh({ fetchToken, enabled: true })
    );

    // Wait for initial fetch
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.token).toBe('tok-short');
    expect(fetchToken).toHaveBeenCalledTimes(1);

    // Advance past the minimum delay (1 second)
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchToken).toHaveBeenCalledTimes(2);
    expect(result.current.token).toBe('tok-long');
  });

  it('should clean up timer on unmount', async () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const fetchToken = vi.fn().mockResolvedValue({ token: 'tok', expiresAt });

    const { unmount } = renderHook(() =>
      useTokenRefresh({ fetchToken, enabled: true })
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchToken).toHaveBeenCalledTimes(1);

    unmount();

    // Advance time — no additional fetch should happen since we unmounted
    await act(async () => {
      vi.advanceTimersByTime(60 * 60 * 1000);
    });

    expect(fetchToken).toHaveBeenCalledTimes(1);
  });
});
