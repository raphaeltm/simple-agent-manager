import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * Default buffer before token expiry to trigger refresh (5 minutes).
 * Override via the `refreshBufferMs` option.
 */
const DEFAULT_REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * Minimum delay between refresh attempts (1 second).
 * Prevents infinite loop when token expires immediately.
 */
const MIN_REFRESH_DELAY_MS = 1_000;

interface UseTokenRefreshOptions {
  /** Async function that fetches a new token. Returns token string and ISO expiry. */
  fetchToken: () => Promise<{ token: string; expiresAt: string }>;
  /** Whether the hook should be active (e.g., workspace is running). */
  enabled: boolean;
  /** Buffer time before expiry to trigger refresh (default: 5 minutes). */
  refreshBufferMs?: number;
}

interface UseTokenRefreshResult {
  /** Current valid token, or null if not yet fetched. */
  token: string | null;
  /** Whether the initial token fetch is in progress. */
  loading: boolean;
  /** Error from the most recent fetch attempt, if any. */
  error: string | null;
  /** Manually trigger a token refresh (e.g., after a 401). */
  refresh: () => Promise<void>;
}

/**
 * Hook that fetches a token and proactively refreshes it before expiry.
 *
 * Addresses R3: WebSocket token expiry without refresh. The terminal/ACP
 * token is fetched once and then a timer is set to refresh it before the
 * `expiresAt` timestamp minus a configurable buffer (default 5 minutes).
 *
 * On 401 errors during reconnection, callers can invoke `refresh()` manually
 * to get a fresh token immediately.
 */
export function useTokenRefresh(options: UseTokenRefreshOptions): UseTokenRefreshResult {
  const { fetchToken, enabled, refreshBufferMs = DEFAULT_REFRESH_BUFFER_MS } = options;

  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const fetchingRef = useRef(false);
  const fetchTokenRef = useRef(fetchToken);
  fetchTokenRef.current = fetchToken;

  const clearRefreshTimer = useCallback(() => {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, []);

  // doFetch is defined as a stable ref-based function to break the circular
  // dependency between doFetch and scheduleRefresh.
  const doFetchRef = useRef<() => Promise<void>>();

  const scheduleRefresh = useCallback(
    (expiresAt: string) => {
      clearRefreshTimer();

      const expiryMs = new Date(expiresAt).getTime();
      const now = Date.now();
      const refreshAt = expiryMs - refreshBufferMs;
      // Enforce a minimum delay to prevent tight re-fetch loops
      const delay = Math.max(refreshAt - now, MIN_REFRESH_DELAY_MS);

      refreshTimerRef.current = setTimeout(() => {
        if (mountedRef.current) {
          void doFetchRef.current?.();
        }
      }, delay);
    },
    [refreshBufferMs, clearRefreshTimer]
  );

  const doFetch = useCallback(async () => {
    // Guard against re-entrant fetches
    if (fetchingRef.current) return;
    fetchingRef.current = true;

    try {
      setLoading((prev) => (token === null ? true : prev)); // Only show loading on initial
      setError(null);

      const result = await fetchTokenRef.current();
      if (!mountedRef.current) return;

      setToken(result.token);
      scheduleRefresh(result.expiresAt);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : 'Token fetch failed');
    } finally {
      fetchingRef.current = false;
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [scheduleRefresh, token]);

  // Keep the ref in sync so scheduleRefresh can call the latest doFetch
  doFetchRef.current = doFetch;

  // Initial fetch and cleanup
  useEffect(() => {
    mountedRef.current = true;

    if (!enabled) {
      setToken(null);
      setError(null);
      setLoading(false);
      clearRefreshTimer();
      return;
    }

    void doFetchRef.current?.();

    return () => {
      mountedRef.current = false;
      clearRefreshTimer();
    };
  }, [enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // Manual refresh for 401 recovery
  const refresh = useCallback(async () => {
    // Reset the fetching guard so manual refresh always works
    fetchingRef.current = false;
    await doFetch();
  }, [doFetch]);

  return { token, loading, error, refresh };
}
