import type {
  AgentCredentialInfo,
  AgentInfo,
  AgentSettingsResponse,
  AgentType,
  CredentialKind,
  SaveAgentCredentialRequest,
  SaveAgentSettingsRequest,
} from '@simple-agent-manager/shared';
import { Alert, Spinner } from '@simple-agent-manager/ui';
import { useCallback, useEffect, useState } from 'react';

import { useToast } from '../hooks/useToast';
import {
  deleteAgentCredential,
  deleteAgentSettings,
  getAgentSettings,
  listAgentCredentials,
  listAgents,
  saveAgentCredential,
  saveAgentSettings,
} from '../lib/api';
import { AgentCard } from './AgentCard';

/**
 * Unified user-scope agents section — renders one AgentCard per agent,
 * combining credential status/form and configuration fields in a single card.
 * Replaces the former AgentKeysSection + AgentSettingsSection pair.
 */
export function AgentsSection() {
  const toast = useToast();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [credentials, setCredentials] = useState<AgentCredentialInfo[]>([]);
  const [settingsMap, setSettingsMap] = useState<Record<string, AgentSettingsResponse>>({});
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

      const settingsEntries = await Promise.all(
        agentResult.agents.map(async (agent) => {
          try {
            const s = await getAgentSettings(agent.id);
            return [agent.id, s] as const;
          } catch {
            return [agent.id, null] as const;
          }
        })
      );
      const map: Record<string, AgentSettingsResponse> = {};
      for (const [agentType, s] of settingsEntries) {
        if (s) {
          map[agentType] = s;
        }
      }
      setSettingsMap(map);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load agent data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSaveCredential = async (request: SaveAgentCredentialRequest) => {
    const result = await saveAgentCredential(request);
    toast.success('Agent credential saved');
    setCredentials((prev) => {
      const filtered = prev.filter((c) =>
        !(c.agentType === request.agentType && c.credentialKind === request.credentialKind)
      );
      return [...filtered, result];
    });
    setAgents((prev) =>
      prev.map((a) => a.id === request.agentType ? { ...a, configured: true } : a)
    );
  };

  const handleDeleteCredential = async (agentType: AgentType, credentialKind: CredentialKind) => {
    await deleteAgentCredential(agentType);
    toast.success('Agent credential removed');
    setCredentials((prev) => prev.filter((c) =>
      !(c.agentType === agentType && c.credentialKind === credentialKind)
    ));

    const hasRemainingCreds = credentials.some(c =>
      c.agentType === agentType && c.credentialKind !== credentialKind
    );
    if (!hasRemainingCreds) {
      setAgents((prev) =>
        prev.map((a) => a.id === agentType ? { ...a, configured: false } : a)
      );
    }
  };

  const handleSaveSettings = async (agentType: AgentType, data: SaveAgentSettingsRequest) => {
    const result = await saveAgentSettings(agentType, data);
    setSettingsMap((prev) => ({ ...prev, [agentType]: result }));
  };

  const handleResetSettings = async (agentType: AgentType) => {
    await deleteAgentSettings(agentType);
    setSettingsMap((prev) => {
      const next = { ...prev };
      delete next[agentType];
      return next;
    });
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
    <div className="flex flex-col gap-4">
      {agents.map((agent) => {
        const agentCredentials = credentials.filter((c) => c.agentType === agent.id);
        return (
          <AgentCard
            key={agent.id}
            agent={agent}
            credentials={agentCredentials.length > 0 ? agentCredentials : null}
            settings={settingsMap[agent.id] ?? null}
            onSaveCredential={handleSaveCredential}
            onDeleteCredential={handleDeleteCredential}
            onSaveSettings={handleSaveSettings}
            onResetSettings={handleResetSettings}
          />
        );
      })}
    </div>
  );
}
