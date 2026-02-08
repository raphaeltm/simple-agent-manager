import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { Terminal } from '@simple-agent-manager/terminal';
import { useAcpSession, useAcpMessages, AgentPanel } from '@simple-agent-manager/acp-client';
import type { AcpSessionState } from '@simple-agent-manager/acp-client';
import { Button, Alert, Spinner, StatusBadge } from '@simple-agent-manager/ui';
import { UserMenu } from '../components/UserMenu';
import { AgentSelector } from '../components/AgentSelector';
import { getWorkspace, getTerminalToken, stopWorkspace, restartWorkspace } from '../lib/api';
import type { WorkspaceResponse } from '@simple-agent-manager/shared';

/** Map ACP session state to a human-readable label */
function agentStatusLabel(state: AcpSessionState, agentType: string | null): string {
  if (!agentType) return 'No Agent Selected';
  switch (state) {
    case 'initializing': return `${agentType}: Initializing...`;
    case 'ready': return `${agentType}: Ready`;
    case 'prompting': return `${agentType}: Prompting`;
    case 'error': return `${agentType}: Error`;
    case 'connecting': return `${agentType}: Connecting...`;
    case 'reconnecting': return `${agentType}: Reconnecting...`;
    case 'no_session': return 'No Agent Selected';
    case 'disconnected': return 'Disconnected';
    default: return 'No Agent Selected';
  }
}

