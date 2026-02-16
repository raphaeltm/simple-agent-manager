import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { Terminal, MultiTerminal } from '@simple-agent-manager/terminal';
import type {
  MultiTerminalHandle,
  MultiTerminalSessionSnapshot,
} from '@simple-agent-manager/terminal';
import { useFeatureFlags } from '../config/features';
import { Button, Spinner, StatusBadge } from '@simple-agent-manager/ui';
import { UserMenu } from '../components/UserMenu';
import { ChatSession } from '../components/ChatSession';
import type { ChatSessionHandle } from '../components/ChatSession';
import { CommandPalette } from '../components/CommandPalette';
import { KeyboardShortcutsHelp } from '../components/KeyboardShortcutsHelp';
import { useIsMobile } from '../hooks/useIsMobile';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { useTabOrder } from '../hooks/useTabOrder';
import { useTokenRefresh } from '../hooks/useTokenRefresh';
import { WorkspaceTabStrip, type WorkspaceTabItem } from '../components/WorkspaceTabStrip';
import { MoreVertical, X } from 'lucide-react';
import { GitChangesButton } from '../components/GitChangesButton';
import { GitChangesPanel } from '../components/GitChangesPanel';
import { GitDiffView } from '../components/GitDiffView';
import { FileBrowserButton } from '../components/FileBrowserButton';
import { FileBrowserPanel } from '../components/FileBrowserPanel';
import { FileViewerPanel } from '../components/FileViewerPanel';
import { WorkspaceSidebar } from '../components/WorkspaceSidebar';
import type { SessionTokenUsage, SidebarTab } from '../components/WorkspaceSidebar';
import {
  createAgentSession,
  getFileIndex,
  getGitStatus,
  getTerminalToken,
  getWorkspace,
  listAgents,
  listAgentSessions,
  listWorkspaceEvents,
  rebuildWorkspace,
  renameAgentSession,
  restartWorkspace,
  stopAgentSession,
  stopWorkspace,
  updateWorkspace,
} from '../lib/api';
import type { GitStatusData } from '../lib/api';
import type { TokenUsage } from '@simple-agent-manager/acp-client';
import type {
  AgentInfo,
  AgentSession,
  Event,
  WorkspaceResponse,
  BootLogEntry,
} from '@simple-agent-manager/shared';
import '../styles/acp-chat.css';


/** View modes */
type ViewMode = 'terminal' | 'conversation';

type WorkspaceTab =
  | {
      id: string;
      kind: 'terminal';
      sessionId: string;
      title: string;
      status: MultiTerminalSessionSnapshot['status'];
    }
  | {
      id: string;
      kind: 'chat';
      sessionId: string;
      title: string;
      status: AgentSession['status'];
    };

const DEFAULT_TERMINAL_TAB_ID = '__default-terminal__';

function workspaceTabStatusColor(tab: WorkspaceTab): string {
  if (tab.kind === 'terminal') {
    switch (tab.status) {
      case 'connecting':
        return '#e0af68';
      case 'connected':
        return '#9ece6a';
      case 'error':
        return '#f7768e';
      default:
        return '#787c99';
    }
  }

  switch (tab.status) {
    case 'running':
      return '#9ece6a';
    case 'error':
      return '#f7768e';
    default:
      return '#787c99';
  }
}

/**
 * Workspace detail page — unified layout for desktop and mobile.
 * Tab strip at top, terminal/chat content below, sidebar on desktop only.
 */
