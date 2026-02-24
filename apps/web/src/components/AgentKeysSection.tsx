import { useState, useEffect, useCallback } from 'react';
import { AgentKeyCard } from './AgentKeyCard';
import { useToast } from '../hooks/useToast';
import { listAgents, listAgentCredentials, saveAgentCredential, deleteAgentCredential } from '../lib/api';
import { Alert, Spinner } from '@simple-agent-manager/ui';
import type { AgentInfo, AgentCredentialInfo, AgentType, SaveAgentCredentialRequest, CredentialKind } from '@simple-agent-manager/shared';

/**
 * Section for managing all agent API keys.
 */
export function AgentKeysSection() {
  const toast = useToast();
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

  const handleSave = async (request: SaveAgentCredentialRequest) => {
    const result = await saveAgentCredential(request);
    toast.success('Agent credential saved');
    setCredentials((prev) => {
      // Remove old credential of the same type and kind
      const filtered = prev.filter((c) =>
        !(c.agentType === request.agentType && c.credentialKind === request.credentialKind)
      );
      return [...filtered, result];
    });
    setAgents((prev) =>
      prev.map((a) => a.id === request.agentType ? { ...a, configured: true } : a)
    );
  };

  const handleDelete = async (agentType: AgentType, credentialKind: CredentialKind) => {
    // For now, we'll delete all credentials for the agent
    // In Phase 4, we'll implement credential-specific deletion
    await deleteAgentCredential(agentType);
    toast.success('Agent credential removed');
    setCredentials((prev) => prev.filter((c) =>
      !(c.agentType === agentType && c.credentialKind === credentialKind)
    ));

    // Check if any credentials remain for this agent
    const hasRemainingCreds = credentials.some(c =>
      c.agentType === agentType && c.credentialKind !== credentialKind
    );

    if (!hasRemainingCreds) {
      setAgents((prev) =>
        prev.map((a) => a.id === agentType ? { ...a, configured: false } : a)
      );
    }
  };

  if (loading && agents.length === 0) {
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
      {agents.map((agent) => {
        // Filter credentials for this agent
        const agentCredentials = credentials.filter((c) => c.agentType === agent.id);
        return (
          <AgentKeyCard
            key={agent.id}
            agent={agent}
            credentials={agentCredentials.length > 0 ? agentCredentials : null}
            onSave={handleSave}
            onDelete={handleDelete}
          />
        );
      })}
    </div>
  );
}
