import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { Terminal, MultiTerminal } from '@simple-agent-manager/terminal';
import { useFeatureFlags } from '../config/features';
import { useAcpSession, useAcpMessages, AgentPanel } from '@simple-agent-manager/acp-client';
import type { AcpSessionState } from '@simple-agent-manager/acp-client';
import { Button, Spinner, StatusBadge } from '@simple-agent-manager/ui';
import { UserMenu } from '../components/UserMenu';
import { AgentSelector } from '../components/AgentSelector';
import { getWorkspace, getTerminalToken, stopWorkspace, restartWorkspace } from '../lib/api';
import type { WorkspaceResponse } from '@simple-agent-manager/shared';

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
  const viewParam = searchParams.get('view');
  const viewOverride: ViewMode | null = viewParam === 'terminal' || viewParam === 'conversation' ? viewParam : null;
  const [workspace, setWorkspace] = useState<WorkspaceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const [terminalLoading, setTerminalLoading] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>(viewOverride ?? 'terminal');

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

  // Load workspace
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

  // Fetch terminal token and build WebSocket URL
  useEffect(() => {
    if (!id || !workspace || workspace.status !== 'running' || !workspace.url) {
      setWsUrl(null);
      return;
    }

    const fetchTerminalToken = async () => {
      if (!workspace.url) return;
      try {
        setTerminalLoading(true);
        const { token } = await getTerminalToken(id);
        const url = new URL(workspace.url);
        const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsPath = featureFlags.multiTerminal ? '/terminal/ws/multi' : '/terminal/ws';
        setWsUrl(`${wsProtocol}//${url.host}${wsPath}?token=${encodeURIComponent(token)}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to get terminal token');
      } finally {
        setTerminalLoading(false);
      }
    };

    fetchTerminalToken();
  }, [id, workspace?.status, workspace?.url, featureFlags.multiTerminal]);

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
        setAcpWsUrl(`${wsProtocol}//${url.host}/agent/ws?token=${encodeURIComponent(token)}`);
      } catch {
        // ACP is optional
      }
    };

    fetchAcpToken();
  }, [id, workspace?.status, workspace?.url]);

  const handleTerminalActivity = useCallback(() => {
    if (!id) return;
    getWorkspace(id).then(setWorkspace).catch(() => {});
  }, [id]);

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

  // ── Loading state ──
  if (loading) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#1a1b26' }}>
        <Spinner size="lg" />
      </div>
    );
  }

  // ── Fatal error (no workspace loaded) ──
  if (error && !workspace) {
    return (
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', backgroundColor: '#1a1b26' }}>
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
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', backgroundColor: '#1a1b26', overflow: 'hidden' }}>
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
            {workspace?.name}
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

      {/* ── Agent selector bar (thin, only when running) ── */}
      {isRunning && (
        <div style={{ flexShrink: 0 }}>
          <AgentSelector
            activeAgentType={acpSession.agentType}
            sessionState={acpSession.state}
            onSelectAgent={acpSession.switchAgent}
          />
        </div>
      )}

      {/* ── Content area (fills remaining viewport) ── */}
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
            <CenteredStatus color="#f87171" title="Connection Failed" subtitle="Unable to connect to terminal" />
          )
        ) : workspace?.status === 'creating' ? (
          <CenteredStatus color="#60a5fa" title="Creating Workspace" subtitle="This may take a few minutes..." loading />
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
