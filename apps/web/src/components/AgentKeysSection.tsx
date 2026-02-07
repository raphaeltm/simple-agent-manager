import { useState, useEffect, useCallback } from 'react';
import { AgentKeyCard } from './AgentKeyCard';
import { listAgents, listAgentCredentials, saveAgentCredential, deleteAgentCredential } from '../lib/api';
import { Alert, Spinner } from '@simple-agent-manager/ui';
import type { AgentInfo, AgentCredentialInfo, AgentType } from '@simple-agent-manager/shared';

/**
 * Section for managing all agent API keys.
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
    setCredentials((prev) => {
      const filtered = prev.filter((c) => c.agentType !== agentType);
      return [...filtered, result];
    });
    setAgents((prev) =>
      prev.map((a) => a.id === agentType ? { ...a, configured: true } : a)
    );
  };

  const handleDelete = async (agentType: AgentType) => {
    await deleteAgentCredential(agentType);
    setCredentials((prev) => prev.filter((c) => c.agentType !== agentType));
    setAgents((prev) =>
      prev.map((a) => a.id === agentType ? { ...a, configured: false } : a)
    );
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--sam-space-4)' }}>
        <Spinner size="md" />
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="error">
        {error}
        <button
          onClick={loadData}
          style={{
            marginLeft: 'var(--sam-space-2)',
            color: 'inherit',
            textDecoration: 'underline',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: 'inherit',
          }}
        >
          Retry
        </button>
      </Alert>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sam-space-3)' }}>
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
