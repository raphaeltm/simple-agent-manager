import { useState, useCallback, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { WorktreeInfo, WorktreeCreateRequest } from '@simple-agent-manager/shared';
import {
  listWorktrees as apiListWorktrees,
  createWorktree as apiCreateWorktree,
  removeWorktree as apiRemoveWorktree,
} from '../lib/api';

interface UseWorktreesOptions {
  workspaceUrl: string;
  workspaceId: string;
  token: string | null;
  enabled?: boolean;
}

interface UseWorktreesReturn {
  worktrees: WorktreeInfo[];
  activeWorktree: WorktreeInfo | null;
  activeWorktreePath: string | null;
  loading: boolean;
  error: string | null;
  setActiveWorktree: (path: string) => void;
  createWorktree: (req: WorktreeCreateRequest) => Promise<WorktreeInfo>;
  removeWorktree: (path: string, force?: boolean) => Promise<string[]>;
  refresh: () => Promise<void>;
}

/**
 * Hook for managing git worktrees within a workspace.
 * Active worktree is persisted in the URL via ?worktree= search param.
 */
export function useWorktrees({
  workspaceUrl,
  workspaceId,
  token,
  enabled = true,
}: UseWorktreesOptions): UseWorktreesReturn {
  const [searchParams, setSearchParams] = useSearchParams();
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchedRef = useRef(false);

  // Determine active worktree from URL
  const worktreeParam = searchParams.get('worktree');

  const activeWorktree = worktrees.length > 0
    ? worktrees.find(wt => wt.path === worktreeParam) ??
      worktrees.find(wt => wt.isPrimary) ??
      worktrees[0]
    : null;

  const activeWorktreePath = activeWorktree?.path ?? null;

  // Fetch worktree list
  const refresh = useCallback(async () => {
    if (!token || !workspaceUrl || !workspaceId || !enabled) return;

    setLoading(true);
    setError(null);
    try {
      const result = await apiListWorktrees(workspaceUrl, workspaceId, token);
      setWorktrees(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load worktrees');
    } finally {
      setLoading(false);
    }
  }, [workspaceUrl, workspaceId, token, enabled]);

  // Initial fetch
  useEffect(() => {
    if (token && enabled && !fetchedRef.current) {
      fetchedRef.current = true;
      refresh();
    }
  }, [token, enabled, refresh]);

  // Set active worktree (updates URL param)
  const setActiveWorktree = useCallback((path: string) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      // Find if this is the primary worktree
      const isPrimary = worktrees.find(wt => wt.path === path)?.isPrimary;
      if (isPrimary) {
        // Primary worktree — remove param (clean URL)
        next.delete('worktree');
      } else {
        next.set('worktree', path);
      }
      return next;
    }, { replace: true });
  }, [setSearchParams, worktrees]);

  // Create worktree
  const createWorktreeAction = useCallback(async (req: WorktreeCreateRequest): Promise<WorktreeInfo> => {
    if (!token) throw new Error('No token available');
    const result = await apiCreateWorktree(workspaceUrl, workspaceId, token, req);
    // Refresh the list to include the new worktree
    await refresh();
    return result.worktree;
  }, [workspaceUrl, workspaceId, token, refresh]);

  // Remove worktree
  const removeWorktreeAction = useCallback(async (path: string, force = false): Promise<string[]> => {
    if (!token) throw new Error('No token available');
    const result = await apiRemoveWorktree(workspaceUrl, workspaceId, token, path, force);

    // If the removed worktree was active, switch to primary
    if (path === activeWorktreePath) {
      setSearchParams(prev => {
        const next = new URLSearchParams(prev);
        next.delete('worktree');
        return next;
      }, { replace: true });
    }

    // Refresh the list
    await refresh();
    return result.stoppedSessions;
  }, [workspaceUrl, workspaceId, token, activeWorktreePath, refresh, setSearchParams]);

  return {
    worktrees,
    activeWorktree,
    activeWorktreePath,
    loading,
    error,
    setActiveWorktree,
    createWorktree: createWorktreeAction,
    removeWorktree: removeWorktreeAction,
    refresh,
  };
}
