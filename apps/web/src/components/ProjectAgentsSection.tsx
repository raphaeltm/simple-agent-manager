/**
 * Project-scope agents section: one ProjectAgentCard per agent with the
 * project's model/permission overrides. Which account the project uses lives in
 * Project settings → Accounts; the cards only summarise it.
 */
import type {
  AgentInfo,
  AgentPermissionMode,
  AgentType,
  ProjectAgentDefaults,
} from '@simple-agent-manager/shared';
import { Alert, Spinner } from '@simple-agent-manager/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { useAccountsData } from '../hooks/useAccounts';
import { useQueryScope } from '../hooks/useQueryScope';
import { updateProject } from '../lib/api';
import { agentCatalogQueryOptions } from '../lib/query-options';
import { ProjectAgentCard } from './ProjectAgentCard';

interface ProjectAgentsSectionProps {
  projectId: string;
  projectName?: string;
  initialAgentDefaults: ProjectAgentDefaults | null | undefined;
  onUpdated: (next: ProjectAgentDefaults | null) => void;
}

export function ProjectAgentsSection({
  projectId,
  projectName,
  initialAgentDefaults,
  onUpdated,
}: ProjectAgentsSectionProps) {
  const queryScope = useQueryScope();
  const catalog = useQuery({
    ...agentCatalogQueryOptions(queryScope),
    enabled: Boolean(queryScope),
  });
  const agents: AgentInfo[] = catalog.data ?? [];
  const project = useMemo(
    () => ({ id: projectId, name: projectName ?? projectId }),
    [projectId, projectName]
  );
  const { model: accounts } = useAccountsData({ project });
  const [defaults, setDefaults] = useState<ProjectAgentDefaults>(initialAgentDefaults ?? {});

  useEffect(() => {
    setDefaults(initialAgentDefaults ?? {});
  }, [initialAgentDefaults]);

  const handleSaveDefault = async (
    agentType: AgentType,
    entry: { model: string | null; permissionMode: AgentPermissionMode | null }
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

  if (catalog.data === undefined && !catalog.error) {
    return (
      <div className="flex justify-center p-4">
        <Spinner size="md" />
      </div>
    );
  }

  if (catalog.data === undefined && catalog.error) {
    return (
      <Alert variant="error">
        {catalog.error instanceof Error ? catalog.error.message : 'Failed to load project agents'}
        <button
          onClick={() => void catalog.refetch()}
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
        Overrides apply only to this project. Clear one to fall back to your defaults in Settings →
        Agents.
      </Alert>

      {agents.map((agent) => {
        const group = accounts?.agents.find((candidate) => candidate.provider.id === agent.id);
        return (
          <ProjectAgentCard
            key={agent.id}
            agent={agent}
            projectId={projectId}
            account={
              accounts ? (group?.resolutions.get(projectId) ?? { source: 'none' }) : undefined
            }
            defaultValue={defaults[agent.id]}
            onSaveDefault={handleSaveDefault}
            onClearDefault={handleClearDefault}
          />
        );
      })}
    </div>
  );
}
