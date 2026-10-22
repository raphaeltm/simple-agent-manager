import { AGENT_CATALOG } from '@simple-agent-manager/shared';
import { useEffect, useState } from 'react';

import { useToast } from '../../hooks/useToast';
import { updateProject } from '../../lib/api';
import { useProjectContext } from '../../pages/ProjectContext';
import { ProjectAgentsSection } from '../ProjectAgentsSection';
import { ProjectAgentModelsSection } from './ProjectAgentModelsSection';

/**
 * The Project Settings "Agents" tab. Split out of `pages/ProjectSettings.tsx`
 * once this grew past the 500-line file-size ceiling
 * (`.claude/rules/18-file-size-limits.md`) — `ProjectSettings.tsx` re-exports
 * the name so `App.tsx`'s `lazyNamed(() => import('./pages/ProjectSettings'),
 * 'ProjectSettingsAgents')` route wiring keeps working unchanged.
 */
export function ProjectSettingsAgents() {
  const toast = useToast();
  const { projectId, project, reload } = useProjectContext();
  const [defaultAgentType, setDefaultAgentType] = useState<string | null>(
    project?.defaultAgentType ?? null
  );
  const [savingAgentType, setSavingAgentType] = useState(false);

  useEffect(() => {
    if (project) setDefaultAgentType(project.defaultAgentType ?? null);
  }, [project]);

  const handleSaveAgentType = async (agentId: string) => {
    const newType = agentId === defaultAgentType ? null : agentId;
    setSavingAgentType(true);
    setDefaultAgentType(newType);
    try {
      await updateProject(projectId, { defaultAgentType: newType });
      await reload();
      toast.success(
        newType
          ? `Default agent set to ${AGENT_CATALOG.find((a) => a.id === newType)?.name ?? newType}`
          : 'Default agent cleared (will use platform default)'
      );
    } catch (err) {
      setDefaultAgentType(project?.defaultAgentType ?? null);
      toast.error(err instanceof Error ? err.message : 'Failed to update agent type');
    } finally {
      setSavingAgentType(false);
    }
  };

  return (
    <div className="grid gap-4">
      <section className="glass-surface rounded-lg p-4 grid gap-3">
        <div>
          <h2 className="sam-type-section-heading m-0 text-fg-primary">Default Agent Type</h2>
          <p className="m-0 mt-1 text-xs text-fg-muted">
            Which AI coding agent to use for tasks in this project. Click again to clear.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {AGENT_CATALOG.map((agent) => {
            const isSelected = defaultAgentType === agent.id;
            return (
              <button
                key={agent.id}
                type="button"
                aria-pressed={isSelected}
                disabled={savingAgentType}
                onClick={() => void handleSaveAgentType(agent.id)}
                className={`p-3 rounded-md text-left text-fg-primary transition-all ${
                  isSelected
                    ? 'border-2 border-accent bg-accent-tint'
                    : 'border border-[var(--sam-form-border)] bg-[color-mix(in_srgb,var(--sam-glass-nested-bg)_80%,transparent)]'
                } ${savingAgentType ? 'cursor-wait opacity-60' : 'cursor-pointer'}`}
              >
                <div className="font-medium">{agent.name}</div>
                <div className="text-xs text-fg-muted mt-0.5">{agent.description}</div>
              </button>
            );
          })}
        </div>
        {!defaultAgentType && (
          <div className="text-xs text-fg-muted">
            No default set - tasks will use the platform default (OpenCode).
          </div>
        )}
      </section>

      <section className="glass-surface rounded-lg p-4 grid gap-3">
        <div>
          <h2 className="sam-type-section-heading m-0 text-fg-primary">Agent Overrides</h2>
          <p className="m-0 mt-1 text-xs text-fg-muted">
            Per-agent model and permission-mode overrides for this project. Empty fields fall
            through to your user-level settings.
          </p>
        </div>
        {projectId && (
          <ProjectAgentsSection
            projectId={projectId}
            initialAgentDefaults={project?.agentDefaults ?? null}
            onUpdated={() => {
              void reload();
            }}
          />
        )}
      </section>

      {projectId && <ProjectAgentModelsSection projectId={projectId} />}
    </div>
  );
}
