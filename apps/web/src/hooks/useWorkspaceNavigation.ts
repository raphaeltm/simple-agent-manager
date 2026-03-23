import { useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

/**
 * Encapsulates all URL-driven navigation handlers for the workspace page:
 * git changes panel, file browser, worktree selection, and file viewer.
 */
export function useWorkspaceNavigation(id: string | undefined) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // ── URL params ──
  const gitParam = searchParams.get('git');
  const gitFileParam = searchParams.get('file');
  const gitStagedParam = searchParams.get('staged');
  const filesParam = searchParams.get('files');
  const filesPathParam = searchParams.get('path');
  const worktreeParam = searchParams.get('worktree');

  // ── Git changes panel ──

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

  // ── File browser ──

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

  // ── Worktree selection ──

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

  return {
    // URL params
    searchParams,
    gitParam,
    gitFileParam,
    gitStagedParam,
    filesParam,
    filesPathParam,
    worktreeParam,
    activeWorktree: worktreeParam || null,

    // Git
    handleOpenGitChanges,
    handleCloseGitPanel,
    handleNavigateToGitDiff,
    handleBackFromGitDiff,
    handleGitDiffToFileBrowser,

    // Files
    handleOpenFileBrowser,
    handleFileBrowserNavigate,
    handleFileViewerOpen,
    handleFileViewerBack,
    handleCloseFileBrowser,
    handleFileViewerToDiff,

    // Worktree
    handleSelectWorktree,

    // Expose navigate for other uses
    navigate,
  };
}
