import { useState, useEffect, useCallback } from 'react';
import { listAgents } from '../lib/api';
import { Spinner } from '@simple-agent-manager/ui';
import type { AgentInfo } from '@simple-agent-manager/shared';
import type { AcpSessionState } from '@simple-agent-manager/acp-client';

interface AgentSelectorProps {
  activeAgentType: string | null;
  sessionState: AcpSessionState;
  onSelectAgent: (agentType: string) => void;
}

export function AgentSelector({ activeAgentType, sessionState, onSelectAgent }: AgentSelectorProps) {
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

        const buttonStyle: React.CSSProperties = {
          display: 'inline-flex',
          alignItems: 'center',
          padding: '6px 12px',
          borderRadius: 'var(--sam-radius-md)',
          fontSize: '0.875rem',
          fontWeight: 500,
          transition: 'all 0.15s ease',
          cursor: agent.configured ? 'pointer' : 'not-allowed',
          border: 'none',
          ...(isActive
            ? {
                backgroundColor: 'var(--sam-color-accent-primary)',
                color: '#ffffff',
                boxShadow: '0 1px 2px rgba(0, 0, 0, 0.2)',
              }
            : agent.configured
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
            onClick={() => agent.configured ? onSelectAgent(agent.id) : undefined}
            disabled={!agent.configured}
            title={agent.configured ? agent.description : 'API key not configured — add it in Settings'}
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
