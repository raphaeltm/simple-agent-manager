/**
 * Project-scope unified agents section. Replaces the former
 * ProjectAgentDefaultsSection + ProjectAgentCredentialsSection split with a
 * single ProjectAgentCard per agent covering both credential overrides and
 * model/permission overrides.
 */
import type {
  AgentCredentialInfo,
  AgentInfo,
  AgentPermissionMode,
  AgentType,
  CredentialKind,
  ProjectAgentDefaults,
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
  updateProject,
} from '../lib/api';
import { ProjectAgentCard } from './ProjectAgentCard';

interface ProjectAgentsSectionProps {
  projectId: string;
  initialAgentDefaults: ProjectAgentDefaults | null | undefined;
  onUpdated: (next: ProjectAgentDefaults | null) => void;
}

export function ProjectAgentsSection({
  projectId,
  initialAgentDefaults,
  onUpdated,
}: ProjectAgentsSectionProps) {
  const toast = useToast();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [projectCreds, setProjectCreds] = useState<AgentCredentialInfo[]>([]);
  const [userCreds, setUserCreds] = useState<AgentCredentialInfo[]>([]);
  const [defaults, setDefaults] = useState<ProjectAgentDefaults>(initialAgentDefaults ?? {});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDefaults(initialAgentDefaults ?? {});
  }, [initialAgentDefaults]);

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
      setError(err instanceof Error ? err.message : 'Failed to load project agent data');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleSaveCredential = async (req: SaveAgentCredentialRequest) => {
    const result = await saveProjectAgentCredential(projectId, req);
    toast.success('Project credential override saved');
    setProjectCreds((prev) => {
      const filtered = prev.filter(
        (c) => !(c.agentType === req.agentType && c.credentialKind === req.credentialKind),
      );
      return [...filtered, result];
    });
  };

  const handleDeleteCredential = async (agentType: AgentType, credentialKind: CredentialKind) => {
    await deleteProjectAgentCredential(projectId, agentType, credentialKind);
    toast.success('Project override cleared — falling back to user credential');
    setProjectCreds((prev) =>
      prev.filter((c) => !(c.agentType === agentType && c.credentialKind === credentialKind)),
    );
  };

  const handleSaveDefault = async (
    agentType: AgentType,
    entry: { model: string | null; permissionMode: AgentPermissionMode | null },
  ) => {
    const next: ProjectAgentDefaults = { ...defaults };
    if (entry.model === null && entry.permissionMode === null) {
      delete next[agentType];
    } else {
      next[agentType] = {
        model: entry.model,
        permissionMode: entry.permissionMode,
      };
    }
    const payload = Object.keys(next).length === 0 ? null : next;
    const updated = await updateProject(projectId, { agentDefaults: payload });
    setDefaults(updated.agentDefaults ?? {});
    onUpdated(updated.agentDefaults ?? null);
  };

  const handleClearDefault = async (agentType: AgentType) => {
    const next: ProjectAgentDefaults = { ...defaults };
    delete next[agentType];
    const payload = Object.keys(next).length === 0 ? null : next;
    const updated = await updateProject(projectId, { agentDefaults: payload });
    setDefaults(updated.agentDefaults ?? {});
    onUpdated(updated.agentDefaults ?? null);
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
    <div className="flex flex-col gap-4" data-testid="project-agents-section">
      <Alert variant="info">
        Project overrides apply only to this project. Clear an override to fall back to your
        user-level setting. Credentials and configuration fall through independently.
      </Alert>

      {agents.map((agent) => {
        const projectAgentCreds = projectCreds.filter((c) => c.agentType === agent.id);
        const userAgentCreds = userCreds.filter((c) => c.agentType === agent.id);
        return (
          <ProjectAgentCard
            key={agent.id}
            agent={agent}
            projectCredentials={projectAgentCreds.length > 0 ? projectAgentCreds : null}
            userCredentials={userAgentCreds}
            defaultValue={defaults[agent.id]}
            onSaveCredential={handleSaveCredential}
            onDeleteCredential={handleDeleteCredential}
            onSaveDefault={handleSaveDefault}
            onClearDefault={handleClearDefault}
          />
        );
      })}
    </div>
  );
}
