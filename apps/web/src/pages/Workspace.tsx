import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { Terminal, MultiTerminal } from '@simple-agent-manager/terminal';
import { useFeatureFlags } from '../config/features';
import { useAcpSession, useAcpMessages, AgentPanel } from '@simple-agent-manager/acp-client';
import type { AcpSessionState } from '@simple-agent-manager/acp-client';
import { Button, Spinner, StatusBadge } from '@simple-agent-manager/ui';
import { UserMenu } from '../components/UserMenu';
import { AgentSelector } from '../components/AgentSelector';
import { AgentSessionList } from '../components/AgentSessionList';
import { MobileBottomBar } from '../components/MobileBottomBar';
import { MobileOverflowMenu } from '../components/MobileOverflowMenu';
import { useIsMobile } from '../hooks/useIsMobile';
import {
  ApiClientError,
  createAgentSession,
  getTerminalToken,
  getWorkspace,
  listAgentSessions,
  listWorkspaceEvents,
  restartWorkspace,
  stopAgentSession,
  stopWorkspace,
  updateWorkspace,
} from '../lib/api';
import type { AgentSession, Event, WorkspaceResponse, BootLogEntry } from '@simple-agent-manager/shared';
import '../styles/workspace-mobile.css';
import '../styles/acp-chat.css';

/** Map ACP session state to a human-readable label */
function agentStatusLabel(state: AcpSessionState, agentType: string | null): string {
  if (!agentType) return '';
  switch (state) {
    case 'initializing': return `${agentType}: Init`;
    case 'ready': return `${agentType}: Ready`;
    case 'prompting': return `${agentType}: Prompting`;
    case 'error': return `${agentType}: Error`;
    case 'connecting': return `${agentType}: Connecting`;
    case 'reconnecting': return `${agentType}: Reconnecting`;
    case 'no_session': return '';
    case 'disconnected': return 'Disconnected';
    default: return '';
  }
}

