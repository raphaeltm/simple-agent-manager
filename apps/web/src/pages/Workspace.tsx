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
import { useIsMobile } from '../hooks/useIsMobile';
import { MoreVertical, X } from 'lucide-react';
import {
  ApiClientError,
  createAgentSession,
  getTerminalToken,
  getWorkspace,
  listAgents,
  listAgentSessions,
  listWorkspaceEvents,
  rebuildWorkspace,
  restartWorkspace,
  stopAgentSession,
  stopWorkspace,
  updateWorkspace,
} from '../lib/api';
import type {
  AgentInfo,
  AgentSession,
  Event,
  WorkspaceResponse,
  BootLogEntry,
} from '@simple-agent-manager/shared';
import '../styles/acp-chat.css';

function terminalConnectionErrorMessage(err: unknown): string {
  if (err instanceof ApiClientError) {
    if (err.status === 401 || err.status === 403) {
      return 'Your session expired. Sign in again, then retry the terminal connection.';
    }
    if (err.status === 404) {
      return 'Workspace connection endpoint is not ready yet. Retry in a few seconds.';
    }
    if (err.status >= 500) {
      return 'Terminal service is temporarily unavailable. Please retry.';
    }
  }

  return 'Unable to establish terminal connection right now. Please retry.';
}

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
  const [workspace, setWorkspace] = useState<WorkspaceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const [terminalLoading, setTerminalLoading] = useState(false);
  const [terminalError, setTerminalError] = useState<string | null>(null);
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
  const [hoveredWorkspaceTabId, setHoveredWorkspaceTabId] = useState<string | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const multiTerminalRef = useRef<MultiTerminalHandle | null>(null);
  const createMenuRef = useRef<HTMLDivElement | null>(null);

  const isRunning = workspace?.status === 'running';

  const loadWorkspaceState = useCallback(async () => {
    if (!id) {
      return;
    }

    try {
      setError(null);
      const [workspaceData, eventsData, sessionsData] = await Promise.all([
        getWorkspace(id),
        listWorkspaceEvents(id, 50),
        listAgentSessions(id),
      ]);
      setWorkspace(workspaceData);
      setDisplayNameInput(workspaceData.displayName || workspaceData.name);
      setWorkspaceEvents(eventsData.events || []);
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

  const connectTerminal = useCallback(async () => {
    if (!id || !workspace?.url || workspace.status !== 'running') {
      return;
    }

    try {
      setTerminalLoading(true);
      setTerminalError(null);

      const { token } = await getTerminalToken(id);
      const url = new URL(workspace.url);
      const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsPath = featureFlags.multiTerminal ? '/terminal/ws/multi' : '/terminal/ws';
      setWsUrl(`${wsProtocol}//${url.host}${wsPath}?token=${encodeURIComponent(token)}`);
    } catch (err) {
      setWsUrl(null);
      setTerminalError(terminalConnectionErrorMessage(err));
    } finally {
      setTerminalLoading(false);
    }
  }, [id, workspace?.status, workspace?.url, featureFlags.multiTerminal]);

  // Fetch terminal token and build WebSocket URL
  useEffect(() => {
    if (!id || !workspace || workspace.status !== 'running' || !workspace.url) {
      setWsUrl(null);
      setTerminalError(null);
      return;
    }

    void connectTerminal();
  }, [id, workspace?.status, workspace?.url, connectTerminal]);

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
      const key =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random()}`;
      const preferredAgent = preferredAgentId
        ? configuredAgents.find((agent) => agent.id === preferredAgentId)
        : undefined;

      const created = await createAgentSession(
        id,
        preferredAgent ? { label: `${preferredAgent.name} Chat` } : {},
        key
      );

      setAgentSessions((prev) => {
        const remaining = prev.filter((session) => session.id !== created.id);
        return [created, ...remaining];
      });

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

    return [...terminalSessionTabs, ...chatSessionTabs];
  }, [agentNameById, agentSessions, preferredAgentsBySession, visibleTerminalTabs]);

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

  // Running chat sessions (for rendering ChatSession components)
  const runningChatSessions = useMemo(
    () => agentSessions.filter((s) => s.status === 'running'),
    [agentSessions]
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
                void connectTerminal();
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
  const workspaceTabStrip = isRunning ? (
    <div
      style={{
        display: 'flex',
        alignItems: 'stretch',
        backgroundColor: '#16171e',
        borderBottom: '1px solid #2a2d3a',
        height: isMobile ? 42 : 38,
        flexShrink: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'stretch',
          overflowX: 'auto',
          flex: 1,
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
          WebkitOverflowScrolling: 'touch',
        }}
        role="tablist"
        aria-label="Workspace sessions"
      >
        {workspaceTabs.map((tab) => {
          const active = activeTabId === tab.id;
          const statusColor = workspaceTabStatusColor(tab);
          const hovered = hoveredWorkspaceTabId === tab.id;
          const canClose = tab.kind === 'chat' || tab.sessionId !== DEFAULT_TERMINAL_TAB_ID;

          return (
            <div
              key={tab.id}
              onClick={() => handleSelectWorkspaceTab(tab)}
              onMouseEnter={() => setHoveredWorkspaceTabId(tab.id)}
              onMouseLeave={() => setHoveredWorkspaceTabId((prev) => (prev === tab.id ? null : prev))}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  handleSelectWorkspaceTab(tab);
                }
              }}
              role="tab"
              aria-selected={active}
              aria-label={`${tab.kind === 'terminal' ? 'Terminal' : 'Chat'} tab: ${tab.title}`}
              tabIndex={0}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: isMobile ? 4 : 6,
                padding: isMobile ? '0 10px' : '0 12px',
                minWidth: isMobile ? 80 : 100,
                maxWidth: isMobile ? 150 : 180,
                cursor: 'pointer',
                fontSize: isMobile ? 12 : 13,
                fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                border: 'none',
                borderRight: '1px solid #2a2d3a',
                position: 'relative',
                flexShrink: 0,
                whiteSpace: 'nowrap',
                backgroundColor: active ? '#1a1b26' : hovered ? '#1e2030' : 'transparent',
                color: active || hovered ? '#a9b1d6' : '#787c99',
              }}
              title={tab.title}
            >
              {active && (
                <span
                  style={{
                    position: 'absolute',
                    bottom: 0,
                    left: 0,
                    right: 0,
                    height: 2,
                    backgroundColor: '#7aa2f7',
                  }}
                />
              )}
              <span
                style={{
                  display: 'inline-block',
                  fontSize: 10,
                  lineHeight: 1,
                  color: statusColor,
                  flexShrink: 0,
                }}
              >
                ●
              </span>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {tab.title}
              </span>
              {canClose && (
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    handleCloseWorkspaceTab(tab);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: isMobile ? 24 : 20,
                    height: isMobile ? 24 : 20,
                    borderRadius: 4,
                    border: 'none',
                    background: 'none',
                    color: '#787c99',
                    cursor: 'pointer',
                    fontSize: 14,
                    lineHeight: 1,
                    padding: 0,
                    flexShrink: 0,
                    opacity: isMobile ? 1 : active || hovered ? 1 : 0,
                    transition: 'background-color 0.15s, color 0.15s',
                  }}
                  aria-label={tab.kind === 'terminal' ? `Close ${tab.title}` : `Stop ${tab.title}`}
                  onMouseEnter={(event) => {
                    event.currentTarget.style.backgroundColor = '#33467c';
                    event.currentTarget.style.color = '#a9b1d6';
                  }}
                  onMouseLeave={(event) => {
                    event.currentTarget.style.backgroundColor = 'transparent';
                    event.currentTarget.style.color = '#787c99';
                  }}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
      </div>

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
    </div>
  ) : null;

  // ── Sidebar content (shared between desktop sidebar and mobile overlay) ──
  const sidebarContent = (
    <>
      <div
        style={{
          padding: 'var(--sam-space-3)',
          borderBottom: '1px solid var(--sam-color-border-default)',
          display: 'grid',
          gap: 'var(--sam-space-2)',
        }}
      >
        <label style={{ fontSize: '0.75rem', color: 'var(--sam-color-fg-muted)' }}>
          Workspace name
        </label>
        <div style={{ display: 'flex', gap: 'var(--sam-space-2)' }}>
          <input
            value={displayNameInput}
            onChange={(event) => setDisplayNameInput(event.target.value)}
            style={{
              flex: 1,
              borderRadius: 'var(--sam-radius-sm)',
              border: '1px solid var(--sam-color-border-default)',
              background: 'var(--sam-color-bg-canvas)',
              color: 'var(--sam-color-fg-primary)',
              padding: '6px 8px',
              minWidth: 0,
            }}
          />
          <Button
            size="sm"
            onClick={handleRename}
            disabled={renaming || !displayNameInput.trim()}
          >
            {renaming ? 'Saving...' : 'Rename'}
          </Button>
        </div>
      </div>

      <section
        style={{
          borderTop: '1px solid var(--sam-color-border-default)',
          overflow: 'auto',
          flex: 1,
        }}
      >
        <div
          style={{
            padding: 'var(--sam-space-3)',
            borderBottom: '1px solid var(--sam-color-border-default)',
          }}
        >
          <strong style={{ fontSize: '0.875rem' }}>Workspace Events</strong>
        </div>
        {workspaceEvents.length === 0 ? (
          <div
            style={{
              padding: 'var(--sam-space-3)',
              fontSize: '0.875rem',
              color: 'var(--sam-color-fg-muted)',
            }}
          >
            No events yet.
          </div>
        ) : (
          workspaceEvents.map((event) => (
            <div
              key={event.id}
              style={{
                borderBottom: '1px solid var(--sam-color-border-default)',
                padding: 'var(--sam-space-3)',
                fontSize: '0.8125rem',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 'var(--sam-space-2)',
                }}
              >
                <strong>{event.type}</strong>
                <span style={{ color: 'var(--sam-color-fg-muted)' }}>
                  {new Date(event.createdAt).toLocaleTimeString()}
                </span>
              </div>
              <div style={{ color: 'var(--sam-color-fg-muted)' }}>{event.message}</div>
            </div>
          ))
        )}
      </section>
    </>
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

        {/* Stop/Restart */}
        {isRunning && (
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={handleRebuild}
              disabled={actionLoading}
              loading={actionLoading}
              style={{ minHeight: '28px', padding: '0 10px', fontSize: '0.75rem' }}
            >
              Rebuild
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={handleStop}
              disabled={actionLoading}
              loading={actionLoading}
              style={{ minHeight: '28px', padding: '0 10px', fontSize: '0.75rem' }}
            >
              Stop
            </Button>
          </>
        )}
        {workspace?.status === 'stopped' && (
          <Button
            variant="primary"
            size="sm"
            onClick={handleRestart}
            disabled={actionLoading}
            loading={actionLoading}
            style={{ minHeight: '28px', padding: '0 10px', fontSize: '0.75rem' }}
          >
            Restart
          </Button>
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
