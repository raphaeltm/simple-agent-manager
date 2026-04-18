/**
 * Project-scoped agent credentials section (Phase 2 of multi-level config override).
 *
 * Shows per-project overrides for agent credentials. Falls back to user-scoped
 * credentials when no project override exists.
 */
import type {
  AgentCredentialInfo,
  AgentInfo,
  AgentType,
  CredentialKind,
  SaveAgentCredentialRequest,
} from '@simple-agent-manager/shared';
import { Alert, Spinner } from '@simple-agent-manager/ui';
import { useCallback, useEffect, useState } from 'react';

import { useToast } from '../hooks/useToast';
import {
  deleteProjectAgentCredential,
  listAgentCredentials,
  listAgents,
  listProjectAgentCredentials,
  saveProjectAgentCredential,
} from '../lib/api';
import { AgentKeyCard } from './AgentKeyCard';

interface ProjectAgentCredentialsSectionProps {
  projectId: string;
}

export function ProjectAgentCredentialsSection({ projectId }: ProjectAgentCredentialsSectionProps) {
  const toast = useToast();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [projectCreds, setProjectCreds] = useState<AgentCredentialInfo[]>([]);
  const [userCreds, setUserCreds] = useState<AgentCredentialInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      setError(null);
      const [agentResult, projectResult, userResult] = await Promise.all([
        listAgents(),
        listProjectAgentCredentials(projectId),
        listAgentCredentials(),
      ]);
      setAgents(agentResult.agents);
      setProjectCreds(projectResult.credentials);
      setUserCreds(userResult.credentials);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load project credentials');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleSave = async (req: SaveAgentCredentialRequest) => {
    const result = await saveProjectAgentCredential(projectId, req);
    toast.success('Project credential override saved');
    setProjectCreds((prev) => {
      const filtered = prev.filter(
        (c) => !(c.agentType === req.agentType && c.credentialKind === req.credentialKind),
      );
      return [...filtered, result];
    });
  };

  const handleDelete = async (agentType: AgentType, credentialKind: CredentialKind) => {
    await deleteProjectAgentCredential(projectId, agentType, credentialKind);
    toast.success('Project override cleared — falling back to user credential');
    setProjectCreds((prev) =>
      prev.filter((c) => !(c.agentType === agentType && c.credentialKind === credentialKind)),
    );
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
          onClick={() => void loadData()}
          className="ml-2 text-inherit underline bg-transparent border-none cursor-pointer text-[length:inherit]"
        >
          Retry
        </button>
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Alert variant="info">
        These credentials override your user-level credentials for this project only. Clear an
        override to fall back to your user-scoped credential. When no override is set, tasks in this
        project use your user credential.
      </Alert>

      {agents.map((agent) => {
        const projectAgentCreds = projectCreds.filter((c) => c.agentType === agent.id);
        const userAgentCreds = userCreds.filter((c) => c.agentType === agent.id);
        const hasOverride = projectAgentCreds.length > 0;
        const hasUserFallback = userAgentCreds.length > 0;
        const activeUserCred = userAgentCreds.find((c) => c.isActive);

        return (
          <div key={agent.id} className="flex flex-col gap-2">
            <AgentKeyCard
              agent={agent}
              credentials={hasOverride ? projectAgentCreds : null}
              onSave={handleSave}
              onDelete={handleDelete}
            />
            {!hasOverride && hasUserFallback && (
              <div className="text-xs text-fg-muted pl-3">
                Inheriting user credential
                {activeUserCred?.maskedKey ? ` (${activeUserCred.maskedKey})` : ''} — add a project
                override above to use a different key for this project.
              </div>
            )}
            {!hasOverride && !hasUserFallback && (
              <div className="text-xs text-fg-muted pl-3">
                No user credential set. Add one above to override the platform default for this
                project.
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
