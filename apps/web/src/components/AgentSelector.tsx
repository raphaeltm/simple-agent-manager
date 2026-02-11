import { useState, useEffect, useCallback } from 'react';
import { listAgents } from '../lib/api';
import { Spinner } from '@simple-agent-manager/ui';
import type { AgentInfo } from '@simple-agent-manager/shared';
import type { AcpSessionState } from '@simple-agent-manager/acp-client';

interface AgentSelectorProps {
  activeAgentType: string | null;
  sessionState: AcpSessionState;
  onSelectAgent: (agentType: string) => void;
  /** When true, renders as a mobile-friendly slide-up sheet */
  mobile?: boolean;
  /** Called to close the mobile sheet overlay */
  onClose?: () => void;
}

export function AgentSelector({ activeAgentType, sessionState, onSelectAgent, mobile, onClose }: AgentSelectorProps) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadAgents = useCallback(async () => {
    try {
      setError(null);
      const data = await listAgents();
      setAgents(data.agents);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load agents');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  const wsConnected = sessionState !== 'disconnected' && sessionState !== 'connecting' && sessionState !== 'reconnecting';

  // ── Mobile sheet layout ──
  if (mobile) {
    return (
      <>
        <div className="sam-agent-sheet-backdrop" onClick={onClose} />
        <div className="sam-agent-sheet">
          <div className="sam-agent-sheet__handle" />
          <h3 className="sam-agent-sheet__title">Select Agent</h3>

          {loading && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 0' }}>
              <Spinner size="sm" />
              <span style={{ fontSize: '0.875rem', color: 'var(--sam-color-fg-muted)' }}>Loading agents...</span>
            </div>
          )}

          {error && (
            <div style={{ padding: '12px 0', fontSize: '0.875rem', color: '#f87171' }}>
              {error}
            </div>
          )}

          {!loading && !error && agents.map((agent) => {
            const isActive = agent.id === activeAgentType;
            const canClick = agent.configured && wsConnected;

            return (
              <button
                key={agent.id}
                className={`sam-agent-sheet__button ${isActive ? 'sam-agent-sheet__button--active' : ''}`}
                onClick={() => {
                  if (canClick) {
                    onSelectAgent(agent.id);
                    onClose?.();
                  }
                }}
                disabled={!canClick}
              >
                <div style={{ flex: 1, textAlign: 'left' }}>
                  <div style={{ fontSize: '0.9375rem', fontWeight: 600, color: isActive ? 'var(--sam-color-accent-primary)' : 'var(--sam-color-fg-primary)' }}>
                    {agent.name}
                    {isActive && (
                      <span style={{ marginLeft: 8, fontSize: '0.75rem', fontWeight: 400, color: 'var(--sam-color-fg-muted)' }}>
                        Active
                      </span>
                    )}
                  </div>
                  <div className="sam-agent-sheet__button-hint">
                    {!agent.configured
                      ? 'API key not configured — add it in Settings'
                      : !wsConnected
                        ? 'Connecting to workspace...'
                        : agent.description}
                  </div>
                </div>
                {isActive && sessionState === 'initializing' && <Spinner size="sm" />}
              </button>
            );
          })}
        </div>
      </>
    );
  }

  // ── Desktop inline bar ──
  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-2)', padding: 'var(--sam-space-2) var(--sam-space-4)' }}>
        <Spinner size="sm" />
        <span style={{ fontSize: '0.875rem', color: 'var(--sam-color-fg-muted)' }}>Loading agents...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 'var(--sam-space-2) var(--sam-space-4)', fontSize: '0.875rem', color: 'var(--sam-color-danger)' }}>
        {error}
      </div>
    );
  }

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--sam-space-2)',
      padding: 'var(--sam-space-2) var(--sam-space-4)',
      backgroundColor: 'var(--sam-color-bg-inset)',
      borderBottom: '1px solid var(--sam-color-border-default)',
    }}>
      <span style={{
        fontSize: '0.75rem',
        fontWeight: 500,
        color: 'var(--sam-color-fg-muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        marginRight: 'var(--sam-space-2)',
      }}>Agent:</span>
      {agents.map((agent) => {
        const isActive = agent.id === activeAgentType;
        const isInitializing = isActive && (sessionState === 'initializing' || sessionState === 'connecting');
        const canClick = agent.configured && wsConnected;

        const buttonStyle: React.CSSProperties = {
          display: 'inline-flex',
          alignItems: 'center',
          padding: '6px 12px',
          borderRadius: 'var(--sam-radius-md)',
          fontSize: '0.875rem',
          fontWeight: 500,
          transition: 'all 0.15s ease',
          cursor: canClick ? 'pointer' : 'not-allowed',
          border: 'none',
          ...(isActive
            ? {
                backgroundColor: 'var(--sam-color-accent-primary)',
                color: '#ffffff',
                boxShadow: '0 1px 2px rgba(0, 0, 0, 0.2)',
              }
            : canClick
              ? {
                  backgroundColor: 'var(--sam-color-bg-surface)',
                  color: 'var(--sam-color-fg-primary)',
                  border: '1px solid var(--sam-color-border-default)',
                }
              : {
                  backgroundColor: 'var(--sam-color-bg-inset)',
                  color: 'var(--sam-color-fg-muted)',
                  border: '1px solid var(--sam-color-border-default)',
                  opacity: 0.6,
                }),
        };

        return (
          <button
            key={agent.id}
            onClick={() => canClick ? onSelectAgent(agent.id) : undefined}
            disabled={!canClick}
            title={!agent.configured
              ? 'API key not configured — add it in Settings'
              : !wsConnected
                ? 'Connecting to workspace...'
                : agent.description}
            style={buttonStyle}
          >
            {isInitializing && (
              <span style={{ marginRight: '6px', display: 'inline-flex' }}>
                <Spinner size="sm" />
              </span>
            )}
            {agent.name}
            {!agent.configured && (
              <span style={{ marginLeft: '6px', fontSize: '0.75rem', opacity: 0.75 }}>
                (no key)
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
