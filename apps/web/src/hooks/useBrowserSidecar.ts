import { useState, useCallback, useRef, useEffect } from 'react';
import {
  startBrowserSidecar,
  stopBrowserSidecar,
  getBrowserSidecarStatus,
  startWorkspaceBrowserSidecar,
  stopWorkspaceBrowserSidecar,
  getWorkspaceBrowserSidecarStatus,
  type BrowserSidecarStatusResponse,
} from '../lib/api';

interface UseBrowserSidecarSessionOptions {
  projectId: string;
  sessionId: string;
  workspaceId?: never;
  /** Poll interval in ms when sidecar is running (default: 10000). */
  pollInterval?: number;
}

interface UseBrowserSidecarWorkspaceOptions {
  workspaceId: string;
  projectId?: never;
  sessionId?: never;
  /** Poll interval in ms when sidecar is running (default: 10000). */
  pollInterval?: number;
}

type UseBrowserSidecarOptions =
  | UseBrowserSidecarSessionOptions
  | UseBrowserSidecarWorkspaceOptions;

interface UseBrowserSidecarResult {
  status: BrowserSidecarStatusResponse | null;
  isLoading: boolean;
  error: string | null;
  start: (opts?: {
    viewportWidth?: number;
    viewportHeight?: number;
    devicePixelRatio?: number;
    isTouchDevice?: boolean;
    enableAudio?: boolean;
  }) => Promise<void>;
  stop: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function useBrowserSidecar(
  options: UseBrowserSidecarOptions
): UseBrowserSidecarResult {
  const { pollInterval = 10_000 } = options;
  const [status, setStatus] = useState<BrowserSidecarStatusResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hasStatusRef = useRef(false);

  // Track whether we've ever received a status (avoids stale closure on `status`)
  useEffect(() => {
    hasStatusRef.current = status !== null;
  }, [status]);

  // Determine which API flavor to use based on options
  const isWorkspaceMode = 'workspaceId' in options && !!options.workspaceId;

  const refresh = useCallback(async () => {
    try {
      const result = isWorkspaceMode
        ? await getWorkspaceBrowserSidecarStatus(options.workspaceId!)
        : await getBrowserSidecarStatus(options.projectId!, options.sessionId!);
      setStatus(result);
      setError(null);
    } catch (err) {
      // Don't clear status on poll errors — keep showing last known state
      if (!hasStatusRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to get browser status');
      }
    }
  }, [isWorkspaceMode, options]);

  const start = useCallback(
    async (opts?: {
      viewportWidth?: number;
      viewportHeight?: number;
      devicePixelRatio?: number;
      isTouchDevice?: boolean;
      enableAudio?: boolean;
    }) => {
      setIsLoading(true);
      setError(null);
      try {
        const result = isWorkspaceMode
          ? await startWorkspaceBrowserSidecar(options.workspaceId!, opts)
          : await startBrowserSidecar(options.projectId!, options.sessionId!, opts);
        setStatus(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to start browser');
      } finally {
        setIsLoading(false);
      }
    },
    [isWorkspaceMode, options]
  );

  const stop = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = isWorkspaceMode
        ? await stopWorkspaceBrowserSidecar(options.workspaceId!)
        : await stopBrowserSidecar(options.projectId!, options.sessionId!);
      setStatus(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop browser');
    } finally {
      setIsLoading(false);
    }
  }, [isWorkspaceMode, options]);

  // Poll for status when sidecar is running
  useEffect(() => {
    if (status?.status === 'running' || status?.status === 'starting') {
      pollRef.current = setInterval(refresh, pollInterval);
      return () => {
        if (pollRef.current) clearInterval(pollRef.current);
      };
    }
    // Stop polling when not running
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, [status?.status, pollInterval, refresh]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  return { status, isLoading, error, start, stop, refresh };
}