export function Workspace() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const featureFlags = useFeatureFlags();
  const isMobile = useIsMobile();
  const viewParam = searchParams.get('view');
  const sessionIdParam = searchParams.get('sessionId');
  const viewOverride: ViewMode | null =
    viewParam === 'terminal' || viewParam === 'conversation' ? viewParam : null;

  // Git changes panel state (URL-driven for browser back/forward support)
  const gitParam = searchParams.get('git'); // 'changes' | 'diff' | null
  const gitFileParam = searchParams.get('file');
  const gitStagedParam = searchParams.get('staged');

  // File browser state (URL-driven, mutually exclusive with git overlay)
  const filesParam = searchParams.get('files'); // 'browse' | 'view' | null
  const filesPathParam = searchParams.get('path');

  const [workspace, setWorkspace] = useState<WorkspaceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [gitChangeCount, setGitChangeCount] = useState(0);
  const [gitStatus, setGitStatus] = useState<GitStatusData | null>(null);
  const [sessionTokenUsages, setSessionTokenUsages] = useState<SessionTokenUsage[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>(viewOverride ?? 'terminal');
  const [workspaceEvents, setWorkspaceEvents] = useState<Event[]>([]);
  const [agentSessions, setAgentSessions] = useState<AgentSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [displayNameInput, setDisplayNameInput] = useState('');
  const [agentOptions, setAgentOptions] = useState<AgentInfo[]>([]);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [terminalTabs, setTerminalTabs] = useState<MultiTerminalSessionSnapshot[]>([]);
  const [activeTerminalSessionId, setActiveTerminalSessionId] = useState<string | null>(null);
  const [preferredAgentsBySession, setPreferredAgentsBySession] = useState<
    Record<string, AgentInfo['id']>
  >({});
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const multiTerminalRef = useRef<MultiTerminalHandle | null>(null);
  const createMenuRef = useRef<HTMLDivElement | null>(null);
  const chatSessionRefs = useRef<Map<string, ChatSessionHandle>>(new Map());
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [paletteFileIndex, setPaletteFileIndex] = useState<string[]>([]);
  const [paletteFileIndexLoading, setPaletteFileIndexLoading] = useState(false);
  const paletteFileIndexLoaded = useRef(false);

  const tabOrder = useTabOrder<WorkspaceTab>(id);

  const isRunning = workspace?.status === 'running';

  // Proactive token refresh (R3 fix): fetches token on mount and schedules
  // refresh 5 minutes before expiry. On 401 during reconnection, call refresh().
  const tokenRefreshFetchToken = useCallback(async () => {
    if (!id) throw new Error('No workspace ID');
    return getTerminalToken(id);
  }, [id]);

  const {
    token: terminalToken,
    loading: terminalLoading,
    error: tokenRefreshError,
    refresh: refreshTerminalToken,
  } = useTokenRefresh({
    fetchToken: tokenRefreshFetchToken,
    enabled: isRunning && !!id,
  });

  // Propagate token refresh errors to the terminal error display
  useEffect(() => {
    if (tokenRefreshError) {
      setTerminalError(tokenRefreshError);
    }
  }, [tokenRefreshError]);

  const loadWorkspaceState = useCallback(async () => {
    if (!id) {
      return;
    }

    try {
      setError(null);
      const [workspaceData, sessionsData] = await Promise.all([
        getWorkspace(id),
        listAgentSessions(id),
      ]);
      setWorkspace(workspaceData);
      setDisplayNameInput(workspaceData.displayName || workspaceData.name);
      setAgentSessions(sessionsData || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load workspace');
    } finally {
      setLoading(false);
    }
  }, [id]);

  // Load workspace
  useEffect(() => {
    if (!id) return;

    void loadWorkspaceState();

    const interval = setInterval(() => {
      if (
        workspace?.status === 'creating' ||
        workspace?.status === 'stopping' ||
        workspace?.status === 'running'
      ) {
        void loadWorkspaceState();
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [id, workspace?.status, loadWorkspaceState]);

  // Derive WebSocket URL from the proactively-refreshed token (R3 fix).
  // When the token refreshes, the wsUrl updates automatically.
  useEffect(() => {
    if (!workspace?.url || !terminalToken || !isRunning) {
      setWsUrl(null);
      return;
    }

    try {
      const url = new URL(workspace.url);
      const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsPath = featureFlags.multiTerminal ? '/terminal/ws/multi' : '/terminal/ws';
      setWsUrl(`${wsProtocol}//${url.host}${wsPath}?token=${encodeURIComponent(terminalToken)}`);
      setTerminalError(null);
    } catch {
      setWsUrl(null);
      setTerminalError('Invalid workspace URL');
    }
  }, [workspace?.url, terminalToken, isRunning, featureFlags.multiTerminal]);

  // Fetch workspace events directly from the VM Agent (not proxied through control plane)
  useEffect(() => {
    if (!id || !workspace?.url || !terminalToken || workspace.status !== 'running') {
      return;
    }

    const fetchEvents = async () => {
      try {
        const data = await listWorkspaceEvents(workspace.url!, id, terminalToken, 50);
        setWorkspaceEvents(data.events || []);
      } catch {
        // Events are a secondary concern — don't overwrite primary workspace errors.
        // The sidebar will show an empty events list; polling will retry on next tick.
      }
    };

    void fetchEvents();
    const interval = setInterval(() => void fetchEvents(), 10000);
    return () => clearInterval(interval);
  }, [id, workspace?.url, workspace?.status, terminalToken]);

  // Load agent options when running
  useEffect(() => {
    if (!isRunning) {
      setAgentOptions([]);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const data = await listAgents();
        if (!cancelled) {
          setAgentOptions(data.agents || []);
        }
      } catch {
        if (!cancelled) {
          setAgentOptions([]);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isRunning]);

  // Close create menu on outside click
  useEffect(() => {
    if (!createMenuOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (!createMenuRef.current) {
        return;
      }
      const target = event.target as Node | null;
      if (target && !createMenuRef.current.contains(target)) {
        setCreateMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [createMenuOpen]);

  // Close mobile menu on Escape key
  useEffect(() => {
    if (!mobileMenuOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMobileMenuOpen(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [mobileMenuOpen]);

  // Auto-select session from URL on reload
  useEffect(() => {
    if (sessionIdParam && viewMode !== 'conversation') {
      setViewMode('conversation');
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleTerminalActivity = useCallback(() => {
    if (!id) return;
    void loadWorkspaceState();
  }, [id, loadWorkspaceState]);

  const handleUsageChange = useCallback((sessionId: string, usage: TokenUsage) => {
    setSessionTokenUsages((prev) => {
      const idx = prev.findIndex((s) => s.sessionId === sessionId);
      // Find a label from agentSessions
      const session = agentSessions.find((s) => s.id === sessionId);
      const label = session?.label ?? `Chat ${sessionId.slice(-4)}`;
      const entry: SessionTokenUsage = { sessionId, label, usage };
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = entry;
        return next;
      }
      return [...prev, entry];
    });
  }, [agentSessions]);

  const handleStop = async () => {
    if (!id) return;
    try {
      setActionLoading(true);
      await stopWorkspace(id);
      setWorkspace((prev) => (prev ? { ...prev, status: 'stopping' } : null));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop workspace');
    } finally {
      setActionLoading(false);
    }
  };

  const handleRestart = async () => {
    if (!id) return;
    try {
      setActionLoading(true);
      await restartWorkspace(id);
      setWorkspace((prev) => (prev ? { ...prev, status: 'creating' } : null));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to restart workspace');
    } finally {
      setActionLoading(false);
    }
  };

  const handleRebuild = async () => {
    if (!id) return;
    const confirmed = window.confirm(
      'This will rebuild the devcontainer from scratch. Any unsaved terminal state will be lost. Continue?'
    );
    if (!confirmed) return;
    try {
      setActionLoading(true);
      await rebuildWorkspace(id);
      setWorkspace((prev) => (prev ? { ...prev, status: 'creating' } : null));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rebuild workspace');
    } finally {
      setActionLoading(false);
    }
  };

  const handleRename = async () => {
    if (!id || !displayNameInput.trim()) {
      return;
    }
    try {
      setRenaming(true);
      const updated = await updateWorkspace(id, { displayName: displayNameInput.trim() });
      setWorkspace(updated);
      setDisplayNameInput(updated.displayName || updated.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename workspace');
    } finally {
      setRenaming(false);
    }
  };

  // ── Git changes panel navigation ──
  const handleOpenGitChanges = useCallback(() => {
    const params = new URLSearchParams(searchParams);
    // Clear file browser params (mutually exclusive)
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

  // ── File browser navigation ──
  const handleOpenFileBrowser = useCallback(() => {
    const params = new URLSearchParams(searchParams);
    // Clear git params (mutually exclusive)
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
    // Navigate to the parent directory of the current file
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

  // Fetch git change count for the badge (once when terminal is ready)
  useEffect(() => {
    if (!workspace?.url || !terminalToken || !id || !isRunning) return;
    getGitStatus(workspace.url, id, terminalToken)
      .then((data) => {
        setGitStatus(data);
        setGitChangeCount(data.staged.length + data.unstaged.length + data.untracked.length);
      })
      .catch(() => {
        // Silently fail — badge just won't show a count
      });
  }, [workspace?.url, terminalToken, id, isRunning]);

  const configuredAgents = useMemo(
    () => agentOptions.filter((agent) => agent.configured && agent.supportsAcp),
    [agentOptions]
  );

  const agentNameById = useMemo(
    () => new Map(configuredAgents.map((agent) => [agent.id, agent.name])),
    [configuredAgents]
  );

  const activeChatSessionId =
    viewMode === 'conversation'
      ? sessionIdParam || agentSessions.find((session) => session.status === 'running')?.id || null
      : null;

  const handleCreateSession = async (preferredAgentId?: AgentInfo['id']) => {
    if (!id) {
      return;
    }

    try {
      setSessionsLoading(true);
      const preferredAgent = preferredAgentId
        ? configuredAgents.find((agent) => agent.id === preferredAgentId)
        : undefined;

      // Generate a numbered label: count existing running sessions + 1
      const runningCount = agentSessions.filter((s) => s.status === 'running').length;
      const nextNumber = runningCount + 1;
      const label = preferredAgent
        ? `${preferredAgent.name} ${nextNumber}`
        : `Chat ${nextNumber}`;

      const created = await createAgentSession(id, { label });

      setAgentSessions((prev) => {
        const remaining = prev.filter((session) => session.id !== created.id);
        return [...remaining, created];
      });

      tabOrder.assignOrder(`chat:${created.id}`);

      if (preferredAgentId) {
        setPreferredAgentsBySession((prev) => ({ ...prev, [created.id]: preferredAgentId }));
      }

      const params = new URLSearchParams(searchParams);
      params.set('view', 'conversation');
      params.set('sessionId', created.id);
      navigate(`/workspaces/${id}?${params.toString()}`, { replace: true });
      setViewMode('conversation');
      setCreateMenuOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create session');
    } finally {
      setSessionsLoading(false);
    }
  };

  const handleStopSession = async (sessionId: string) => {
    if (!id) {
      return;
    }

    try {
      setSessionsLoading(true);
      await stopAgentSession(id, sessionId);
      const sessions = await listAgentSessions(id);
      setAgentSessions(sessions);
      setPreferredAgentsBySession((prev) => {
        if (!prev[sessionId]) {
          return prev;
        }
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });

      if (sessionIdParam === sessionId) {
        const params = new URLSearchParams(searchParams);
        params.set('view', 'terminal');
        params.delete('sessionId');
        navigate(`/workspaces/${id}?${params.toString()}`, { replace: true });
        setViewMode('terminal');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop session');
    } finally {
      setSessionsLoading(false);
    }
  };

  const handleAttachSession = (sessionId: string) => {
    if (!id) {
      return;
    }
    const params = new URLSearchParams(searchParams);
    params.set('view', 'conversation');
    params.set('sessionId', sessionId);
    navigate(`/workspaces/${id}?${params.toString()}`, { replace: true });
    setViewMode('conversation');
  };

  const handleCreateTerminalTab = () => {
    setViewMode('terminal');
    const params = new URLSearchParams(searchParams);
    params.set('view', 'terminal');
    params.delete('sessionId');
    navigate(`/workspaces/${id}?${params.toString()}`, { replace: true });
    const sessionId = multiTerminalRef.current?.createSession();
    if (sessionId) {
      tabOrder.assignOrder(`terminal:${sessionId}`);
      setActiveTerminalSessionId(sessionId);
      multiTerminalRef.current?.activateSession(sessionId);
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
      if (tab.sessionId !== DEFAULT_TERMINAL_TAB_ID) {
        multiTerminalRef.current?.activateSession(tab.sessionId);
      }
      return;
    }

    handleAttachSession(tab.sessionId);
  };

  const handleCloseWorkspaceTab = (tab: WorkspaceTab) => {
    tabOrder.removeTab(tab.id);

    if (tab.kind === 'terminal') {
      if (tab.sessionId !== DEFAULT_TERMINAL_TAB_ID) {
        multiTerminalRef.current?.closeSession(tab.sessionId);
      }
      return;
    }

    void handleStopSession(tab.sessionId);
  };

  const defaultAgentId = configuredAgents.length === 1 ? configuredAgents[0]!.id : null;
  const defaultAgentName = defaultAgentId ? agentNameById.get(defaultAgentId) ?? null : null;

  const visibleTerminalTabs = useMemo<MultiTerminalSessionSnapshot[]>(() => {
    if (terminalTabs.length > 0) {
      return terminalTabs;
    }
    if (!isRunning || !featureFlags.multiTerminal) {
      return [];
    }
    return [
      {
        id: DEFAULT_TERMINAL_TAB_ID,
        name: 'Terminal 1',
        status: terminalError ? 'error' : terminalLoading ? 'connecting' : wsUrl ? 'connected' : 'disconnected',
      },
    ];
  }, [
    featureFlags.multiTerminal,
    isRunning,
    terminalError,
    terminalLoading,
    terminalTabs,
    wsUrl,
  ]);

  const workspaceTabs = useMemo<WorkspaceTab[]>(() => {
    const terminalSessionTabs: WorkspaceTab[] = visibleTerminalTabs.map((session) => ({
      id: `terminal:${session.id}`,
      kind: 'terminal',
      sessionId: session.id,
      title: session.name,
      status: session.status,
    }));

    const chatSessionTabs: WorkspaceTab[] = agentSessions
      .filter((session) => session.status === 'running')
      .map((session) => {
        const preferredAgent = preferredAgentsBySession[session.id];
        const preferredName = preferredAgent ? agentNameById.get(preferredAgent) : undefined;
        const title =
          session.label?.trim() ||
          (preferredName ? `${preferredName} Chat` : `Chat ${session.id.slice(-4)}`);

        return {
          id: `chat:${session.id}`,
          kind: 'chat',
          sessionId: session.id,
          title,
          status: session.status,
        };
      });

    return tabOrder.getSortedTabs([...terminalSessionTabs, ...chatSessionTabs]);
  }, [agentNameById, agentSessions, preferredAgentsBySession, tabOrder, visibleTerminalTabs]);

  const handleRenameWorkspaceTab = useCallback(
    (tabItem: WorkspaceTabItem, newName: string) => {
      const tab = workspaceTabs.find((t) => t.id === tabItem.id);
      if (!tab) return;

      if (tab.kind === 'terminal') {
        multiTerminalRef.current?.renameSession(tab.sessionId, newName);
      } else if (tab.kind === 'chat' && id) {
        // Update local state immediately for responsiveness
        setAgentSessions((prev) =>
          prev.map((s) => (s.id === tab.sessionId ? { ...s, label: newName } : s))
        );
        // Persist via API (fire-and-forget; local state is already updated)
        void renameAgentSession(id, tab.sessionId, newName).catch(() => {
          // Revert on failure — reload sessions from server
          void listAgentSessions(id).then(setAgentSessions);
        });
      }
    },
    [id, workspaceTabs]
  );

  const activeTabId = useMemo(() => {
    if (viewMode === 'terminal') {
      if (activeTerminalSessionId) {
        return `terminal:${activeTerminalSessionId}`;
      }
      if (visibleTerminalTabs.length > 0) {
        return `terminal:${visibleTerminalTabs[0]!.id}`;
      }
      return null;
    }
    return activeChatSessionId ? `chat:${activeChatSessionId}` : null;
  }, [activeChatSessionId, activeTerminalSessionId, viewMode, visibleTerminalTabs]);

  const handleSelectTabItem = useCallback(
    (tabItem: WorkspaceTabItem) => {
      const tab = workspaceTabs.find((t) => t.id === tabItem.id);
      if (tab) handleSelectWorkspaceTab(tab);
    },
    [workspaceTabs] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const handleCloseTabItem = useCallback(
    (tabItem: WorkspaceTabItem) => {
      const tab = workspaceTabs.find((t) => t.id === tabItem.id);
      if (tab) handleCloseWorkspaceTab(tab);
    },
    [workspaceTabs] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const tabStripItems = useMemo<WorkspaceTabItem[]>(
    () =>
      workspaceTabs.map((tab) => ({
        id: tab.id,
        kind: tab.kind,
        sessionId: tab.sessionId,
        title: tab.title,
        statusColor: workspaceTabStatusColor(tab),
      })),
    [workspaceTabs]
  );

  // Running chat sessions (for rendering ChatSession components)
  const runningChatSessions = useMemo(
    () => agentSessions.filter((s) => s.status === 'running'),
    [agentSessions]
  );

  // ── Keyboard shortcuts ──
  // The hook stores handlers via a ref internally, so it's safe to pass an
  // inline object here — no useMemo needed, and no stale closure issues.
  // Extracted into a variable so the same handlers can be shared with CommandPalette.
  const shortcutHandlers = {
    'toggle-file-browser': () => {
      if (!isRunning || !terminalToken) return;
      if (filesParam) handleCloseFileBrowser();
      else handleOpenFileBrowser();
    },
    'toggle-git-changes': () => {
      if (!isRunning || !terminalToken) return;
      if (gitParam) handleCloseGitPanel();
      else handleOpenGitChanges();
    },
    'focus-chat': () => {
      if (activeChatSessionId) {
        if (viewMode !== 'conversation') {
          handleAttachSession(activeChatSessionId);
        }
        // Small delay to let the view switch render before focusing
        requestAnimationFrame(() => {
          chatSessionRefs.current.get(activeChatSessionId)?.focusInput();
        });
      }
    },
    'focus-terminal': () => {
      if (viewMode !== 'terminal') {
        const firstTermTab = workspaceTabs.find((t) => t.kind === 'terminal');
        if (firstTermTab) handleSelectWorkspaceTab(firstTermTab);
      }
      requestAnimationFrame(() => {
        multiTerminalRef.current?.focus();
      });
    },
    'next-tab': () => {
      if (workspaceTabs.length <= 1) return;
      const currentIdx = workspaceTabs.findIndex((t) => t.id === activeTabId);
      const nextIdx = currentIdx < 0 ? 0 : (currentIdx + 1) % workspaceTabs.length;
      handleSelectWorkspaceTab(workspaceTabs[nextIdx]!);
    },
    'prev-tab': () => {
      if (workspaceTabs.length <= 1) return;
      const currentIdx = workspaceTabs.findIndex((t) => t.id === activeTabId);
      const prevIdx =
        currentIdx <= 0 ? workspaceTabs.length - 1 : currentIdx - 1;
      handleSelectWorkspaceTab(workspaceTabs[prevIdx]!);
    },
    ...Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [
        `tab-${i + 1}`,
        () => {
          if (i < workspaceTabs.length) {
            handleSelectWorkspaceTab(workspaceTabs[i]!);
          }
        },
      ])
    ),
    'new-chat': () => {
      if (!isRunning) return;
      void handleCreateSession(defaultAgentId ?? undefined);
    },
    'new-terminal': () => {
      if (!isRunning) return;
      handleCreateTerminalTab();
    },
    'command-palette': () => {
      setShowCommandPalette((prev) => !prev);
      setShowShortcutsHelp(false);
    },
    'show-shortcuts': () => {
      setShowShortcutsHelp((prev) => !prev);
    },
  };
  useKeyboardShortcuts(shortcutHandlers, isRunning);

  // ── Palette: lazy-load file index when palette opens ──
  useEffect(() => {
    if (!showCommandPalette || paletteFileIndexLoaded.current) return;
    if (!workspace?.url || !terminalToken || !id || !isRunning) return;

    paletteFileIndexLoaded.current = true;
    setPaletteFileIndexLoading(true);
    getFileIndex(workspace.url, id, terminalToken)
      .then((files) => setPaletteFileIndex(files))
      .catch((err) => console.warn('[palette] Failed to load file index:', err))
      .finally(() => setPaletteFileIndexLoading(false));
  }, [showCommandPalette, workspace?.url, terminalToken, id, isRunning]);

  const handlePaletteSelectTab = useCallback(
    (tab: WorkspaceTabItem) => {
      // Find the matching WorkspaceTab and select it
      const wsTab = workspaceTabs.find((t) => t.id === tab.id);
      if (wsTab) {
        handleSelectWorkspaceTab(wsTab);
        // Focus the selected tab content
        if (wsTab.kind === 'terminal') {
          multiTerminalRef.current?.focus?.();
        } else if (wsTab.kind === 'chat') {
          const chatRef = chatSessionRefs.current.get(wsTab.sessionId);
          chatRef?.focusInput?.();
        }
      }
    },
    [workspaceTabs, handleSelectWorkspaceTab]
  );

  const handlePaletteSelectFile = useCallback(
    (filePath: string) => {
      handleFileViewerOpen(filePath);
    },
    [handleFileViewerOpen]
  );

  // ── Loading state ──
  if (loading) {
    return (
      <div
        style={{
          height: 'var(--sam-app-height)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#1a1b26',
        }}
      >
        <Spinner size="lg" />
      </div>
    );
  }

  // ── Fatal error (no workspace loaded) ──
  if (error && !workspace) {
    return (
      <div
        style={{
          height: 'var(--sam-app-height)',
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: '#1a1b26',
        }}
      >
        <Toolbar onBack={() => navigate('/dashboard')} />
        <CenteredStatus
          color="#f87171"
          title="Failed to Load Workspace"
          subtitle={error}
          action={
            <Button variant="ghost" size="sm" onClick={() => navigate('/dashboard')}>
              Back to Dashboard
            </Button>
          }
        />
      </div>
    );
  }

  // ── Terminal content (always rendered when running, hidden when chat is active) ──
  const terminalContent = (
    <div style={{ height: '100%', display: viewMode === 'terminal' ? 'block' : 'none' }}>
      {wsUrl ? (
        featureFlags.multiTerminal ? (
          <MultiTerminal
            ref={multiTerminalRef}
            wsUrl={wsUrl}
            shutdownDeadline={workspace?.shutdownDeadline}
            onActivity={handleTerminalActivity}
            className="h-full"
            persistenceKey={id ? `sam-terminal-sessions-${id}` : undefined}
            hideTabBar
            onSessionsChange={(sessions, activeSessionId) => {
              setTerminalTabs(sessions);
              setActiveTerminalSessionId(activeSessionId);
            }}
          />
        ) : (
          <Terminal
            wsUrl={wsUrl}
            shutdownDeadline={workspace?.shutdownDeadline}
            onActivity={handleTerminalActivity}
            className="h-full"
          />
        )
      ) : terminalLoading ? (
        <CenteredStatus
          color="#60a5fa"
          title="Connecting to Terminal..."
          subtitle="Establishing secure connection"
          loading
        />
      ) : (
        <CenteredStatus
          color="#f87171"
          title="Connection Failed"
          subtitle={terminalError || 'Unable to connect to terminal'}
          action={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void refreshTerminalToken();
              }}
              disabled={terminalLoading}
            >
              Retry Connection
            </Button>
          }
        />
      )}
    </div>
  );

  // ── Non-running states content ──
  const statusContent = !isRunning ? (
    workspace?.status === 'creating' ? (
      <BootProgress logs={workspace.bootLogs} />
    ) : workspace?.status === 'stopping' ? (
      <CenteredStatus color="#fbbf24" title="Stopping Workspace" loading />
    ) : workspace?.status === 'stopped' ? (
      <CenteredStatus
        color="var(--sam-color-fg-muted)"
        title="Workspace Stopped"
        subtitle="Restart to access the terminal."
        action={
          <Button
            variant="primary"
            size="sm"
            onClick={handleRestart}
            disabled={actionLoading}
            loading={actionLoading}
          >
            Restart Workspace
          </Button>
        }
      />
    ) : workspace?.status === 'error' ? (
      <CenteredStatus
        color="#f87171"
        title="Workspace Error"
        subtitle={workspace?.errorMessage || 'An unexpected error occurred.'}
        action={
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'center' }}>
            <Button
              variant="primary"
              size="sm"
              onClick={handleRebuild}
              disabled={actionLoading}
              loading={actionLoading}
            >
              Rebuild Container
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={handleRestart}
              disabled={actionLoading}
              loading={actionLoading}
            >
              Restart Workspace
            </Button>
          </div>
        }
      />
    ) : null
  ) : null;

  // ── Tab strip (shown on both desktop and mobile when running) ──
  const createMenuContent = (
    <div ref={createMenuRef} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        onClick={() => setCreateMenuOpen((prev) => !prev)}
        disabled={sessionsLoading}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: isMobile ? 42 : 36,
          height: '100%',
          background: 'none',
          border: 'none',
          borderLeft: '1px solid #2a2d3a',
          color: '#787c99',
          cursor: sessionsLoading ? 'not-allowed' : 'pointer',
          fontSize: 18,
          fontWeight: 300,
          padding: 0,
          opacity: sessionsLoading ? 0.6 : 1,
        }}
        aria-label="Create terminal or chat session"
        aria-expanded={createMenuOpen}
      >
        +
      </button>

      {createMenuOpen && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            minWidth: 220,
            borderRadius: 'var(--sam-radius-md)',
            border: '1px solid var(--sam-color-border-default)',
            background: 'var(--sam-color-bg-surface)',
            boxShadow: '0 10px 30px rgba(0, 0, 0, 0.35)',
            zIndex: 30,
            overflow: 'hidden',
          }}
        >
          <button
            onClick={handleCreateTerminalTab}
            disabled={sessionsLoading}
            style={{
              width: '100%',
              textAlign: 'left',
              border: 'none',
              background: 'transparent',
              color: 'var(--sam-color-fg-primary)',
              padding: isMobile ? '14px 16px' : '10px 12px',
              fontSize: isMobile ? '0.875rem' : '0.8125rem',
              cursor: sessionsLoading ? 'not-allowed' : 'pointer',
              opacity: sessionsLoading ? 0.65 : 1,
            }}
          >
            Terminal
          </button>

          {configuredAgents.length <= 1 ? (
            <button
              onClick={() => {
                void handleCreateSession(defaultAgentId ?? undefined);
              }}
              disabled={configuredAgents.length === 0 || sessionsLoading}
              style={{
                width: '100%',
                textAlign: 'left',
                border: 'none',
                background: 'transparent',
                color:
                  configuredAgents.length === 0 || sessionsLoading
                    ? 'var(--sam-color-fg-muted)'
                    : 'var(--sam-color-fg-primary)',
                padding: isMobile ? '14px 16px' : '10px 12px',
                fontSize: isMobile ? '0.875rem' : '0.8125rem',
                cursor:
                  configuredAgents.length === 0 || sessionsLoading ? 'not-allowed' : 'pointer',
                opacity: configuredAgents.length === 0 || sessionsLoading ? 0.65 : 1,
              }}
            >
              {defaultAgentName ?? 'Chat'}
            </button>
          ) : (
            configuredAgents.map((agent) => (
              <button
                key={agent.id}
                onClick={() => {
                  void handleCreateSession(agent.id);
                }}
                disabled={sessionsLoading}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--sam-color-fg-primary)',
                  padding: isMobile ? '14px 16px' : '10px 12px',
                  fontSize: isMobile ? '0.875rem' : '0.8125rem',
                  cursor: sessionsLoading ? 'not-allowed' : 'pointer',
                  opacity: sessionsLoading ? 0.65 : 1,
                }}
              >
                {agent.name}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );

  const workspaceTabStrip = isRunning ? (
    <WorkspaceTabStrip
      tabs={tabStripItems}
      activeTabId={activeTabId}
      isMobile={isMobile}
      onSelect={handleSelectTabItem}
      onClose={handleCloseTabItem}
      onRename={handleRenameWorkspaceTab}
      onReorder={tabOrder.reorderTab}
      createMenuSlot={createMenuContent}
      unclosableTabId={`terminal:${DEFAULT_TERMINAL_TAB_ID}`}
    />
  ) : null;

  // ── Sidebar content (shared between desktop sidebar and mobile overlay) ──
  const sidebarContent = (
    <WorkspaceSidebar
      workspace={workspace}
      isRunning={isRunning}
      isMobile={isMobile}
      actionLoading={actionLoading}
      onStop={handleStop}
      onRestart={handleRestart}
      onRebuild={handleRebuild}
      displayNameInput={displayNameInput}
      onDisplayNameChange={setDisplayNameInput}
      onRename={handleRename}
      renaming={renaming}
      workspaceTabs={workspaceTabs}
      activeTabId={activeTabId}
      onSelectTab={(tab: SidebarTab) => {
        const found = workspaceTabs.find((t) => t.id === tab.id);
        if (found) handleSelectWorkspaceTab(found);
      }}
      gitStatus={gitStatus}
      onOpenGitChanges={handleOpenGitChanges}
      sessionTokenUsages={sessionTokenUsages}
      workspaceEvents={workspaceEvents}
    />
  );

  // ══════════════════════════════════════════════════════════════
  // UNIFIED LAYOUT (responsive for desktop and mobile)
  // ══════════════════════════════════════════════════════════════
  return (
    <div
      style={{
        height: 'var(--sam-app-height)',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: '#1a1b26',
        overflow: 'hidden',
      }}
    >
      {/* ── Header ── */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: isMobile ? '0 4px 0 4px' : '0 12px',
          height: isMobile ? '44px' : '40px',
          backgroundColor: 'var(--sam-color-bg-surface)',
          borderBottom: '1px solid var(--sam-color-border-default)',
          gap: isMobile ? '4px' : '10px',
          flexShrink: 0,
        }}
      >
        {/* Back */}
        <button
          onClick={() => navigate('/dashboard')}
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
          aria-label="Back to dashboard"
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
        <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? '4px' : '8px', minWidth: 0, flex: isMobile ? 1 : undefined }}>
          <span
            style={{
              fontWeight: 600,
              fontSize: '0.875rem',
              color: 'var(--sam-color-fg-primary)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              maxWidth: isMobile ? '140px' : undefined,
            }}
          >
            {workspace?.displayName || workspace?.name}
          </span>
          {workspace && <StatusBadge status={workspace.status} />}
        </div>

        {/* Repo@branch (desktop only) */}
        {!isMobile && (
          <>
            <div
              style={{
                width: '1px',
                height: '16px',
                backgroundColor: 'var(--sam-color-border-default)',
                flexShrink: 0,
              }}
            />
            <span
              style={{
                fontSize: '0.75rem',
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
          </>
        )}

        {/* Spacer */}
        <div style={{ flex: isMobile ? undefined : 1 }} />

        {/* Error inline (desktop only — too noisy on mobile) */}
        {!isMobile && error && (
          <span style={{ fontSize: '0.75rem', color: '#f87171', whiteSpace: 'nowrap' }}>
            {error}
            <button
              onClick={() => setError(null)}
              style={{
                background: 'none',
                border: 'none',
                color: '#f87171',
                cursor: 'pointer',
                marginLeft: '4px',
                fontSize: '0.75rem',
              }}
            >
              x
            </button>
          </span>
        )}

        {/* File browser button */}
        {isRunning && terminalToken && (
          <FileBrowserButton
            onClick={handleOpenFileBrowser}
            isMobile={isMobile}
          />
        )}

        {/* Git changes button */}
        {isRunning && terminalToken && (
          <GitChangesButton
            onClick={handleOpenGitChanges}
            changeCount={gitChangeCount}
            isMobile={isMobile}
          />
        )}

        {/* Mobile sidebar menu button */}
        {isMobile && (
          <button
            onClick={() => setMobileMenuOpen(true)}
            aria-label="Open workspace menu"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--sam-color-fg-muted)',
              padding: '8px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              minWidth: 44,
              minHeight: 44,
              flexShrink: 0,
            }}
          >
            <MoreVertical size={18} />
          </button>
        )}

        {/* User menu */}
        <UserMenu />
      </header>

      {/* ── Mobile error banner ── */}
      {isMobile && error && (
        <div
          style={{
            padding: '6px 12px',
            backgroundColor: 'rgba(248, 113, 113, 0.15)',
            borderBottom: '1px solid rgba(248, 113, 113, 0.3)',
            fontSize: '0.75rem',
            color: '#f87171',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexShrink: 0,
          }}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{error}</span>
          <button
            onClick={() => setError(null)}
            style={{
              background: 'none',
              border: 'none',
              color: '#f87171',
              cursor: 'pointer',
              padding: '4px 8px',
              fontSize: '0.875rem',
              flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>
      )}

      {/* ── Content area ── */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {workspaceTabStrip}
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
            {isRunning ? (
              <>
                {/* Terminal content — always mounted, shown/hidden */}
                {terminalContent}

                {/* Chat sessions — each has its own independent ACP WebSocket */}
                {id && workspace?.url && runningChatSessions.map((session) => (
                  <ChatSession
                    key={session.id}
                    ref={(handle) => {
                      if (handle) chatSessionRefs.current.set(session.id, handle);
                      else chatSessionRefs.current.delete(session.id);
                    }}
                    workspaceId={id}
                    workspaceUrl={workspace.url!}
                    sessionId={session.id}
                    preferredAgentId={
                      preferredAgentsBySession[session.id] ||
                      (configuredAgents.length > 0 ? configuredAgents[0]!.id : undefined)
                    }
                    configuredAgents={configuredAgents}
                    active={viewMode === 'conversation' && activeChatSessionId === session.id}
                    onActivity={handleTerminalActivity}
                    onUsageChange={handleUsageChange}
                  />
                ))}
              </>
            ) : (
              statusContent
            )}
          </div>
        </div>

        {/* ── Sidebar (desktop only) ── */}
        {!isMobile && (
          <aside
            style={{
              width: 320,
              minWidth: 320,
              borderLeft: '1px solid var(--sam-color-border-default)',
              background: 'var(--sam-color-bg-surface)',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {sidebarContent}
          </aside>
        )}
      </div>

      {/* ── Mobile sidebar overlay ── */}
      {isMobile && mobileMenuOpen && (
        <>
          {/* Backdrop */}
          <div
            data-testid="mobile-menu-backdrop"
            onClick={() => setMobileMenuOpen(false)}
            style={{
              position: 'fixed',
              inset: 0,
              backgroundColor: 'rgba(0, 0, 0, 0.5)',
              zIndex: 50,
            }}
          />
          {/* Panel (slides from right) */}
          <div
            role="dialog"
            aria-label="Workspace menu"
            data-testid="mobile-menu-panel"
            style={{
              position: 'fixed',
              top: 0,
              right: 0,
              bottom: 0,
              width: '85vw',
              maxWidth: 360,
              backgroundColor: 'var(--sam-color-bg-surface)',
              borderLeft: '1px solid var(--sam-color-border-default)',
              zIndex: 51,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            {/* Close button header */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: 'var(--sam-space-3) var(--sam-space-4)',
                borderBottom: '1px solid var(--sam-color-border-default)',
                flexShrink: 0,
              }}
            >
              <span
                style={{
                  fontWeight: 600,
                  fontSize: '0.875rem',
                  color: 'var(--sam-color-fg-primary)',
                }}
              >
                Workspace
              </span>
              <button
                onClick={() => setMobileMenuOpen(false)}
                aria-label="Close workspace menu"
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--sam-color-fg-muted)',
                  padding: '8px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  minWidth: 44,
                  minHeight: 44,
                }}
              >
                <X size={18} />
              </button>
            </div>
            {/* Scrollable sidebar content */}
            <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
              {sidebarContent}
            </div>
          </div>
        </>
      )}

      {/* ── Git changes overlay ── */}
      {gitParam === 'changes' && terminalToken && workspace?.url && id && (
        <GitChangesPanel
          workspaceUrl={workspace.url}
          workspaceId={id}
          token={terminalToken}
          isMobile={isMobile}
          onClose={handleCloseGitPanel}
          onSelectFile={handleNavigateToGitDiff}
        />
      )}
      {gitParam === 'diff' && gitFileParam && terminalToken && workspace?.url && id && (
        <GitDiffView
          workspaceUrl={workspace.url}
          workspaceId={id}
          token={terminalToken}
          filePath={gitFileParam}
          staged={gitStagedParam === 'true'}
          isMobile={isMobile}
          onBack={handleBackFromGitDiff}
          onClose={handleCloseGitPanel}
        />
      )}

      {/* ── File browser overlay ── */}
      {filesParam === 'browse' && terminalToken && workspace?.url && id && (
        <FileBrowserPanel
          workspaceUrl={workspace.url}
          workspaceId={id}
          token={terminalToken}
          initialPath={filesPathParam ?? '.'}
          isMobile={isMobile}
          onClose={handleCloseFileBrowser}
          onSelectFile={handleFileViewerOpen}
          onNavigate={handleFileBrowserNavigate}
        />
      )}
      {filesParam === 'view' && filesPathParam && terminalToken && workspace?.url && id && (
        <FileViewerPanel
          workspaceUrl={workspace.url}
          workspaceId={id}
          token={terminalToken}
          filePath={filesPathParam}
          isMobile={isMobile}
          onBack={handleFileViewerBack}
          onClose={handleCloseFileBrowser}
          onViewDiff={handleFileViewerToDiff}
        />
      )}

      {/* ── Keyboard shortcuts help overlay ── */}
      {showShortcutsHelp && (
        <KeyboardShortcutsHelp onClose={() => setShowShortcutsHelp(false)} />
      )}

      {/* ── Command palette overlay ── */}
      {showCommandPalette && (
        <CommandPalette
          onClose={() => setShowCommandPalette(false)}
          handlers={shortcutHandlers}
          tabs={tabStripItems}
          fileIndex={paletteFileIndex}
          fileIndexLoading={paletteFileIndexLoading}
          onSelectTab={handlePaletteSelectTab}
          onSelectFile={handlePaletteSelectFile}
        />
      )}
    </div>
  );
}

// ── Minimal sub-components ──

function Toolbar({ onBack }: { onBack: () => void }) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        padding: '0 12px',
        height: '40px',
        backgroundColor: 'var(--sam-color-bg-surface)',
        borderBottom: '1px solid var(--sam-color-border-default)',
        gap: '10px',
        flexShrink: 0,
      }}
    >
      <button
        onClick={onBack}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--sam-color-fg-muted)',
          padding: '4px',
          display: 'flex',
        }}
      >
        <svg
          style={{ height: 16, width: 16 }}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
      </button>
      <span style={{ fontWeight: 600, fontSize: '0.875rem', color: 'var(--sam-color-fg-primary)' }}>
        Workspace
      </span>
    </header>
  );
}

function CenteredStatus({
  color,
  title,
  subtitle,
  action,
  loading: isLoading,
}: {
  color: string;
  title: string;
  subtitle?: string | null;
  action?: React.ReactNode;
  loading?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        gap: '12px',
        backgroundColor: '#1a1b26',
        color: '#a9b1d6',
      }}
    >
      {isLoading && <Spinner size="lg" />}
      <h3 style={{ fontSize: '1rem', fontWeight: 600, color, margin: 0 }}>{title}</h3>
      {subtitle && (
        <p
          style={{
            fontSize: '0.875rem',
            color: '#787c99',
            margin: 0,
            maxWidth: '400px',
            textAlign: 'center',
          }}
        >
          {subtitle}
        </p>
      )}
      {action && <div style={{ marginTop: '4px' }}>{action}</div>}
    </div>
  );
}

function BootProgress({ logs }: { logs?: BootLogEntry[] }) {
  if (!logs || logs.length === 0) {
    return (
      <CenteredStatus
        color="#60a5fa"
        title="Creating Workspace"
        subtitle="Initializing..."
        loading
      />
    );
  }

  // Deduplicate: show latest status per step
  const stepMap = new Map<string, BootLogEntry>();
  for (const log of logs) {
    stepMap.set(log.step, log);
  }
  const steps = Array.from(stepMap.values());

  const statusIcon = (status: BootLogEntry['status']) => {
    switch (status) {
      case 'completed':
        return (
          <span style={{ color: '#4ade80', marginRight: 8, fontSize: '0.875rem' }}>&#10003;</span>
        );
      case 'failed':
        return (
          <span style={{ color: '#f87171', marginRight: 8, fontSize: '0.875rem' }}>&#10007;</span>
        );
      case 'started':
      default:
        return (
          <span style={{ marginRight: 8, display: 'inline-flex' }}>
            <Spinner size="sm" />
          </span>
        );
    }
  };

  const lastStep = steps[steps.length - 1];
  const hasFailed = lastStep?.status === 'failed';

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        backgroundColor: '#1a1b26',
        color: '#a9b1d6',
        padding: '24px',
      }}
    >
      <h3
        style={{
          fontSize: '1rem',
          fontWeight: 600,
          color: hasFailed ? '#f87171' : '#60a5fa',
          margin: '0 0 16px 0',
        }}
      >
        {hasFailed ? 'Provisioning Failed' : 'Creating Workspace'}
      </h3>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
          maxWidth: '400px',
          width: '100%',
        }}
      >
        {steps.map((entry, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              alignItems: 'center',
              fontSize: '0.8125rem',
              color:
                entry.status === 'failed'
                  ? '#f87171'
                  : entry.status === 'completed'
                    ? '#787c99'
                    : '#a9b1d6',
            }}
          >
            {statusIcon(entry.status)}
            <span>{entry.message}</span>
          </div>
        ))}
      </div>
      {lastStep?.status === 'failed' && lastStep.detail && (
        <p
          style={{
            fontSize: '0.75rem',
            color: '#787c99',
            margin: '12px 0 0',
            maxWidth: '400px',
            textAlign: 'center',
            wordBreak: 'break-word',
          }}
        >
          {lastStep.detail}
        </p>
      )}
    </div>
  );
}
