import { FileBrowserPanel } from '../../components/FileBrowserPanel';
import { FileViewerPanel } from '../../components/FileViewerPanel';
import { GitChangesPanel } from '../../components/GitChangesPanel';
import { GitDiffView } from '../../components/GitDiffView';
import type { GitStatusData } from '../../lib/api';

export interface WorkspaceOverlayPanelsProps {
  gitParam: string | null;
  gitFileParam: string | null;
  gitStagedParam: string | null;
  filesParam: string | null;
  filesPathParam: string | null;
  terminalToken: string | null;
  workspaceUrl: string | undefined;
  workspaceId: string | undefined;
  activeWorktree: string | null;
  isMobile: boolean;
  onCloseGitPanel: () => void;
  onNavigateToGitDiff: (filePath: string, staged: boolean) => void;
  onApplyGitStatus: (status: GitStatusData) => void;
  onMarkGitStatusStale: () => void;
  onBackFromGitDiff: () => void;
  onGitDiffToFileBrowser: (filePath: string) => void;
  onCloseFileBrowser: () => void;
  onFileViewerOpen: (filePath: string) => void;
  onFileBrowserNavigate: (dirPath: string) => void;
  onFileViewerBack: () => void;
  onFileViewerToDiff: (filePath: string, staged: boolean) => void;
}

/**
 * Bundles the four URL-driven workspace overlays (git changes, git diff,
 * file browser, file viewer). Each panel is independently gated by its own
 * search-param combination, mirroring the mutually-exclusive query states
 * that WorkspaceHeader/GitChangesPanel/FileBrowserPanel navigation produces.
 */
export function WorkspaceOverlayPanels({
  gitParam,
  gitFileParam,
  gitStagedParam,
  filesParam,
  filesPathParam,
  terminalToken,
  workspaceUrl,
  workspaceId,
  activeWorktree,
  isMobile,
  onCloseGitPanel,
  onNavigateToGitDiff,
  onApplyGitStatus,
  onMarkGitStatusStale,
  onBackFromGitDiff,
  onGitDiffToFileBrowser,
  onCloseFileBrowser,
  onFileViewerOpen,
  onFileBrowserNavigate,
  onFileViewerBack,
  onFileViewerToDiff,
}: WorkspaceOverlayPanelsProps) {
  return (
    <>
      {gitParam === 'changes' && terminalToken && workspaceUrl && workspaceId && (
        <GitChangesPanel
          workspaceUrl={workspaceUrl}
          workspaceId={workspaceId}
          token={terminalToken}
          worktree={activeWorktree}
          isMobile={isMobile}
          onClose={onCloseGitPanel}
          onSelectFile={onNavigateToGitDiff}
          onStatusChange={onApplyGitStatus}
          onStatusFetchError={onMarkGitStatusStale}
        />
      )}
      {gitParam === 'diff' && gitFileParam && terminalToken && workspaceUrl && workspaceId && (
        <GitDiffView
          workspaceUrl={workspaceUrl}
          workspaceId={workspaceId}
          token={terminalToken}
          worktree={activeWorktree}
          filePath={gitFileParam}
          staged={gitStagedParam === 'true'}
          isMobile={isMobile}
          onBack={onBackFromGitDiff}
          onClose={onCloseGitPanel}
          onViewInFileBrowser={onGitDiffToFileBrowser}
        />
      )}
      {filesParam === 'browse' && terminalToken && workspaceUrl && workspaceId && (
        <FileBrowserPanel
          workspaceUrl={workspaceUrl}
          workspaceId={workspaceId}
          token={terminalToken}
          worktree={activeWorktree}
          initialPath={filesPathParam ?? '.'}
          isMobile={isMobile}
          onClose={onCloseFileBrowser}
          onSelectFile={onFileViewerOpen}
          onNavigate={onFileBrowserNavigate}
        />
      )}
      {filesParam === 'view' && filesPathParam && terminalToken && workspaceUrl && workspaceId && (
        <FileViewerPanel
          workspaceUrl={workspaceUrl}
          workspaceId={workspaceId}
          token={terminalToken}
          worktree={activeWorktree}
          filePath={filesPathParam}
          isMobile={isMobile}
          onBack={onFileViewerBack}
          onClose={onCloseFileBrowser}
          onViewDiff={onFileViewerToDiff}
        />
      )}
    </>
  );
}
