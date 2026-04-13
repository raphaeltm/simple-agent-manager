import type { AgentCredentialInfo, AgentInfo, AgentType, CredentialKind, OpenCodeProvider, SaveAgentCredentialRequest } from '@simple-agent-manager/shared';
import { Alert, Spinner } from '@simple-agent-manager/ui';
import { useCallback, useEffect, useState } from 'react';

import { useToast } from '../hooks/useToast';
import { deleteAgentCredential, getAgentSettings, listAgentCredentials, listAgents, saveAgentCredential } from '../lib/api';
import { AgentKeyCard } from './AgentKeyCard';

/**
 * Section for managing all agent API keys.
 */
export function AgentKeysSection() {
  const toast = useToast();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [credentials, setCredentials] = useState<AgentCredentialInfo[]>([]);
  const [opencodeProvider, setOpencodeProvider] = useState<OpenCodeProvider | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      setError(null);
      const [agentResult, credResult, opencodeSettings] = await Promise.all([
        listAgents(),
        listAgentCredentials(),
        getAgentSettings('opencode').catch(() => null),
      ]);
      setAgents(agentResult.agents);
      setCredentials(credResult.credentials);
      setOpencodeProvider((opencodeSettings?.opencodeProvider as OpenCodeProvider) ?? null);
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
      <div className="flex justify-center p-4">
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
          className="ml-2 text-inherit underline bg-transparent border-none cursor-pointer text-[length:inherit]"
        >
          Retry
        </button>
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-3">
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
            opencodeProvider={agent.id === 'opencode' ? opencodeProvider : undefined}
          />
        );
      })}
    </div>
  );
}
