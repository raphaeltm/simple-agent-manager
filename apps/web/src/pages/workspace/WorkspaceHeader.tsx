import type { WorkspaceResponse, WorktreeInfo } from '@simple-agent-manager/shared';
import { StatusBadge } from '@simple-agent-manager/ui';
import { MoreVertical } from 'lucide-react';

import { CommandPaletteButton } from '../../components/CommandPaletteButton';
import { FileBrowserButton } from '../../components/FileBrowserButton';
import { GitChangesButton } from '../../components/GitChangesButton';
import { UserMenu } from '../../components/UserMenu';
import { WorktreeSelector } from '../../components/WorktreeSelector';

export interface WorkspaceHeaderProps {
  workspace: WorkspaceResponse | null;
  isMobile: boolean;
  isRunning: boolean;
  terminalToken: string | null;
  error: string | null;
  gitChangeCount: number;
  gitStatusStale: boolean;
  worktrees: WorktreeInfo[];
  activeWorktree: string | null;
  worktreeLoading: boolean;
  remoteBranches: Array<{ name: string }>;
  remoteBranchesLoading: boolean;
  onBack: () => void;
  onClearError: () => void;
  onOpenFileBrowser: () => void;
  onOpenGitChanges: () => void;
  onOpenCommandPalette: () => void;
  onOpenMobileMenu: () => void;
  onSelectWorktree: (worktreePath: string | null) => void;
  onCreateWorktree: (request: { branch: string; createBranch: boolean; baseBranch?: string }) => Promise<void>;
  onRemoveWorktree: (path: string, force: boolean) => Promise<void>;
  onRequestBranches: () => Promise<void>;
}

export function WorkspaceHeader({
  workspace,
  isMobile,
  isRunning,
  terminalToken,
  error,
  gitChangeCount,
  gitStatusStale,
  worktrees,
  activeWorktree,
  worktreeLoading,
  remoteBranches,
  remoteBranchesLoading,
  onBack,
  onClearError,
  onOpenFileBrowser,
  onOpenGitChanges,
  onOpenCommandPalette,
  onOpenMobileMenu,
  onSelectWorktree,
  onCreateWorktree,
  onRemoveWorktree,
  onRequestBranches,
}: WorkspaceHeaderProps) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        padding: isMobile ? '0 2px' : '0 12px',
        height: isMobile ? '44px' : '40px',
        backgroundColor: 'var(--sam-color-bg-surface)',
        borderBottom: '1px solid var(--sam-color-border-default)',
        gap: isMobile ? '2px' : '10px',
        flexShrink: 0,
      }}
    >
      {/* Back */}
      <button
        onClick={onBack}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--sam-color-fg-muted)',
          padding: isMobile ? '8px' : '4px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minWidth: isMobile ? 44 : undefined,
          minHeight: isMobile ? 44 : undefined,
        }}
        aria-label={workspace?.projectId ? 'Back to project' : 'Back to dashboard'}
      >
        <svg
          style={{ height: isMobile ? 18 : 16, width: isMobile ? 18 : 16 }}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M15 19l-7-7 7-7"
          />
        </svg>
      </button>

      {/* Workspace name + status */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: isMobile ? '4px' : '8px',
          minWidth: 0,
          flex: isMobile ? 1 : undefined,
        }}
      >
        <span
          style={{
            fontWeight: 600,
            fontSize: 'var(--sam-type-secondary-size)',
            color: 'var(--sam-color-fg-primary)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {workspace?.displayName || workspace?.name}
        </span>
        {workspace && <StatusBadge status={workspace.status} />}
      </div>

      {/* Project link + Repo@branch (desktop only) */}
      {!isMobile && workspace?.projectId && (
        <>
          <div
            style={{
              width: '1px',
              height: '16px',
              backgroundColor: 'var(--sam-color-border-default)',
              flexShrink: 0,
            }}
          />
          <button
            onClick={() => onBack()}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: 'var(--sam-type-caption-size)',
              color: 'var(--sam-color-accent-primary)',
              whiteSpace: 'nowrap',
              padding: 0,
              textDecoration: 'none',
            }}
            title="Go to project"
          >
            Project
          </button>
        </>
      )}
      {!isMobile && (
        <span
          style={{
            fontSize: 'var(--sam-type-caption-size)',
            color: 'var(--sam-color-fg-muted)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            minWidth: 0,
          }}
        >
          {workspace?.repository}
          {workspace?.branch ? `@${workspace.branch}` : ''}
        </span>
      )}

      {/* Spacer */}
      <div style={{ flex: isMobile ? undefined : 1 }} />

      {/* Worktree selector */}
      {isRunning && terminalToken && workspace?.url && workspace?.id && (
        <WorktreeSelector
          worktrees={worktrees}
          activeWorktree={activeWorktree}
          loading={worktreeLoading}
          isMobile={isMobile}
          remoteBranches={remoteBranches}
          remoteBranchesLoading={remoteBranchesLoading}
          onSelect={onSelectWorktree}
          onCreate={onCreateWorktree}
          onRemove={onRemoveWorktree}
          onRequestBranches={onRequestBranches}
        />
      )}

      {/* Error inline (desktop only) */}
      {!isMobile && error && (
        <span style={{ fontSize: 'var(--sam-type-caption-size)', color: 'var(--sam-color-danger-fg)', whiteSpace: 'nowrap' }}>
          {error}
          <button
            onClick={onClearError}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--sam-color-danger-fg)',
              cursor: 'pointer',
              marginLeft: '4px',
              fontSize: 'var(--sam-type-caption-size)',
            }}
          >
            x
          </button>
        </span>
      )}

      {/* File browser button */}
      {isRunning && terminalToken && (
        <FileBrowserButton
          onClick={onOpenFileBrowser}
          isMobile={isMobile}
          compactMobile={isMobile}
        />
      )}

      {/* Git changes button */}
      {isRunning && terminalToken && (
        <GitChangesButton
          onClick={onOpenGitChanges}
          changeCount={gitChangeCount}
          isMobile={isMobile}
          compactMobile={isMobile}
          isStale={gitStatusStale}
        />
      )}

      {/* Mobile command palette access */}
      {isRunning && terminalToken && isMobile && (
        <CommandPaletteButton
          onClick={onOpenCommandPalette}
          isMobile
          compactMobile
        />
      )}

      {/* Mobile sidebar menu button */}
      {isMobile && (
        <button
          onClick={onOpenMobileMenu}
          aria-label="Open workspace menu"
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--sam-color-fg-muted)',
            padding: '6px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minWidth: 36,
            minHeight: 36,
            flexShrink: 0,
          }}
        >
          <MoreVertical size={16} />
        </button>
      )}

      {/* User menu */}
      <UserMenu compact />
    </header>
  );
}
