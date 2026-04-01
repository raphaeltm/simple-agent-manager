import type {
  AgentHostStatus,
  AgentSession,
  WorktreeInfo,
} from '@simple-agent-manager/shared';
import type { MultiTerminalSessionSnapshot } from '@simple-agent-manager/terminal';

import type { GitStatusData } from '../../lib/api';

/** View modes */
export type ViewMode = 'terminal' | 'conversation';

export type WorkspaceTab =
  | {
      id: string;
      kind: 'terminal';
      sessionId: string;
      title: string;
      status: MultiTerminalSessionSnapshot['status'];
      badge?: string;
    }
  | {
      id: string;
      kind: 'chat';
      sessionId: string;
      title: string;
      status: AgentSession['status'];
      hostStatus?: AgentHostStatus | null;
      viewerCount?: number | null;
      badge?: string;
    };

export const GIT_STATUS_POLL_INTERVAL_MS = 30_000;
export const GIT_STATUS_RETRY_DELAYS_MS = [750, 1500];
export const ACTIVITY_THROTTLE_MS = 10_000;

export function countGitChanges(status: GitStatusData): number {
  return status.staged.length + status.unstaged.length + status.untracked.length;
}

export function workspaceTabStatusColor(tab: WorkspaceTab): string {
  if (tab.kind === 'terminal') {
    switch (tab.status) {
      case 'connecting':
        return 'var(--sam-color-tn-yellow)';
      case 'connected':
        return 'var(--sam-color-tn-green)';
      case 'error':
        return 'var(--sam-color-tn-red)';
      default:
        return 'var(--sam-color-tn-fg-muted)';
    }
  }

  // Use live hostStatus when available for finer-grained colors
  if (tab.hostStatus) {
    switch (tab.hostStatus) {
      case 'prompting':
        return 'var(--sam-color-tn-purple)'; // purple — actively working
      case 'ready':
        return 'var(--sam-color-tn-green)'; // green — ready for prompts
      case 'starting':
        return 'var(--sam-color-tn-yellow)'; // amber — initializing
      case 'idle':
        return 'var(--sam-color-tn-fg-muted)'; // dim — no agent selected
      case 'stopped':
        return 'var(--sam-color-tn-fg-dimmer)'; // dimmer — stopped
      case 'error':
        return 'var(--sam-color-tn-red)'; // red
    }
  }

  // Fallback to DB status when hostStatus is not available
  switch (tab.status) {
    case 'running':
      return 'var(--sam-color-tn-green)';
    case 'suspended':
      return 'var(--sam-color-tn-yellow)';
    case 'error':
      return 'var(--sam-color-tn-red)';
    default:
      return 'var(--sam-color-tn-fg-muted)';
  }
}

export function deriveWorktreeBadge(
  path: string | null | undefined,
  worktrees: WorktreeInfo[]
): string | undefined {
  if (!path) return undefined;
  const found = worktrees.find((wt) => wt.path === path);
  if (found?.branch) {
    return found.branch;
  }
  const parts = path.split('/');
  return parts[parts.length - 1] || undefined;
}
