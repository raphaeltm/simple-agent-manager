import { useState, useEffect, useCallback } from 'react';
import { listAgents } from '../lib/api';
import type { AgentInfo } from '@simple-agent-manager/shared';
import type { AcpSessionState } from '@simple-agent-manager/acp-client';

interface AgentSelectorProps {
  /** Currently active agent type */
  activeAgentType: string | null;
  /** Current session state */
  sessionState: AcpSessionState;
  /** Called when user selects an agent */
  onSelectAgent: (agentType: string) => void;
}

/**
 * Agent picker component that displays available agents as cards.
 * Shows connection status (whether user has API key configured) and
 * highlights the currently active agent.
 */
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
      <div className="flex items-center space-x-2 px-4 py-2">
        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
        <span className="text-sm text-gray-500">Loading agents...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-4 py-2 text-sm text-red-600">{error}</div>
    );
  }

  return (
    <div className="flex items-center space-x-2 px-4 py-2 bg-gray-50 border-b border-gray-200">
      <span className="text-xs font-medium text-gray-500 uppercase tracking-wide mr-2">Agent:</span>
      {agents.map((agent) => {
        const isActive = agent.id === activeAgentType;
        const isInitializing = isActive && (sessionState === 'initializing' || sessionState === 'connecting');

        return (
          <button
            key={agent.id}
            onClick={() => agent.configured ? onSelectAgent(agent.id) : undefined}
            disabled={!agent.configured}
            title={agent.configured ? agent.description : `API key not configured — add it in Settings`}
            className={`
              inline-flex items-center px-3 py-1.5 rounded-md text-sm font-medium transition-colors
              ${isActive
                ? 'bg-blue-600 text-white shadow-sm'
                : agent.configured
                  ? 'bg-white text-gray-700 border border-gray-300 hover:bg-gray-50 hover:border-gray-400'
                  : 'bg-gray-100 text-gray-400 border border-gray-200 cursor-not-allowed'
              }
            `}
          >
            {isInitializing && (
              <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-current mr-1.5"></div>
            )}
            {agent.name}
            {!agent.configured && (
              <span className="ml-1.5 text-xs opacity-75">
                (no key)
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
