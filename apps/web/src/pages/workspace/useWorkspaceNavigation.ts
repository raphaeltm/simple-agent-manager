import type { WorktreeInfo } from '@simple-agent-manager/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { NavigateFunction } from 'react-router';

import type { GitStatusData } from '../../lib/api';
import {
  createWorktree,
  getGitBranches,
  getGitStatus,
  getWorktrees,
  removeWorktree,
} from '../../lib/api';
import { countGitChanges, GIT_STATUS_POLL_INTERVAL_MS, GIT_STATUS_RETRY_DELAYS_MS } from './types';

export interface UseWorkspaceNavigationResult {
  // Git status
  gitStatus: GitStatusData | null;
  gitChangeCount: number;
  gitStatusStale: boolean;
  applyGitStatus: (status: GitStatusData) => void;
  markGitStatusStale: () => void;

  // Worktrees
  worktrees: WorktreeInfo[];
  worktreeLoading: boolean;
  remoteBranches: Array<{ name: string }>;
  remoteBranchesLoading: boolean;
  activeWorktree: string | null;
  refreshWorktrees: () => Promise<void>;
  fetchRemoteBranches: () => Promise<void>;

  // Git panel navigation
  handleOpenGitChanges: () => void;
  handleCloseGitPanel: () => void;
  handleNavigateToGitDiff: (filePath: string, staged: boolean) => void;
  handleBackFromGitDiff: () => void;
  handleGitDiffToFileBrowser: (filePath: string) => void;

  // File browser navigation
  handleOpenFileBrowser: () => void;
  handleFileBrowserNavigate: (dirPath: string) => void;
  handleFileViewerOpen: (filePath: string) => void;
  handleFileViewerBack: () => void;
  handleCloseFileBrowser: () => void;
  handleFileViewerToDiff: (filePath: string, staged: boolean) => void;

  // Worktree management
  handleSelectWorktree: (worktreePath: string | null) => void;
  handleCreateWorktree: (request: { branch: string; createBranch: boolean; baseBranch?: string }) => Promise<void>;
  handleRemoveWorktree: (path: string, force: boolean) => Promise<void>;
}

