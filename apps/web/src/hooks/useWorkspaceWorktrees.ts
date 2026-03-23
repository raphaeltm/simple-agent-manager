import { useState, useEffect, useCallback } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import type { WorktreeInfo } from '@simple-agent-manager/shared';
import { createWorktree, getGitBranches, getWorktrees, removeWorktree } from '../lib/api';

interface UseWorkspaceWorktreesOptions {
  workspaceId: string | undefined;
  workspaceUrl: string | undefined;
  terminalToken: string | null;
  isRunning: boolean;
  activeWorktree: string | null;
  searchParams: URLSearchParams;
  navigate: NavigateFunction;
  handleSelectWorktree: (path: string | null) => void;
}

export function useWorkspaceWorktrees({
  workspaceId,
  workspaceUrl,
  terminalToken,
  isRunning,
  activeWorktree,
  searchParams,
  navigate,
  handleSelectWorktree,
}: UseWorkspaceWorktreesOptions) {
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [worktreeLoading, setWorktreeLoading] = useState(false);
  const [remoteBranches, setRemoteBranches] = useState<Array<{ name: string }>>([]);
  const [remoteBranchesLoading, setRemoteBranchesLoading] = useState(false);

  const refreshWorktrees = useCallback(async () => {
    if (!workspaceId || !workspaceUrl || !terminalToken || !isRunning) return;
    try {
      setWorktreeLoading(true);
      const response = await getWorktrees(workspaceUrl, workspaceId, terminalToken);
      setWorktrees(response.worktrees ?? []);
    } catch {
      setWorktrees([]);
    } finally {
      setWorktreeLoading(false);
    }
  }, [workspaceId, workspaceUrl, terminalToken, isRunning]);

  const fetchRemoteBranches = useCallback(async () => {
    if (!workspaceId || !workspaceUrl || !terminalToken || !isRunning) return;
    try {
      setRemoteBranchesLoading(true);
      const response = await getGitBranches(workspaceUrl, workspaceId, terminalToken);
      setRemoteBranches(response.branches ?? []);
    } catch {
      setRemoteBranches([]);
    } finally {
      setRemoteBranchesLoading(false);
    }
  }, [workspaceId, workspaceUrl, terminalToken, isRunning]);

  useEffect(() => {
    void refreshWorktrees();
  }, [refreshWorktrees]);

  // Reset worktree param if the worktree no longer exists
  useEffect(() => {
    if (!workspaceId || !activeWorktree || worktrees.length === 0) return;
    if (worktrees.some((wt) => wt.path === activeWorktree)) return;
    const params = new URLSearchParams(searchParams);
    params.delete('worktree');
    navigate(`/workspaces/${workspaceId}?${params.toString()}`, { replace: true });
  }, [activeWorktree, workspaceId, navigate, searchParams, worktrees]);

  const handleCreateWorktree = useCallback(
    async (request: { branch: string; createBranch: boolean; baseBranch?: string }) => {
      if (!workspaceId || !workspaceUrl || !terminalToken) return;
      await createWorktree(workspaceUrl, workspaceId, terminalToken, request);
      await refreshWorktrees();
    },
    [workspaceId, workspaceUrl, terminalToken, refreshWorktrees]
  );

  const handleRemoveWorktree = useCallback(
    async (path: string, force: boolean) => {
      if (!workspaceId || !workspaceUrl || !terminalToken) return;
      await removeWorktree(workspaceUrl, workspaceId, terminalToken, path, force);
      if (activeWorktree === path) handleSelectWorktree(null);
      await refreshWorktrees();
    },
    [workspaceId, workspaceUrl, terminalToken, activeWorktree, handleSelectWorktree, refreshWorktrees]
  );

  return {
    worktrees,
    worktreeLoading,
    remoteBranches,
    remoteBranchesLoading,
    fetchRemoteBranches,
    handleCreateWorktree,
    handleRemoveWorktree,
  };
}
