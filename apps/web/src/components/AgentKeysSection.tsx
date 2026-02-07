import { useState, useEffect, useCallback } from 'react';
import { AgentKeyCard } from './AgentKeyCard';
import { listAgents, listAgentCredentials, saveAgentCredential, deleteAgentCredential } from '../lib/api';
import type { AgentInfo, AgentCredentialInfo, AgentType } from '@simple-agent-manager/shared';

/**
 * Section for managing all agent API keys.
 * Fetches agent catalog and credentials, renders an AgentKeyCard per agent.
 */
export function AgentKeysSection() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [credentials, setCredentials] = useState<AgentCredentialInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      setError(null);
      const [agentResult, credResult] = await Promise.all([
        listAgents(),
        listAgentCredentials(),
      ]);
      setAgents(agentResult.agents);
      setCredentials(credResult.credentials);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load agent data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSave = async (agentType: AgentType, apiKey: string) => {
    const result = await saveAgentCredential({ agentType, apiKey });
    // Optimistic update: replace or add credential
    setCredentials((prev) => {
      const filtered = prev.filter((c) => c.agentType !== agentType);
      return [...filtered, result];
    });
    // Also update agent configured status
    setAgents((prev) =>
      prev.map((a) => a.id === agentType ? { ...a, configured: true } : a)
    );
  };

  const handleDelete = async (agentType: AgentType) => {
    await deleteAgentCredential(agentType);
    // Optimistic update: remove credential
    setCredentials((prev) => prev.filter((c) => c.agentType !== agentType));
    setAgents((prev) =>
      prev.map((a) => a.id === agentType ? { ...a, configured: false } : a)
    );
  };

  if (loading) {
    return (
      <div className="flex justify-center py-4">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
        {error}
        <button onClick={loadData} className="ml-2 text-red-800 underline hover:no-underline">
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {agents.map((agent) => (
        <AgentKeyCard
          key={agent.id}
          agent={agent}
          credential={credentials.find((c) => c.agentType === agent.id) ?? null}
          onSave={handleSave}
          onDelete={handleDelete}
        />
      ))}
    </div>
  );
}
