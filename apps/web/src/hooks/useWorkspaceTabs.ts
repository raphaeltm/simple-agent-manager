import { useMemo, useCallback } from 'react';
import type {
  MultiTerminalSessionSnapshot,
} from '@simple-agent-manager/terminal';
import type { WorkspaceTabItem } from '../components/WorkspaceTabStrip';
import type { AgentHostStatus, AgentInfo, AgentSession, WorktreeInfo } from '@simple-agent-manager/shared';
import { isSessionActive } from '../lib/session-utils';
import type { UseTabOrderReturn } from './useTabOrder';

type ViewMode = 'terminal' | 'conversation';

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

function workspaceTabStatusColor(tab: WorkspaceTab): string {
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

  if (tab.hostStatus) {
    switch (tab.hostStatus) {
      case 'prompting':
        return 'var(--sam-color-tn-purple)';
      case 'ready':
        return 'var(--sam-color-tn-green)';
      case 'starting':
        return 'var(--sam-color-tn-yellow)';
      case 'idle':
        return 'var(--sam-color-tn-fg-muted)';
      case 'stopped':
        return 'var(--sam-color-tn-fg-dimmer)';
      case 'error':
        return 'var(--sam-color-tn-red)';
    }
  }

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

function deriveWorktreeBadge(
  path: string | null | undefined,
  worktrees: WorktreeInfo[]
): string | undefined {
  if (!path) return undefined;
  const found = worktrees.find((wt) => wt.path === path);
  if (found?.branch) return found.branch;
  const parts = path.split('/');
  return parts[parts.length - 1] || undefined;
}

interface UseWorkspaceTabsOptions {
  isRunning: boolean;
  multiTerminal: boolean;
  terminalTabs: MultiTerminalSessionSnapshot[];
  agentSessions: AgentSession[];
  agentNameById: Map<AgentInfo['id'], string>;
  preferredAgentsBySession: Record<string, AgentInfo['id']>;
  recentlyStopped: Set<string>;
  worktrees: WorktreeInfo[];
  tabOrder: UseTabOrderReturn<WorkspaceTab>;
  viewMode: ViewMode;
  activeTerminalSessionId: string | null;
  activeChatSessionId: string | null;
}

export function useWorkspaceTabs({
  isRunning,
  multiTerminal,
  terminalTabs,
  agentSessions,
  agentNameById,
  preferredAgentsBySession,
  recentlyStopped,
  worktrees,
  tabOrder,
  viewMode,
  activeTerminalSessionId,
  activeChatSessionId,
}: UseWorkspaceTabsOptions) {
  const visibleTerminalTabs = useMemo<MultiTerminalSessionSnapshot[]>(() => {
    if (!isRunning || !multiTerminal) return [];
    return terminalTabs;
  }, [multiTerminal, isRunning, terminalTabs]);

  const workspaceTabs = useMemo<WorkspaceTab[]>(() => {
    const terminalSessionTabs: WorkspaceTab[] = visibleTerminalTabs.map((session) => ({
      id: `terminal:${session.id}`,
      kind: 'terminal',
      sessionId: session.id,
      title: session.name,
      status: session.status,
      badge: deriveWorktreeBadge(session.workingDirectory, worktrees),
    }));

    const chatSessionTabs: WorkspaceTab[] = agentSessions
      .filter(
        (session) =>
          (isSessionActive(session) || session.status === 'suspended') &&
          !recentlyStopped.has(session.id)
      )
      .map((session) => {
        const preferredAgent = preferredAgentsBySession[session.id];
        const preferredName = preferredAgent ? agentNameById.get(preferredAgent) : undefined;
        const title =
          session.label?.trim() ||
          (preferredName ? `${preferredName} Chat` : `Chat ${session.id.slice(-4)}`);
        return {
          id: `chat:${session.id}`,
          kind: 'chat' as const,
          sessionId: session.id,
          title,
          status: session.status,
          hostStatus: session.hostStatus,
          viewerCount: session.viewerCount,
          badge: deriveWorktreeBadge(session.worktreePath ?? undefined, worktrees),
        };
      });

    return tabOrder.getSortedTabs([...terminalSessionTabs, ...chatSessionTabs]);
  }, [
    agentNameById,
    agentSessions,
    preferredAgentsBySession,
    recentlyStopped,
    tabOrder,
    visibleTerminalTabs,
    worktrees,
  ]);

  const activeTabId = useMemo(() => {
    if (viewMode === 'terminal') {
      if (activeTerminalSessionId) return `terminal:${activeTerminalSessionId}`;
      if (visibleTerminalTabs.length > 0) return `terminal:${visibleTerminalTabs[0]!.id}`;
      return null;
    }
    return activeChatSessionId ? `chat:${activeChatSessionId}` : null;
  }, [activeChatSessionId, activeTerminalSessionId, viewMode, visibleTerminalTabs]);

  const tabStripItems = useMemo<WorkspaceTabItem[]>(
    () =>
      workspaceTabs.map((tab) => ({
        id: tab.id,
        kind: tab.kind,
        sessionId: tab.sessionId,
        title: tab.title,
        statusColor: workspaceTabStatusColor(tab),
        badge: tab.badge,
        dimmed: tab.kind === 'chat' && tab.status === 'suspended',
      })),
    [workspaceTabs]
  );

  const handleSelectTabItem = useCallback(
    (tabItem: WorkspaceTabItem, selectWorkspaceTab: (tab: WorkspaceTab) => void) => {
      const tab = workspaceTabs.find((t) => t.id === tabItem.id);
      if (tab) selectWorkspaceTab(tab);
    },
    [workspaceTabs]
  );

  const handleCloseTabItem = useCallback(
    (tabItem: WorkspaceTabItem, closeWorkspaceTab: (tab: WorkspaceTab) => void) => {
      const tab = workspaceTabs.find((t) => t.id === tabItem.id);
      if (tab) closeWorkspaceTab(tab);
    },
    [workspaceTabs]
  );

  return {
    visibleTerminalTabs,
    workspaceTabs,
    activeTabId,
    tabStripItems,
    handleSelectTabItem,
    handleCloseTabItem,
  };
}