export function useWorkspaceNavigation(
  id: string | undefined,
  navigate: NavigateFunction,
  searchParams: URLSearchParams,
  workspaceUrl: string | undefined,
  terminalToken: string | null,
  isRunning: boolean
): UseWorkspaceNavigationResult {
  const worktreeParam = searchParams.get('worktree');
  const activeWorktree = worktreeParam || null;

  // ── Git status state ──
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

  // ── Git status polling ──
  useEffect(() => {
    if (!workspaceUrl || !terminalToken || !id || !isRunning) {
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
            id,
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
  }, [workspaceUrl, terminalToken, id, isRunning, activeWorktree, applyGitStatus, markGitStatusStale]);

  // ── Worktree state ──
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [worktreeLoading, setWorktreeLoading] = useState(false);
  const [remoteBranches, setRemoteBranches] = useState<Array<{ name: string }>>([]);
  const [remoteBranchesLoading, setRemoteBranchesLoading] = useState(false);

  const refreshWorktrees = useCallback(async () => {
    if (!id || !workspaceUrl || !terminalToken || !isRunning) return;
    try {
      setWorktreeLoading(true);
      const response = await getWorktrees(workspaceUrl, id, terminalToken);
      setWorktrees(response.worktrees ?? []);
    } catch {
      setWorktrees([]);
    } finally {
      setWorktreeLoading(false);
    }
  }, [id, workspaceUrl, terminalToken, isRunning]);

  const fetchRemoteBranches = useCallback(async () => {
    if (!id || !workspaceUrl || !terminalToken || !isRunning) return;
    try {
      setRemoteBranchesLoading(true);
      const response = await getGitBranches(workspaceUrl, id, terminalToken);
      setRemoteBranches(response.branches ?? []);
    } catch {
      setRemoteBranches([]);
    } finally {
      setRemoteBranchesLoading(false);
    }
  }, [id, workspaceUrl, terminalToken, isRunning]);

  useEffect(() => {
    void refreshWorktrees();
  }, [refreshWorktrees]);

  // Reset worktree URL param if active worktree no longer exists
  useEffect(() => {
    if (!id || !activeWorktree || worktrees.length === 0) return;
    if (worktrees.some((wt) => wt.path === activeWorktree)) return;

    const params = new URLSearchParams(searchParams);
    params.delete('worktree');
    navigate(`/workspaces/${id}?${params.toString()}`, { replace: true });
  }, [activeWorktree, id, navigate, searchParams, worktrees]);

  // ── Git changes panel navigation ──
  const handleOpenGitChanges = useCallback(() => {
    const params = new URLSearchParams(searchParams);
    params.delete('files');
    params.delete('path');
    params.set('git', 'changes');
    params.delete('file');
    params.delete('staged');
    navigate(`/workspaces/${id}?${params.toString()}`);
  }, [id, navigate, searchParams]);

  const handleCloseGitPanel = useCallback(() => {
    const params = new URLSearchParams(searchParams);
    params.delete('git');
    params.delete('file');
    params.delete('staged');
    navigate(`/workspaces/${id}?${params.toString()}`);
  }, [id, navigate, searchParams]);

  const handleNavigateToGitDiff = useCallback(
    (filePath: string, staged: boolean) => {
      const params = new URLSearchParams(searchParams);
      params.set('git', 'diff');
      params.set('file', filePath);
      params.set('staged', String(staged));
      navigate(`/workspaces/${id}?${params.toString()}`);
    },
    [id, navigate, searchParams]
  );

  const handleBackFromGitDiff = useCallback(() => {
    const params = new URLSearchParams(searchParams);
    params.set('git', 'changes');
    params.delete('file');
    params.delete('staged');
    navigate(`/workspaces/${id}?${params.toString()}`);
  }, [id, navigate, searchParams]);

  const handleGitDiffToFileBrowser = useCallback(
    (filePath: string) => {
      const params = new URLSearchParams(searchParams);
      params.delete('git');
      params.delete('file');
      params.delete('staged');
      params.set('files', 'view');
      params.set('path', filePath);
      navigate(`/workspaces/${id}?${params.toString()}`);
    },
    [id, navigate, searchParams]
  );

  // ── File browser navigation ──
  const handleOpenFileBrowser = useCallback(() => {
    const params = new URLSearchParams(searchParams);
    params.delete('git');
    params.delete('file');
    params.delete('staged');
    params.set('files', 'browse');
    params.delete('path');
    navigate(`/workspaces/${id}?${params.toString()}`);
  }, [id, navigate, searchParams]);

  const handleFileBrowserNavigate = useCallback(
    (dirPath: string) => {
      const params = new URLSearchParams(searchParams);
      params.delete('git');
      params.delete('file');
      params.delete('staged');
      params.set('files', 'browse');
      if (dirPath && dirPath !== '.') {
        params.set('path', dirPath);
      } else {
        params.delete('path');
      }
      navigate(`/workspaces/${id}?${params.toString()}`);
    },
    [id, navigate, searchParams]
  );

  const handleFileViewerOpen = useCallback(
    (filePath: string) => {
      const params = new URLSearchParams(searchParams);
      params.delete('git');
      params.delete('file');
      params.delete('staged');
      params.set('files', 'view');
      params.set('path', filePath);
      navigate(`/workspaces/${id}?${params.toString()}`);
    },
    [id, navigate, searchParams]
  );

  const handleFileViewerBack = useCallback(() => {
    const params = new URLSearchParams(searchParams);
    params.set('files', 'browse');
    const currentPath = params.get('path') ?? '';
    const lastSlash = currentPath.lastIndexOf('/');
    if (lastSlash > 0) {
      params.set('path', currentPath.slice(0, lastSlash));
    } else {
      params.delete('path');
    }
    navigate(`/workspaces/${id}?${params.toString()}`);
  }, [id, navigate, searchParams]);

  const handleCloseFileBrowser = useCallback(() => {
    const params = new URLSearchParams(searchParams);
    params.delete('files');
    params.delete('path');
    navigate(`/workspaces/${id}?${params.toString()}`);
  }, [id, navigate, searchParams]);

  const handleFileViewerToDiff = useCallback(
    (filePath: string, staged: boolean) => {
      const params = new URLSearchParams(searchParams);
      params.delete('files');
      params.delete('path');
      params.set('git', 'diff');
      params.set('file', filePath);
      params.set('staged', String(staged));
      navigate(`/workspaces/${id}?${params.toString()}`);
    },
    [id, navigate, searchParams]
  );

  // ── Worktree management ──
  const handleSelectWorktree = useCallback(
    (worktreePath: string | null) => {
      if (!id) return;
      const params = new URLSearchParams(searchParams);
      if (worktreePath) params.set('worktree', worktreePath);
      else params.delete('worktree');

      params.delete('git');
      params.delete('file');
      params.delete('staged');
      params.delete('files');
      params.delete('path');

      navigate(`/workspaces/${id}?${params.toString()}`, { replace: true });
    },
    [id, navigate, searchParams]
  );

  const handleCreateWorktree = useCallback(
    async (request: { branch: string; createBranch: boolean; baseBranch?: string }) => {
      if (!id || !workspaceUrl || !terminalToken) return;
      await createWorktree(workspaceUrl, id, terminalToken, request);
      await refreshWorktrees();
    },
    [id, workspaceUrl, terminalToken, refreshWorktrees]
  );

  const handleRemoveWorktree = useMemo(() => {
    return async (path: string, force: boolean) => {
      if (!id || !workspaceUrl || !terminalToken) return;
      await removeWorktree(workspaceUrl, id, terminalToken, path, force);
      if (activeWorktree === path) {
        handleSelectWorktree(null);
      }
      await refreshWorktrees();
    };
  }, [id, workspaceUrl, terminalToken, activeWorktree, handleSelectWorktree, refreshWorktrees]);

  return {
    gitStatus,
    gitChangeCount,
    gitStatusStale,
    applyGitStatus,
    markGitStatusStale,
    worktrees,
    worktreeLoading,
    remoteBranches,
    remoteBranchesLoading,
    activeWorktree,
    refreshWorktrees,
    fetchRemoteBranches,
    handleOpenGitChanges,
    handleCloseGitPanel,
    handleNavigateToGitDiff,
    handleBackFromGitDiff,
    handleGitDiffToFileBrowser,
    handleOpenFileBrowser,
    handleFileBrowserNavigate,
    handleFileViewerOpen,
    handleFileViewerBack,
    handleCloseFileBrowser,
    handleFileViewerToDiff,
    handleSelectWorktree,
    handleCreateWorktree,
    handleRemoveWorktree,
  };
}
