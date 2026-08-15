import type { AgentInfo, AgentSession, WorktreeInfo } from '@simple-agent-manager/shared';
import type {
  MultiTerminalHandle,
  MultiTerminalSessionSnapshot,
} from '@simple-agent-manager/terminal';
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useMemo,
  useRef,
} from 'react';
import type { NavigateFunction } from 'react-router';

import type { WorkspaceTabItem } from '../../components/WorkspaceTabStrip';
import type { UseTabOrderReturn } from '../../hooks/useTabOrder';
import { listAgentSessions, renameAgentSession } from '../../lib/api';
import { isSessionActive } from '../../lib/session-utils';
import type { ViewMode, WorkspaceTab } from './types';
import { deriveWorktreeBadge, workspaceTabStatusColor } from './types';

export interface UseWorkspaceTabsParams {
  id: string | undefined;
  navigate: NavigateFunction;
  searchParams: URLSearchParams;
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  isRunning: boolean;
  multiTerminalEnabled: boolean;
  terminalTabs: MultiTerminalSessionSnapshot[];
  activeTerminalSessionId: string | null;
  setActiveTerminalSessionId: Dispatch<SetStateAction<string | null>>;
  worktrees: WorktreeInfo[];
  chatSessionId: string | null | undefined;
  agentSessions: AgentSession[];
  setAgentSessions: Dispatch<SetStateAction<AgentSession[]>>;
  recentlyStopped: Set<string>;
  preferredAgentsBySession: Record<string, AgentInfo['id']>;
  agentNameById: Map<string, string>;
  activeChatSessionId: string | null;
  handleResumeSession: (sessionId: string) => Promise<void>;
  handleAttachSession: (sessionId: string) => void;
  handleStopSession: (sessionId: string) => Promise<void>;
  tabOrder: UseTabOrderReturn<WorkspaceTab>;
  multiTerminalRef: RefObject<MultiTerminalHandle | null>;
  setCreateMenuOpen: Dispatch<SetStateAction<boolean>>;
}

export interface UseWorkspaceTabsResult {
  workspaceTabs: WorkspaceTab[];
  activeTabId: string | null;
  tabStripItems: WorkspaceTabItem[];
  handleCreateTerminalTab: () => void;
  handleSelectWorkspaceTab: (tab: WorkspaceTab) => void;
  /**
   * Kept fresh every render so memoized callers (e.g. the command palette's
   * select handler in the parent component) always invoke the latest closure
   * without needing `handleSelectWorkspaceTab` in their deps.
   */
  handleSelectWorkspaceTabRef: RefObject<(tab: WorkspaceTab) => void>;
  handleRenameWorkspaceTab: (tabItem: WorkspaceTabItem, newName: string) => void;
  handleSelectTabItem: (ti: WorkspaceTabItem) => void;
  handleCloseTabItem: (ti: WorkspaceTabItem) => void;
}

/**
 * Workspace tab-strip state: derives the merged terminal+chat tab list,
 * tracks the active tab, and owns the create/select/close/rename handlers.
 */