/** Inline style for the agent status dot indicator */
function agentStatusDotStyle(state: AcpSessionState): React.CSSProperties {
  const base: React.CSSProperties = {
    display: 'inline-block',
    height: 8,
    width: 8,
    borderRadius: '50%',
    flexShrink: 0,
  };
  switch (state) {
    case 'ready': return { ...base, backgroundColor: '#4ade80' };
    case 'initializing':
    case 'connecting':
    case 'reconnecting': return { ...base, backgroundColor: '#fbbf24', animation: 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite' };
    case 'prompting': return { ...base, backgroundColor: '#60a5fa', animation: 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite' };
    case 'error': return { ...base, backgroundColor: '#f87171' };
    default: return { ...base, backgroundColor: '#6b7280' };
  }
}

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

/**
 * Workspace detail page — compact toolbar with terminal filling the viewport.
 */
export function Workspace() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const featureFlags = useFeatureFlags();
  const isMobile = useIsMobile();
  const viewParam = searchParams.get('view');
  const sessionIdParam = searchParams.get('sessionId');
  const viewOverride: ViewMode | null = viewParam === 'terminal' || viewParam === 'conversation' ? viewParam : null;
  const [workspace, setWorkspace] = useState<WorkspaceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const [terminalLoading, setTerminalLoading] = useState(false);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>(viewOverride ?? 'terminal');
  const [agentSheetOpen, setAgentSheetOpen] = useState(false);
  const [workspaceEvents, setWorkspaceEvents] = useState<Event[]>([]);
  const [agentSessions, setAgentSessions] = useState<AgentSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [displayNameInput, setDisplayNameInput] = useState('');

  // ACP
  const [acpWsUrl, setAcpWsUrl] = useState<string | null>(null);
  const acpMessages = useAcpMessages();
  const acpSession = useAcpSession({ wsUrl: acpWsUrl, onAcpMessage: acpMessages.processMessage });

  // Auto-fallback: switch to terminal when ACP errors
  useEffect(() => {
    if (acpSession.state === 'error' && viewMode === 'conversation') {
      setViewMode('terminal');
    }
  }, [acpSession.state, viewMode]);

  // Auto-switch to conversation when agent ready
  useEffect(() => {
    if (!viewOverride && acpSession.state === 'ready' && acpSession.agentType && viewMode === 'terminal') {
      setViewMode('conversation');
    }
  }, [acpSession.state, acpSession.agentType, viewMode, viewOverride]);

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
      if (workspace?.status === 'creating' || workspace?.status === 'stopping' || workspace?.status === 'running') {
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

  // Build ACP WebSocket URL
  useEffect(() => {
    if (!id || !workspace || workspace.status !== 'running' || !workspace.url) {
      setAcpWsUrl(null);
      return;
    }

    const fetchAcpToken = async () => {
      try {
        const { token } = await getTerminalToken(id);
        const url = new URL(workspace.url!);
        const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const sessionQuery = sessionIdParam ? `&sessionId=${encodeURIComponent(sessionIdParam)}` : '';
        setAcpWsUrl(`${wsProtocol}//${url.host}/agent/ws?token=${encodeURIComponent(token)}${sessionQuery}`);
      } catch {
        // ACP is optional
      }
    };

    fetchAcpToken();
  }, [id, workspace?.status, workspace?.url, sessionIdParam]);

  const handleTerminalActivity = useCallback(() => {
    if (!id) return;
    void loadWorkspaceState();
  }, [id, loadWorkspaceState]);

  const handleStop = async () => {
    if (!id) return;
    try {
      setActionLoading(true);
      await stopWorkspace(id);
      setWorkspace((prev) => prev ? { ...prev, status: 'stopping' } : null);
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
      setWorkspace((prev) => prev ? { ...prev, status: 'creating' } : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to restart workspace');
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

  const handleCreateSession = async () => {
    if (!id) {
      return;
    }

    try {
      setSessionsLoading(true);
      const key = typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`;
      await createAgentSession(id, {}, key);
      const sessions = await listAgentSessions(id);
      setAgentSessions(sessions);
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

  // ── Loading state ──
  if (loading) {
    return (
      <div style={{ height: 'var(--sam-app-height)', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#1a1b26' }}>
        <Spinner size="lg" />
      </div>
    );
  }

  // ── Fatal error (no workspace loaded) ──
  if (error && !workspace) {
    return (
      <div style={{ height: 'var(--sam-app-height)', display: 'flex', flexDirection: 'column', backgroundColor: '#1a1b26' }}>
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

  const isRunning = workspace?.status === 'running';
  const hasAgent = isRunning && acpSession.agentType;

  // ── Shared content area ──
  const contentArea = (
    <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
      {isRunning ? (
        viewMode === 'conversation' ? (
          <div style={{ height: '100%', overflow: 'hidden' }}>
            <AgentPanel session={acpSession} messages={acpMessages} />
          </div>
        ) : wsUrl ? (
          <div style={{ height: '100%' }}>
            {featureFlags.multiTerminal ? (
              <MultiTerminal
                wsUrl={wsUrl}
                shutdownDeadline={workspace?.shutdownDeadline}
                onActivity={handleTerminalActivity}
                className="h-full"
                persistenceKey={id ? `sam-terminal-sessions-${id}` : undefined}
              />
            ) : (
              <Terminal
                wsUrl={wsUrl}
                shutdownDeadline={workspace?.shutdownDeadline}
                onActivity={handleTerminalActivity}
                className="h-full"
              />
            )}
          </div>
        ) : terminalLoading ? (
          <CenteredStatus color="#60a5fa" title="Connecting to Terminal..." subtitle="Establishing secure connection" loading />
        ) : (
          <CenteredStatus
            color="#f87171"
            title="Connection Failed"
            subtitle={terminalError || 'Unable to connect to terminal'}
            action={(
              <Button
                variant="secondary"
                size="sm"
                onClick={() => { void connectTerminal(); }}
                disabled={terminalLoading}
              >
                Retry Connection
              </Button>
            )}
          />
        )
      ) : workspace?.status === 'creating' ? (
        <BootProgress logs={workspace.bootLogs} />
      ) : workspace?.status === 'stopping' ? (
        <CenteredStatus color="#fbbf24" title="Stopping Workspace" loading />
      ) : workspace?.status === 'stopped' ? (
        <CenteredStatus
          color="var(--sam-color-fg-muted)"
          title="Workspace Stopped"
          subtitle="Restart to access the terminal."
          action={
            <Button variant="primary" size="sm" onClick={handleRestart} disabled={actionLoading} loading={actionLoading}>
              Restart Workspace
            </Button>
          }
        />
      ) : workspace?.status === 'error' ? (
        <CenteredStatus color="#f87171" title="Workspace Error" subtitle={workspace?.errorMessage || 'An unexpected error occurred.'} />
      ) : null}
    </div>
  );

  // ══════════════════════════════════════════════════════════════
  // MOBILE LAYOUT
  // ══════════════════════════════════════════════════════════════
  if (isMobile) {
    return (
      <div style={{ height: 'var(--sam-app-height)', display: 'flex', flexDirection: 'column', backgroundColor: '#1a1b26', overflow: 'hidden' }}>
        {/* ── Mobile Header (compact) ── */}
        <header style={{
          display: 'flex',
          alignItems: 'center',
          padding: '0 4px 0 8px',
          height: '44px',
          backgroundColor: 'var(--sam-color-bg-surface)',
          borderBottom: '1px solid var(--sam-color-border-default)',
          gap: '6px',
          flexShrink: 0,
        }}>
          {/* Back */}
          <button
            onClick={() => navigate('/dashboard')}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--sam-color-fg-muted)', padding: '8px', display: 'flex', minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
            aria-label="Back to dashboard"
          >
            <svg style={{ height: 18, width: 18 }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>

          {/* Workspace name + status */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0, flex: 1 }}>
            <span style={{
              fontWeight: 600,
              fontSize: '0.875rem',
              color: 'var(--sam-color-fg-primary)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}>
              {workspace?.displayName || workspace?.name}
            </span>
            {workspace && <StatusBadge status={workspace.status} />}
          </div>

          {/* Overflow menu */}
          <MobileOverflowMenu
            repository={workspace?.repository}
            branch={workspace?.branch}
            isRunning={!!isRunning}
            isStopped={workspace?.status === 'stopped'}
            agentType={acpSession.agentType}
            sessionState={acpSession.state}
            error={error}
            actionLoading={actionLoading}
            onStop={handleStop}
            onRestart={handleRestart}
            onClearError={() => setError(null)}
          />

          {/* User menu */}
          <UserMenu />
        </header>

        {/* ── Content area ── */}
        {contentArea}

        {/* ── Bottom bar ── */}
        <MobileBottomBar
          viewMode={viewMode}
          onChangeView={setViewMode}
          onOpenAgentSheet={() => setAgentSheetOpen(true)}
          agentType={acpSession.agentType}
          sessionState={acpSession.state}
          isRunning={!!isRunning}
        />

        {/* ── Agent sheet overlay ── */}
        {agentSheetOpen && (
          <AgentSelector
            activeAgentType={acpSession.agentType}
            sessionState={acpSession.state}
            onSelectAgent={acpSession.switchAgent}
            mobile
            onClose={() => setAgentSheetOpen(false)}
          />
        )}
      </div>
    );
  }

  // ══════════════════════════════════════════════════════════════
  // DESKTOP LAYOUT (original)
  // ══════════════════════════════════════════════════════════════
  const toggleBtnStyle = (active: boolean): React.CSSProperties => ({
    padding: '2px 10px',
    fontSize: '0.75rem',
    fontWeight: 500,
    border: 'none',
    borderRadius: 0,
    cursor: 'pointer',
    backgroundColor: active ? 'var(--sam-color-accent-primary)' : 'transparent',
    color: active ? '#ffffff' : 'var(--sam-color-fg-muted)',
    transition: 'all 0.15s ease',
  });

  return (
    <div style={{ height: 'var(--sam-app-height)', display: 'flex', flexDirection: 'column', backgroundColor: '#1a1b26', overflow: 'hidden' }}>
      {/* ── Compact Toolbar ── */}
      <header style={{
        display: 'flex',
        alignItems: 'center',
        padding: '0 12px',
        height: '40px',
        backgroundColor: 'var(--sam-color-bg-surface)',
        borderBottom: '1px solid var(--sam-color-border-default)',
        gap: '10px',
        flexShrink: 0,
      }}>
        {/* Back */}
        <button
          onClick={() => navigate('/dashboard')}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--sam-color-fg-muted)', padding: '4px', display: 'flex' }}
          aria-label="Back to dashboard"
        >
          <svg style={{ height: 16, width: 16 }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>

        {/* Workspace name + status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
          <span style={{
            fontWeight: 600,
            fontSize: '0.875rem',
            color: 'var(--sam-color-fg-primary)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}>
            {workspace?.displayName || workspace?.name}
          </span>
          {workspace && <StatusBadge status={workspace.status} />}
        </div>

        {/* Separator */}
        <div style={{ width: '1px', height: '16px', backgroundColor: 'var(--sam-color-border-default)', flexShrink: 0 }} />

        {/* Repo@branch */}
        <span style={{
          fontSize: '0.75rem',
          color: 'var(--sam-color-fg-muted)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          minWidth: 0,
        }}>
          {workspace?.repository}{workspace?.branch ? `@${workspace.branch}` : ''}
        </span>

        {/* Spacer */}
        <div style={{ flex: 1 }} />

        {/* Error inline */}
        {error && (
          <span style={{ fontSize: '0.75rem', color: '#f87171', whiteSpace: 'nowrap' }}>
            {error}
            <button
              onClick={() => setError(null)}
              style={{ background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', marginLeft: '4px', fontSize: '0.75rem' }}
            >
              x
            </button>
          </span>
        )}

        {/* Agent status */}
        {isRunning && acpSession.agentType && (
          <>
            <div style={{ width: '1px', height: '16px', backgroundColor: 'var(--sam-color-border-default)', flexShrink: 0 }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '0.75rem', color: 'var(--sam-color-fg-muted)', whiteSpace: 'nowrap' }}>
              <span style={agentStatusDotStyle(acpSession.state)} />
              <span>{agentStatusLabel(acpSession.state, acpSession.agentType)}</span>
            </div>
          </>
        )}

        {/* View mode toggle */}
        {hasAgent && (
          <div style={{
            display: 'flex',
            borderRadius: 'var(--sam-radius-md)',
            border: '1px solid var(--sam-color-border-default)',
            overflow: 'hidden',
          }}>
            <button onClick={() => setViewMode('terminal')} style={toggleBtnStyle(viewMode === 'terminal')}>Terminal</button>
            <button onClick={() => setViewMode('conversation')} style={toggleBtnStyle(viewMode === 'conversation')}>Chat</button>
          </div>
        )}

        {/* Stop/Restart */}
        {isRunning && (
          <Button variant="danger" size="sm" onClick={handleStop} disabled={actionLoading} loading={actionLoading}
            style={{ minHeight: '28px', padding: '0 10px', fontSize: '0.75rem' }}>
            Stop
          </Button>
        )}
        {workspace?.status === 'stopped' && (
          <Button variant="primary" size="sm" onClick={handleRestart} disabled={actionLoading} loading={actionLoading}
            style={{ minHeight: '28px', padding: '0 10px', fontSize: '0.75rem' }}>
            Restart
          </Button>
        )}

        {/* User menu */}
        <UserMenu />
      </header>

      {/* ── Agent selector bar (thin, only when running — desktop only) ── */}
      {isRunning && (
        <div style={{ flexShrink: 0 }}>
          <AgentSelector
            activeAgentType={acpSession.agentType}
            sessionState={acpSession.state}
            onSelectAgent={acpSession.switchAgent}
          />
        </div>
      )}

      {/* ── Content area ── */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div style={{ flex: 1, minWidth: 0 }}>{contentArea}</div>

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
          <div
            style={{
              padding: 'var(--sam-space-3)',
              borderBottom: '1px solid var(--sam-color-border-default)',
              display: 'grid',
              gap: 'var(--sam-space-2)',
            }}
          >
            <label style={{ fontSize: '0.75rem', color: 'var(--sam-color-fg-muted)' }}>Workspace name</label>
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
              <Button size="sm" onClick={handleRename} disabled={renaming || !displayNameInput.trim()}>
                {renaming ? 'Saving...' : 'Rename'}
              </Button>
            </div>
          </div>

          <AgentSessionList
            sessions={agentSessions}
            loading={sessionsLoading}
            onCreate={handleCreateSession}
            onAttach={handleAttachSession}
            onStop={handleStopSession}
          />

          <section
            style={{
              borderTop: '1px solid var(--sam-color-border-default)',
              overflow: 'auto',
              flex: 1,
            }}
          >
            <div style={{ padding: 'var(--sam-space-3)', borderBottom: '1px solid var(--sam-color-border-default)' }}>
              <strong style={{ fontSize: '0.875rem' }}>Workspace Events</strong>
            </div>
            {workspaceEvents.length === 0 ? (
              <div style={{ padding: 'var(--sam-space-3)', fontSize: '0.875rem', color: 'var(--sam-color-fg-muted)' }}>
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
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--sam-space-2)' }}>
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
        </aside>
      </div>
    </div>
  );
}

// ── Minimal sub-components ──

function Toolbar({ onBack }: { onBack: () => void }) {
  return (
    <header style={{
      display: 'flex',
      alignItems: 'center',
      padding: '0 12px',
      height: '40px',
      backgroundColor: 'var(--sam-color-bg-surface)',
      borderBottom: '1px solid var(--sam-color-border-default)',
      gap: '10px',
      flexShrink: 0,
    }}>
      <button
        onClick={onBack}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--sam-color-fg-muted)', padding: '4px', display: 'flex' }}
      >
        <svg style={{ height: 16, width: 16 }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
      </button>
      <span style={{ fontWeight: 600, fontSize: '0.875rem', color: 'var(--sam-color-fg-primary)' }}>Workspace</span>
    </header>
  );
}

function CenteredStatus({
  color, title, subtitle, action, loading: isLoading,
}: {
  color: string; title: string; subtitle?: string | null; action?: React.ReactNode; loading?: boolean;
}) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      height: '100%', gap: '12px', backgroundColor: '#1a1b26', color: '#a9b1d6',
    }}>
      {isLoading && <Spinner size="lg" />}
      <h3 style={{ fontSize: '1rem', fontWeight: 600, color, margin: 0 }}>{title}</h3>
      {subtitle && <p style={{ fontSize: '0.875rem', color: '#787c99', margin: 0, maxWidth: '400px', textAlign: 'center' }}>{subtitle}</p>}
      {action && <div style={{ marginTop: '4px' }}>{action}</div>}
    </div>
  );
}

function BootProgress({ logs }: { logs?: BootLogEntry[] }) {
  if (!logs || logs.length === 0) {
    return <CenteredStatus color="#60a5fa" title="Creating Workspace" subtitle="Initializing..." loading />;
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
        return <span style={{ color: '#4ade80', marginRight: 8, fontSize: '0.875rem' }}>&#10003;</span>;
      case 'failed':
        return <span style={{ color: '#f87171', marginRight: 8, fontSize: '0.875rem' }}>&#10007;</span>;
      case 'started':
      default:
        return <span style={{ marginRight: 8, display: 'inline-flex' }}><Spinner size="sm" /></span>;
    }
  };

  const lastStep = steps[steps.length - 1];
  const hasFailed = lastStep?.status === 'failed';

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      height: '100%', backgroundColor: '#1a1b26', color: '#a9b1d6', padding: '24px',
    }}>
      <h3 style={{ fontSize: '1rem', fontWeight: 600, color: hasFailed ? '#f87171' : '#60a5fa', margin: '0 0 16px 0' }}>
        {hasFailed ? 'Provisioning Failed' : 'Creating Workspace'}
      </h3>
      <div style={{
        display: 'flex', flexDirection: 'column', gap: '6px',
        maxWidth: '400px', width: '100%',
      }}>
        {steps.map((entry, i) => (
          <div key={i} style={{
            display: 'flex', alignItems: 'center',
            fontSize: '0.8125rem',
            color: entry.status === 'failed' ? '#f87171' : entry.status === 'completed' ? '#787c99' : '#a9b1d6',
          }}>
            {statusIcon(entry.status)}
            <span>{entry.message}</span>
          </div>
        ))}
      </div>
      {lastStep?.status === 'failed' && lastStep.detail && (
        <p style={{ fontSize: '0.75rem', color: '#787c99', margin: '12px 0 0', maxWidth: '400px', textAlign: 'center', wordBreak: 'break-word' }}>
          {lastStep.detail}
        </p>
      )}
    </div>
  );
}