/** Inline style for the agent status dot indicator */
function agentStatusDotStyle(state: AcpSessionState): React.CSSProperties {
  const base: React.CSSProperties = {
    display: 'inline-block',
    height: 8,
    width: 8,
    borderRadius: '50%',
  };
  switch (state) {
    case 'ready': return { ...base, backgroundColor: '#4ade80' };
    case 'initializing':
    case 'connecting':
    case 'reconnecting': return { ...base, backgroundColor: '#fbbf24', animation: 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite' };
    case 'prompting': return { ...base, backgroundColor: '#60a5fa', animation: 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite' };
    case 'error': return { ...base, backgroundColor: '#f87171' };
    default: return { ...base, backgroundColor: '#9fb7ae' };
  }
}

/** View modes: terminal (existing) or conversation (Phase 5 placeholder) */
type ViewMode = 'terminal' | 'conversation';

/** Shared styles */
const headerStyle: React.CSSProperties = {
  backgroundColor: 'var(--sam-color-bg-surface)',
  borderBottom: '1px solid var(--sam-color-border-default)',
};

const headerInnerStyle: React.CSSProperties = {
  maxWidth: '80rem',
  margin: '0 auto',
  padding: 'var(--sam-space-4) var(--sam-space-4)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
};

const mainStyle: React.CSSProperties = {
  maxWidth: '80rem',
  margin: '0 auto',
  padding: 'var(--sam-space-8) var(--sam-space-4)',
};

const terminalPanelStyle: React.CSSProperties = {
  backgroundColor: 'var(--sam-color-bg-canvas)',
  borderRadius: 'var(--sam-radius-lg)',
  padding: 'var(--sam-space-8)',
  textAlign: 'center',
};

const infoLabelStyle: React.CSSProperties = {
  fontSize: '0.875rem',
  fontWeight: 500,
  color: 'var(--sam-color-fg-muted)',
};

const infoValueStyle: React.CSSProperties = {
  marginTop: '4px',
  fontSize: '0.875rem',
  color: 'var(--sam-color-fg-primary)',
};

/**
 * Workspace detail page with terminal access and ACP agent integration.
 */
export function Workspace() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const viewParam = searchParams.get('view');
  const viewOverride: ViewMode | null = viewParam === 'terminal' || viewParam === 'conversation' ? viewParam : null;
  const [workspace, setWorkspace] = useState<WorkspaceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const [terminalLoading, setTerminalLoading] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>(viewOverride ?? 'terminal');

  // ACP WebSocket URL (separate from terminal WS)
  const [acpWsUrl, setAcpWsUrl] = useState<string | null>(null);

  // ACP session and messages hooks
  const acpMessages = useAcpMessages();
  const acpSession = useAcpSession({ wsUrl: acpWsUrl, onAcpMessage: acpMessages.processMessage });
  const [fallbackNotice, setFallbackNotice] = useState<string | null>(null);

  // Auto-fallback: switch to terminal when ACP session errors out (T040)
  useEffect(() => {
    if (acpSession.state === 'error' && viewMode === 'conversation') {
      setViewMode('terminal');
      setFallbackNotice('Structured view unavailable — using terminal mode');
    }
  }, [acpSession.state, viewMode]);

  // Auto-switch to conversation mode when agent becomes ready
  useEffect(() => {
    if (!viewOverride && acpSession.state === 'ready' && acpSession.agentType && viewMode === 'terminal') {
      setViewMode('conversation');
      setFallbackNotice(null);
    }
  }, [acpSession.state, acpSession.agentType, viewMode, viewOverride]);

  useEffect(() => {
    if (!id) return;

    const loadWorkspace = async () => {
      try {
        setError(null);
        const data = await getWorkspace(id);
        setWorkspace(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load workspace');
      } finally {
        setLoading(false);
      }
    };

    loadWorkspace();

    // Poll for updates if in transitional state
    const interval = setInterval(async () => {
      if (workspace?.status === 'creating' || workspace?.status === 'stopping') {
        try {
          const data = await getWorkspace(id);
          setWorkspace(data);
        } catch {
          // Ignore polling errors
        }
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [id, workspace?.status]);

  // Fetch terminal token and build WebSocket URL when workspace is running
  useEffect(() => {
    if (!id || !workspace || workspace.status !== 'running' || !workspace.url) {
      setWsUrl(null);
      return;
    }

    const fetchTerminalToken = async () => {
      if (!workspace.url) {
        setError('Workspace URL not available');
        return;
      }

      try {
        setTerminalLoading(true);
        const { token } = await getTerminalToken(id);

        // Build WebSocket URL from workspace URL
        const url = new URL(workspace.url);
        const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const terminalWsUrl = `${wsProtocol}//${url.host}/terminal/ws?token=${encodeURIComponent(token)}`;
        setWsUrl(terminalWsUrl);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to get terminal token');
      } finally {
        setTerminalLoading(false);
      }
    };

    fetchTerminalToken();
  }, [id, workspace?.status, workspace?.url]);

  // Build ACP WebSocket URL when workspace is running (same token, different path)
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
        setAcpWsUrl(`${wsProtocol}//${url.host}/agent/ws?token=${encodeURIComponent(token)}`);
      } catch {
        // ACP connection is optional; don't block terminal
      }
    };

    fetchAcpToken();
  }, [id, workspace?.status, workspace?.url]);

  // Handle terminal activity - refresh workspace data to update shutdownDeadline
  const handleTerminalActivity = useCallback(() => {
    if (!id) return;
    // Refresh workspace to get updated shutdownDeadline
    getWorkspace(id)
      .then(setWorkspace)
      .catch(() => {
        // Ignore errors during activity refresh
      });
  }, [id]);

  const handleOpenTerminal = async () => {
    if (!workspace || !id) return;

    try {
      setActionLoading(true);
      const { token } = await getTerminalToken(id);

      // Open workspace URL with token
      if (workspace.url) {
        const terminalUrl = `${workspace.url}?token=${encodeURIComponent(token)}`;
        window.open(terminalUrl, '_blank');
      } else {
        setError('Workspace URL not available');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to get terminal token');
    } finally {
      setActionLoading(false);
    }
  };

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

  const handleNewTerminalTab = () => {
    if (!id) return;
    const path = `/workspaces/${id}?view=terminal`;
    const opened = window.open(path, '_blank');
    if (opened) {
      try {
        opened.opener = null;
      } catch {
        // Ignore
      }
      return;
    }
    navigate(path);
  };

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', backgroundColor: 'var(--sam-color-bg-canvas)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spinner size="lg" />
      </div>
    );
  }

  if (error && !workspace) {
    return (
      <div style={{ minHeight: '100vh', backgroundColor: 'var(--sam-color-bg-canvas)' }}>
        <header style={headerStyle}>
          <div style={headerInnerStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-4)' }}>
              <button
                onClick={() => navigate('/dashboard')}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--sam-color-fg-muted)', padding: 0 }}
              >
                <svg style={{ height: 20, width: 20 }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <h1 style={{ fontSize: '1.25rem', fontWeight: 600, color: 'var(--sam-color-fg-primary)' }}>Workspace</h1>
            </div>
            <UserMenu />
          </div>
        </header>
        <main style={mainStyle}>
          <Alert variant="error">
            <div style={{ textAlign: 'center' }}>
              <p>{error}</p>
              <button
                onClick={() => navigate('/dashboard')}
                style={{
                  marginTop: 'var(--sam-space-4)',
                  color: 'var(--sam-color-accent-primary)',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 'inherit',
                }}
              >
                Back to Dashboard
              </button>
            </div>
          </Alert>
        </main>
      </div>
    );
  }

  const toggleBtnStyle = (active: boolean): React.CSSProperties => ({
    padding: '4px 12px',
    fontSize: '0.75rem',
    fontWeight: 500,
    border: 'none',
    cursor: 'pointer',
    backgroundColor: active ? 'var(--sam-color-accent-primary)' : 'transparent',
    color: active ? '#ffffff' : 'var(--sam-color-fg-muted)',
    transition: 'all 0.15s ease',
  });

  return (
    <div style={{ minHeight: '100vh', backgroundColor: 'var(--sam-color-bg-canvas)' }}>
      {/* Header */}
      <header style={headerStyle}>
        <div style={headerInnerStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-4)' }}>
            <button
              onClick={() => navigate('/dashboard')}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--sam-color-fg-muted)', padding: 0 }}
            >
              <svg style={{ height: 20, width: 20 }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <h1 style={{ fontSize: '1.25rem', fontWeight: 600, color: 'var(--sam-color-fg-primary)' }}>{workspace?.name}</h1>
            {workspace && <StatusBadge status={workspace.status} />}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-4)' }}>
            {/* Agent status indicator (FR-019) — visible in both terminal and conversation modes */}
            {workspace?.status === 'running' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-2)', fontSize: '0.875rem', color: 'var(--sam-color-fg-muted)' }}>
                <span style={agentStatusDotStyle(acpSession.state)} />
                <span>{agentStatusLabel(acpSession.state, acpSession.agentType)}</span>
              </div>
            )}
            {/* View mode toggle (wired in US3/US4) */}
            {workspace?.status === 'running' && acpSession.agentType && (
              <div style={{
                display: 'flex',
                borderRadius: 'var(--sam-radius-md)',
                border: '1px solid var(--sam-color-border-default)',
                overflow: 'hidden',
              }}>
                <button
                  onClick={() => setViewMode('terminal')}
                  style={toggleBtnStyle(viewMode === 'terminal')}
                >
                  Terminal
                </button>
                <button
                  onClick={() => setViewMode('conversation')}
                  style={toggleBtnStyle(viewMode === 'conversation')}
                >
                  Conversation
                </button>
              </div>
            )}
            <UserMenu />
          </div>
        </div>
      </header>

      {/* Main content */}
      <main style={mainStyle}>
        {/* Error banner */}
        {error && (
          <div style={{ marginBottom: 'var(--sam-space-6)' }}>
            <Alert variant="error" onDismiss={() => setError(null)}>
              {error}
            </Alert>
          </div>
        )}

        {/* ACP fallback notification */}
        {fallbackNotice && (
          <div style={{ marginBottom: 'var(--sam-space-6)' }}>
            <Alert variant="warning" onDismiss={() => setFallbackNotice(null)}>
              {fallbackNotice}
            </Alert>
          </div>
        )}

        {/* Workspace details */}
        <div style={{
          backgroundColor: 'var(--sam-color-bg-surface)',
          borderRadius: 'var(--sam-radius-lg)',
          border: '1px solid var(--sam-color-border-default)',
        }}>
          <div style={{ padding: 'var(--sam-space-6)' }}>
            {/* Info section */}
            <style>{`.sam-workspace-info { grid-template-columns: 1fr; } @media (min-width: 768px) { .sam-workspace-info { grid-template-columns: repeat(2, 1fr); } }`}</style>
            <div className="sam-workspace-info" style={{ display: 'grid', gap: 'var(--sam-space-6)', marginBottom: 'var(--sam-space-6)' }}>
              <div>
                <h3 style={infoLabelStyle}>Repository</h3>
                <p style={infoValueStyle}>{workspace?.repository}</p>
              </div>
              <div>
                <h3 style={infoLabelStyle}>Branch</h3>
                <p style={infoValueStyle}>{workspace?.branch}</p>
              </div>
              <div>
                <h3 style={infoLabelStyle}>VM Size</h3>
                <p style={infoValueStyle}>{workspace?.vmSize}</p>
              </div>
              <div>
                <h3 style={infoLabelStyle}>Location</h3>
                <p style={infoValueStyle}>{workspace?.vmLocation}</p>
              </div>
              <div>
                <h3 style={infoLabelStyle}>Created</h3>
                <p style={infoValueStyle}>
                  {workspace?.createdAt && new Date(workspace.createdAt).toLocaleString()}
                </p>
              </div>
              <div>
                <h3 style={infoLabelStyle}>Last Activity</h3>
                <p style={infoValueStyle}>
                  {workspace?.lastActivityAt
                    ? new Date(workspace.lastActivityAt).toLocaleString()
                    : 'No activity recorded'}
                </p>
              </div>
            </div>

            {/* Error message */}
            {workspace?.errorMessage && (
              <div style={{ marginBottom: 'var(--sam-space-6)' }}>
                <Alert variant="error">
                  <div>
                    <strong>Error</strong>
                    <p style={{ marginTop: '4px' }}>{workspace.errorMessage}</p>
                  </div>
                </Alert>
              </div>
            )}

            {/* Agent Selector — shown when workspace is running */}
            {workspace?.status === 'running' && (
              <div style={{ borderTop: '1px solid var(--sam-color-border-default)', paddingTop: 'var(--sam-space-4)', paddingBottom: 'var(--sam-space-2)' }}>
                <AgentSelector
                  activeAgentType={acpSession.agentType}
                  sessionState={acpSession.state}
                  onSelectAgent={acpSession.switchAgent}
                />
              </div>
            )}

            {/* Terminal / Conversation section */}
            <div style={{ borderTop: '1px solid var(--sam-color-border-default)', paddingTop: 'var(--sam-space-6)' }}>
              {workspace?.status === 'running' ? (
                viewMode === 'conversation' ? (
                  <div style={{ borderRadius: 'var(--sam-radius-lg)', overflow: 'hidden', height: 500 }}>
                    <AgentPanel session={acpSession} messages={acpMessages} />
                  </div>
                ) : wsUrl ? (
                  <div style={{ backgroundColor: 'var(--sam-color-bg-canvas)', borderRadius: 'var(--sam-radius-lg)', overflow: 'hidden', height: 500 }}>
                    <Terminal
                      wsUrl={wsUrl}
                      shutdownDeadline={workspace.shutdownDeadline}
                      onActivity={handleTerminalActivity}
                      className="h-full"
                    />
                  </div>
                ) : terminalLoading ? (
                  <div style={terminalPanelStyle}>
                    <svg style={{ margin: '0 auto', height: 48, width: 48, color: '#4ade80' }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                    <h3 style={{ marginTop: 'var(--sam-space-4)', fontSize: '1.125rem', fontWeight: 500, color: 'var(--sam-color-fg-primary)' }}>Connecting to Terminal</h3>
                    <p style={{ marginTop: 'var(--sam-space-2)', color: 'var(--sam-color-fg-muted)' }}>
                      Establishing secure connection...
                    </p>
                    <div style={{ marginTop: 'var(--sam-space-6)', display: 'flex', justifyContent: 'center' }}>
                      <Spinner size="lg" />
                    </div>
                  </div>
                ) : (
                  <div style={terminalPanelStyle}>
                    <svg style={{ margin: '0 auto', height: 48, width: 48, color: '#f87171' }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                    <h3 style={{ marginTop: 'var(--sam-space-4)', fontSize: '1.125rem', fontWeight: 500, color: 'var(--sam-color-fg-primary)' }}>Connection Failed</h3>
                    <p style={{ marginTop: 'var(--sam-space-2)', color: 'var(--sam-color-fg-muted)' }}>
                      Unable to connect to terminal. Please try again.
                    </p>
                    <div style={{ marginTop: 'var(--sam-space-6)' }}>
                      <Button onClick={handleOpenTerminal} disabled={actionLoading} loading={actionLoading}>
                        {actionLoading ? 'Connecting...' : 'Open in New Tab'}
                      </Button>
                    </div>
                  </div>
                )
              ) : workspace?.status === 'creating' ? (
                <div style={terminalPanelStyle}>
                  <svg style={{ margin: '0 auto', height: 48, width: 48, color: '#60a5fa' }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  <h3 style={{ marginTop: 'var(--sam-space-4)', fontSize: '1.125rem', fontWeight: 500, color: 'var(--sam-color-fg-primary)' }}>Creating Workspace</h3>
                  <p style={{ marginTop: 'var(--sam-space-2)', color: 'var(--sam-color-fg-muted)' }}>
                    Your workspace is being created. This may take a few minutes.
                  </p>
                  <div style={{ marginTop: 'var(--sam-space-6)', display: 'flex', justifyContent: 'center' }}>
                    <Spinner size="lg" />
                  </div>
                </div>
              ) : workspace?.status === 'stopping' ? (
                <div style={terminalPanelStyle}>
                  <svg style={{ margin: '0 auto', height: 48, width: 48, color: '#fbbf24' }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  <h3 style={{ marginTop: 'var(--sam-space-4)', fontSize: '1.125rem', fontWeight: 500, color: 'var(--sam-color-fg-primary)' }}>Stopping Workspace</h3>
                  <p style={{ marginTop: 'var(--sam-space-2)', color: 'var(--sam-color-fg-muted)' }}>
                    Your workspace is being stopped.
                  </p>
                  <div style={{ marginTop: 'var(--sam-space-6)', display: 'flex', justifyContent: 'center' }}>
                    <Spinner size="lg" />
                  </div>
                </div>
              ) : workspace?.status === 'stopped' ? (
                <div style={terminalPanelStyle}>
                  <svg style={{ margin: '0 auto', height: 48, width: 48, color: 'var(--sam-color-fg-muted)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  <h3 style={{ marginTop: 'var(--sam-space-4)', fontSize: '1.125rem', fontWeight: 500, color: 'var(--sam-color-fg-primary)' }}>Workspace Stopped</h3>
                  <p style={{ marginTop: 'var(--sam-space-2)', color: 'var(--sam-color-fg-muted)' }}>
                    This workspace has been stopped. Restart it to access the terminal.
                  </p>
                  <div style={{ marginTop: 'var(--sam-space-6)' }}>
                    <Button onClick={handleRestart} disabled={actionLoading} loading={actionLoading}>
                      {actionLoading ? 'Restarting...' : 'Restart Workspace'}
                    </Button>
                  </div>
                </div>
              ) : workspace?.status === 'error' ? (
                <div style={terminalPanelStyle}>
                  <svg style={{ margin: '0 auto', height: 48, width: 48, color: '#f87171' }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  <h3 style={{ marginTop: 'var(--sam-space-4)', fontSize: '1.125rem', fontWeight: 500, color: 'var(--sam-color-fg-primary)' }}>Workspace Error</h3>
                  <p style={{ marginTop: 'var(--sam-space-2)', color: 'var(--sam-color-fg-muted)' }}>
                    An error occurred with this workspace.
                  </p>
                </div>
              ) : null}
            </div>

            {/* Actions */}
            <div style={{
              marginTop: 'var(--sam-space-6)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              borderTop: '1px solid var(--sam-color-border-default)',
              paddingTop: 'var(--sam-space-6)',
            }}>
              <Button variant="ghost" onClick={() => navigate('/dashboard')}>
                Back to Dashboard
              </Button>

              <div style={{ display: 'flex', gap: 'var(--sam-space-3)' }}>
                {workspace?.status === 'running' && (
                  <Button variant="secondary" onClick={handleNewTerminalTab} disabled={actionLoading}>
                    New Terminal Tab
                  </Button>
                )}
                {workspace?.status === 'running' && (
                  <Button
                    variant="danger"
                    onClick={handleStop}
                    disabled={actionLoading}
                    loading={actionLoading}
                  >
                    Stop Workspace
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