export function useWorkspaceTabs(input: UseWorkspaceTabsParams): UseWorkspaceTabsResult {
  const {
    id,
    navigate,
    searchParams,
    viewMode,
    setViewMode,
    isRunning,
    multiTerminalEnabled,
    terminalTabs,
    activeTerminalSessionId,
    setActiveTerminalSessionId,
    worktrees,
    chatSessionId,
    agentSessions,
    setAgentSessions,
    recentlyStopped,
    preferredAgentsBySession,
    agentNameById,
    activeChatSessionId,
    handleResumeSession,
    handleAttachSession,
    handleStopSession,
    tabOrder,
    multiTerminalRef,
    setCreateMenuOpen,
  } = input;

  const visibleTerminalTabs = useMemo<MultiTerminalSessionSnapshot[]>(
    () => (!isRunning || !multiTerminalEnabled ? [] : terminalTabs),
    [multiTerminalEnabled, isRunning, terminalTabs]
  );

  const workspaceTabs = useMemo<WorkspaceTab[]>(() => {
    const termTabs: WorkspaceTab[] = visibleTerminalTabs.map((s) => ({
      id: `terminal:${s.id}`,
      kind: 'terminal',
      sessionId: s.id,
      title: s.name,
      status: s.status,
      badge: deriveWorktreeBadge(s.workingDirectory, worktrees),
    }));
    let chatTabs: WorkspaceTab[];
    if (chatSessionId) {
      // Workspace linked to a project chat session — show a single "Chat" tab
      chatTabs = [
        {
          id: `chat:${chatSessionId}`,
          kind: 'chat' as const,
          sessionId: chatSessionId,
          title: 'Chat',
          status: 'running',
          hostStatus: null,
          viewerCount: null,
        },
      ];
    } else {
      // Fallback: per-agent-session tabs for workspaces without a linked project session
      chatTabs = agentSessions
        .filter(
          (s) => (isSessionActive(s) || s.status === 'suspended') && !recentlyStopped.has(s.id)
        )
        .map((s) => {
          const pref = preferredAgentsBySession[s.id];
          const prefName = pref ? agentNameById.get(pref) : undefined;
          const title =
            s.label?.trim() || (prefName ? `${prefName} Chat` : `Chat ${s.id.slice(-4)}`);
          return {
            id: `chat:${s.id}`,
            kind: 'chat' as const,
            sessionId: s.id,
            title,
            status: s.status,
            hostStatus: s.hostStatus,
            viewerCount: s.viewerCount,
            badge: deriveWorktreeBadge(s.worktreePath ?? undefined, worktrees),
          };
        });
    }
    return tabOrder.getSortedTabs([...termTabs, ...chatTabs]);
  }, [
    agentNameById,
    agentSessions,
    chatSessionId,
    preferredAgentsBySession,
    recentlyStopped,
    tabOrder,
    visibleTerminalTabs,
    worktrees,
  ]);

  const handleCreateTerminalTab = () => {
    setViewMode('terminal');
    const params = new URLSearchParams(searchParams);
    params.set('view', 'terminal');
    params.delete('sessionId');
    navigate(`/workspaces/${id}?${params.toString()}`, { replace: true });
    const sid = multiTerminalRef.current?.createSession();
    if (sid) {
      tabOrder.assignOrder(`terminal:${sid}`);
      setActiveTerminalSessionId(sid);
      multiTerminalRef.current?.activateSession(sid);
    }
    setCreateMenuOpen(false);
  };

  const handleSelectWorkspaceTab = (tab: WorkspaceTab) => {
    if (tab.kind === 'terminal') {
      setViewMode('terminal');
      const params = new URLSearchParams(searchParams);
      params.set('view', 'terminal');
      params.delete('sessionId');
      navigate(`/workspaces/${id}?${params.toString()}`, { replace: true });
      multiTerminalRef.current?.activateSession(tab.sessionId);
      return;
    }
    if (tab.status === 'suspended') {
      void handleResumeSession(tab.sessionId);
      return;
    }
    handleAttachSession(tab.sessionId);
  };
  // Kept fresh every render so memoized callers (below) always invoke the
  // latest closure without needing `handleSelectWorkspaceTab` in their deps.
  const handleSelectWorkspaceTabRef = useRef(handleSelectWorkspaceTab);
  handleSelectWorkspaceTabRef.current = handleSelectWorkspaceTab;

  const activeTabId = useMemo(() => {
    if (viewMode === 'terminal') {
      if (activeTerminalSessionId) return `terminal:${activeTerminalSessionId}`;
      const firstTerminalTab = visibleTerminalTabs[0];
      return firstTerminalTab ? `terminal:${firstTerminalTab.id}` : null;
    }
    return activeChatSessionId ? `chat:${activeChatSessionId}` : null;
  }, [activeChatSessionId, activeTerminalSessionId, viewMode, visibleTerminalTabs]);

  const handleCloseWorkspaceTab = (tab: WorkspaceTab) => {
    if (activeTabId === tab.id) {
      const ci = workspaceTabs.findIndex((c) => c.id === tab.id);
      const remaining = workspaceTabs.filter((c) => c.id !== tab.id);
      if (remaining.length > 0) {
        const nextTab = remaining[Math.min(ci, remaining.length - 1)];
        if (!nextTab)
          throw new Error('handleCloseWorkspaceTab: failed to resolve next tab after closing');
        handleSelectWorkspaceTab(nextTab);
      } else {
        setViewMode('terminal');
        setActiveTerminalSessionId(null);
        const params = new URLSearchParams(searchParams);
        params.set('view', 'terminal');
        params.delete('sessionId');
        navigate(`/workspaces/${id}?${params.toString()}`, { replace: true });
      }
    }
    tabOrder.removeTab(tab.id);
    if (tab.kind === 'terminal') {
      multiTerminalRef.current?.closeSession(tab.sessionId);
      return;
    }
    void handleStopSession(tab.sessionId);
  };
  // Kept fresh every render — same rationale as handleSelectWorkspaceTabRef above.
  const handleCloseWorkspaceTabRef = useRef(handleCloseWorkspaceTab);
  handleCloseWorkspaceTabRef.current = handleCloseWorkspaceTab;

  const handleRenameWorkspaceTab = useCallback(
    (tabItem: WorkspaceTabItem, newName: string) => {
      const tab = workspaceTabs.find((t) => t.id === tabItem.id);
      if (!tab) return;
      if (tab.kind === 'terminal') multiTerminalRef.current?.renameSession(tab.sessionId, newName);
      else if (tab.kind === 'chat' && id) {
        setAgentSessions((prev) =>
          prev.map((s) => (s.id === tab.sessionId ? { ...s, label: newName } : s))
        );
        void renameAgentSession(id, tab.sessionId, newName).catch(() => {
          void listAgentSessions(id).then(setAgentSessions);
        });
      }
    },
    [id, workspaceTabs, setAgentSessions]
  );

  const handleSelectTabItem = useCallback(
    (ti: WorkspaceTabItem) => {
      const t = workspaceTabs.find((w) => w.id === ti.id);
      if (t) handleSelectWorkspaceTabRef.current(t);
    },
    [workspaceTabs]
  );
  const handleCloseTabItem = useCallback(
    (ti: WorkspaceTabItem) => {
      const t = workspaceTabs.find((w) => w.id === ti.id);
      if (t) handleCloseWorkspaceTabRef.current(t);
    },
    [workspaceTabs]
  );
  const tabStripItems = useMemo<WorkspaceTabItem[]>(
    () =>
      workspaceTabs.map((t) => ({
        id: t.id,
        kind: t.kind,
        sessionId: t.sessionId,
        title: t.title,
        statusColor: workspaceTabStatusColor(t),
        badge: t.badge,
        dimmed: t.kind === 'chat' && t.status === 'suspended',
      })),
    [workspaceTabs]
  );

  return {
    workspaceTabs,
    activeTabId,
    tabStripItems,
    handleCreateTerminalTab,
    handleSelectWorkspaceTab,
    handleSelectWorkspaceTabRef,
    handleRenameWorkspaceTab,
    handleSelectTabItem,
    handleCloseTabItem,
  };
}
