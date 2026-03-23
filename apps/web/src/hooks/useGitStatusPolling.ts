import { useState, useEffect, useCallback } from 'react';
import { getGitStatus } from '../lib/api';
import type { GitStatusData } from '../lib/api';

const GIT_STATUS_POLL_INTERVAL_MS = 30_000;
const GIT_STATUS_RETRY_DELAYS_MS = [750, 1500];

function countGitChanges(status: GitStatusData): number {
  return status.staged.length + status.unstaged.length + status.untracked.length;
}

interface UseGitStatusPollingOptions {
  workspaceUrl: string | undefined;
  workspaceId: string | undefined;
  terminalToken: string | null;
  isRunning: boolean;
  activeWorktree: string | null;
}

/**
 * Polls the VM Agent for git status and exposes change count + staleness.
 */
export function useGitStatusPolling({
  workspaceUrl,
  workspaceId,
  terminalToken,
  isRunning,
  activeWorktree,
}: UseGitStatusPollingOptions) {
  const [gitStatus, setGitStatus] = useState<GitStatusData | null>(null);
  const [gitChangeCount, setGitChangeCount] = useState(0);
  const [gitStatusStale, setGitStatusStale] = useState(false);

  const applyGitStatus = useCallback((status: GitStatusData) => {
    setGitStatus(status);
    setGitChangeCount(countGitChanges(status));
    setGitStatusStale(false);
  }, []);

  const markGitStatusStale = useCallback(() => {
    setGitStatusStale(true);
  }, []);

  useEffect(() => {
    if (!workspaceUrl || !terminalToken || !workspaceId || !isRunning) {
      setGitStatus(null);
      setGitChangeCount(0);
      setGitStatusStale(false);
      return;
    }

    let disposed = false;

    const fetchGitStatus = async (retryOnFailure: boolean) => {
      const delays = retryOnFailure ? GIT_STATUS_RETRY_DELAYS_MS : [];
      const attempts = delays.length + 1;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          const status = await getGitStatus(
            workspaceUrl,
            workspaceId,
            terminalToken,
            activeWorktree ?? undefined
          );
          if (!disposed) applyGitStatus(status);
          return;
        } catch {
          if (attempt === attempts - 1) {
            if (!disposed) markGitStatusStale();
            return;
          }
          const delay = delays[attempt] ?? 0;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    };

    void fetchGitStatus(true);
    const interval = setInterval(() => {
      void fetchGitStatus(false);
    }, GIT_STATUS_POLL_INTERVAL_MS);

    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }, [workspaceUrl, terminalToken, workspaceId, isRunning, activeWorktree, applyGitStatus, markGitStatusStale]);

  return {
    gitStatus,
    gitChangeCount,
    gitStatusStale,
    applyGitStatus,
    markGitStatusStale,
  };
}
