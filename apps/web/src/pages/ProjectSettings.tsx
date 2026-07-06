import type { VMSize } from '@simple-agent-manager/shared';
import {
  AGENT_CATALOG,
  DEFAULT_WORKSPACE_IDLE_TIMEOUT_MS,
  MAX_WORKSPACE_IDLE_TIMEOUT_MS,
  MIN_WORKSPACE_IDLE_TIMEOUT_MS,
} from '@simple-agent-manager/shared';
import { Button, Tabs } from '@simple-agent-manager/ui';
import { useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation, useNavigate } from 'react-router';

import { DeploymentSettings } from '../components/DeploymentSettings';
import { ProjectConnectionsSection } from '../components/project-settings/ProjectConnectionsSection';
import { ProjectMembersSection } from '../components/project-settings/ProjectMembersSection';
import { ProjectRuntimeConfigSection } from '../components/project-settings/ProjectRuntimeConfigSection';
import { ProjectAgentsSection } from '../components/ProjectAgentsSection';
import { RepositoryAccessSettings } from '../components/RepositoryAccessSettings';
import { ScalingSettings } from '../components/ScalingSettings';
import {
  formatProviderCatalogContext,
  selectProviderCatalog,
} from '../components/vm/format-vm-size';
import { VmSizeCard } from '../components/vm/VmSizeCard';
import { useProviderCatalog } from '../hooks/useProviderCatalog';
import { useToast } from '../hooks/useToast';
import { deleteProject, updateProject } from '../lib/api';
import { useProjectContext } from './ProjectContext';

const PROJECT_SETTINGS_TABS = [
  { id: 'general', label: 'General', path: 'general' },
  { id: 'access', label: 'Access', path: 'access' },
  { id: 'connections', label: 'Connections', path: 'connections' },
  { id: 'agents', label: 'Agents', path: 'agents' },
  { id: 'infrastructure', label: 'Infrastructure', path: 'infrastructure' },
  { id: 'runtime', label: 'Runtime', path: 'runtime' },
  { id: 'deploy', label: 'Deploy', path: 'deploy' },
];

export function ProjectSettings() {
  const { projectId, project } = useProjectContext();

  return (
    <div className="grid gap-4 min-w-0">
      <div className="grid gap-1">
        <h1 className="sam-type-page-title m-0 text-fg-primary">Project Settings</h1>
        <div className="text-xs text-fg-muted truncate">{project?.name ?? projectId}</div>
      </div>

      <Tabs
        tabs={PROJECT_SETTINGS_TABS}
        basePath={`/projects/${projectId}/settings`}
        className="rounded-md border border-border-default"
      />

      <Outlet />
    </div>
  );
}

export function ProjectSettingsIndexRedirect() {
  const location = useLocation();
  const target = /gcp_deploy_(setup|error)=/.test(location.search)
    ? `deploy${location.search}`
    : 'general';

  return <Navigate to={target} replace />;
}

export function ProjectSettingsGeneral() {
  const toast = useToast();
  const navigate = useNavigate();
  const { projectId, project, reload } = useProjectContext();
  const [projectName, setProjectName] = useState(project?.name ?? '');
  const [savingName, setSavingName] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (project) setProjectName(project.name);
  }, [project]);

  const handleSaveName = async () => {
    const trimmed = projectName.trim();
    if (!trimmed || trimmed === project?.name) return;
    setSavingName(true);
    try {
      await updateProject(projectId, { name: trimmed });
      await reload();
      toast.success('Project renamed');
    } catch (err) {
      setProjectName(project?.name ?? '');
      toast.error(err instanceof Error ? err.message : 'Failed to rename project');
    } finally {
      setSavingName(false);
    }
  };

  const handleDeleteProject = async () => {
    setDeleting(true);
    try {
      await deleteProject(projectId);
      toast.success('Project deleted');
      navigate('/');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete project');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="grid gap-4">
      <section className="glass-surface rounded-lg p-4 grid gap-3">
        <div>
          <h2 className="sam-type-section-heading m-0 text-fg-primary">Project Name</h2>
          <p className="m-0 mt-1 text-xs text-fg-muted">The display name for this project.</p>
        </div>
        <div className="flex gap-2 items-end">
          <input
            type="text"
            aria-label="Project name"
            value={projectName}
            onChange={(e) => setProjectName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleSaveName();
            }}
            className="flex-1 py-1.5 px-2.5 min-h-9 border border-border-default rounded-sm bg-inset text-fg-primary text-[0.8125rem] font-[inherit] box-border"
          />
          <Button
            size="sm"
            loading={savingName}
            disabled={savingName || !projectName.trim() || projectName.trim() === project?.name}
            onClick={() => void handleSaveName()}
          >
            Rename
          </Button>
        </div>
      </section>

      <section className="bg-[color-mix(in_srgb,var(--sam-glass-nested-bg)_60%,transparent)] backdrop-blur-[12px] rounded-lg border border-danger p-4 grid gap-3">
        <div>
          <h2 className="sam-type-section-heading m-0 text-danger">Danger Zone</h2>
          <p className="m-0 mt-1 text-xs text-fg-muted">
            Permanently delete this project and all associated data. This action cannot be undone.
          </p>
        </div>
        {!showDeleteConfirm ? (
          <div>
            <Button variant="danger" size="sm" onClick={() => setShowDeleteConfirm(true)}>
              Delete Project
            </Button>
          </div>
        ) : (
          <div className="grid gap-2">
            <p className="m-0 text-sm text-fg-primary">
              Type <strong>{project?.name}</strong> to confirm deletion:
            </p>
            <input
              type="text"
              aria-label="Confirm project name"
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.currentTarget.value)}
              placeholder={project?.name ?? ''}
              className="py-1.5 px-2.5 min-h-9 border border-danger rounded-sm bg-inset text-fg-primary text-[0.8125rem] font-[inherit] box-border"
            />
            <div className="flex gap-2">
              <Button
                variant="danger"
                size="sm"
                loading={deleting}
                disabled={deleting || deleteConfirmText !== project?.name}
                onClick={() => void handleDeleteProject()}
              >
                Permanently Delete
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={deleting}
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setDeleteConfirmText('');
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

export function ProjectSettingsAccess() {
  const { projectId, project } = useProjectContext();

  return (
    <div className="grid gap-4">
      {project && <RepositoryAccessSettings project={project} />}
      <ProjectMembersSection projectId={projectId} />
    </div>
  );
}

export function ProjectSettingsConnections() {
  const { projectId, reload } = useProjectContext();

  return (
    <ProjectConnectionsSection projectId={projectId} onUpdated={() => void reload()} />
  );
}

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
    </div>
  );
}

export function ProjectSettingsInfrastructure() {
  const toast = useToast();
  const { projectId, project, reload } = useProjectContext();
  const [defaultVmSize, setDefaultVmSize] = useState<VMSize | null>(project?.defaultVmSize ?? null);
  const [savingVmSize, setSavingVmSize] = useState(false);
  const [workspaceIdleTimeoutMs, setWorkspaceIdleTimeoutMs] = useState<number>(
    project?.workspaceIdleTimeoutMs ?? DEFAULT_WORKSPACE_IDLE_TIMEOUT_MS
  );
  const [savingWorkspaceTimeout, setSavingWorkspaceTimeout] = useState(false);

  const { catalogs, loading: catalogLoading } = useProviderCatalog();
  const activeCatalog = selectProviderCatalog(catalogs, project?.defaultProvider);
  const catalogContext = formatProviderCatalogContext(activeCatalog, project?.defaultLocation);

  useEffect(() => {
    if (project) {
      setDefaultVmSize(project.defaultVmSize ?? null);
      setWorkspaceIdleTimeoutMs(
        project.workspaceIdleTimeoutMs ?? DEFAULT_WORKSPACE_IDLE_TIMEOUT_MS
      );
    }
  }, [project]);

  const handleSaveVmSize = async (size: VMSize) => {
    const newSize = size === defaultVmSize ? null : size;
    setSavingVmSize(true);
    setDefaultVmSize(newSize);
    try {
      await updateProject(projectId, { defaultVmSize: newSize });
      await reload();
      toast.success(
        newSize
          ? `Default VM size set to ${newSize}`
          : 'Default VM size cleared (will use platform default)'
      );
    } catch (err) {
      setDefaultVmSize(project?.defaultVmSize ?? null);
      toast.error(err instanceof Error ? err.message : 'Failed to update VM size');
    } finally {
      setSavingVmSize(false);
    }
  };

  const handleSaveWorkspaceTimeout = async () => {
    setSavingWorkspaceTimeout(true);
    try {
      await updateProject(projectId, { workspaceIdleTimeoutMs });
      await reload();
      toast.success('Workspace idle timeout saved');
    } catch (err) {
      setWorkspaceIdleTimeoutMs(
        project?.workspaceIdleTimeoutMs ?? DEFAULT_WORKSPACE_IDLE_TIMEOUT_MS
      );
      toast.error(err instanceof Error ? err.message : 'Failed to update timeout');
    } finally {
      setSavingWorkspaceTimeout(false);
    }
  };

  return (
    <div className="grid gap-4">
      <section className="glass-surface rounded-lg p-4 grid gap-3">
        <div>
          <h2 className="sam-type-section-heading m-0 text-fg-primary">Default Node Size</h2>
          <p className="m-0 mt-1 text-xs text-fg-muted">
            Used when launching new workspaces from this project. Click again to clear.
            {catalogContext
              ? ` Catalog: ${catalogContext}.`
              : ' Exact specs depend on the selected provider.'}
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {(['small', 'medium', 'large'] as VMSize[]).map((size) => (
            <VmSizeCard
              key={size}
              size={size}
              sizeInfo={activeCatalog?.sizes[size] ?? null}
              selected={defaultVmSize === size}
              disabled={savingVmSize || catalogLoading}
              onClick={() => void handleSaveVmSize(size)}
            />
          ))}
        </div>
        {!defaultVmSize && (
          <div className="text-xs text-fg-muted">
            No default set - workspaces will use the platform default (Medium).
          </div>
        )}
      </section>

      <section className="glass-surface rounded-lg p-4 grid gap-3">
        <div>
          <h2 className="sam-type-section-heading m-0 text-fg-primary">Workspace Idle Timeout</h2>
          <p className="m-0 mt-1 text-xs text-fg-muted">
            How long workspaces stay active when idle. Workspaces with no messages or terminal
            activity beyond the timeout are automatically cleaned up.
          </p>
        </div>
        <div>
          <label htmlFor="workspace-idle-timeout" className="sr-only">
            Workspace idle timeout
          </label>
          <div className="flex items-center gap-3">
            <input
              id="workspace-idle-timeout"
              type="range"
              min={MIN_WORKSPACE_IDLE_TIMEOUT_MS}
              max={MAX_WORKSPACE_IDLE_TIMEOUT_MS}
              step={MIN_WORKSPACE_IDLE_TIMEOUT_MS}
              value={workspaceIdleTimeoutMs}
              onChange={(e) => setWorkspaceIdleTimeoutMs(Number(e.target.value))}
              aria-valuetext={
                workspaceIdleTimeoutMs >= 60 * 60 * 1000
                  ? `${(workspaceIdleTimeoutMs / (60 * 60 * 1000)).toFixed(1)} hours`
                  : `${(workspaceIdleTimeoutMs / (60 * 1000)).toFixed(0)} minutes`
              }
              className="flex-1 accent-[var(--sam-color-accent-primary)] h-2 cursor-pointer"
            />
            <span
              aria-live="polite"
              aria-atomic="true"
              className="text-sm text-fg-primary font-medium min-w-[4rem] text-right tabular-nums"
            >
              {workspaceIdleTimeoutMs >= 60 * 60 * 1000
                ? `${(workspaceIdleTimeoutMs / (60 * 60 * 1000)).toFixed(1)}h`
                : `${(workspaceIdleTimeoutMs / (60 * 1000)).toFixed(0)}m`}
            </span>
          </div>
          <p className="m-0 mt-1 text-xs text-fg-muted">
            Default: {DEFAULT_WORKSPACE_IDLE_TIMEOUT_MS / (60 * 60 * 1000)}h. Range: 30m - 24h.
          </p>
        </div>
        <div className="flex justify-end">
          <Button
            size="sm"
            loading={savingWorkspaceTimeout}
            disabled={
              savingWorkspaceTimeout ||
              workspaceIdleTimeoutMs ===
                (project?.workspaceIdleTimeoutMs ?? DEFAULT_WORKSPACE_IDLE_TIMEOUT_MS)
            }
            onClick={() => void handleSaveWorkspaceTimeout()}
          >
            Save
          </Button>
        </div>
      </section>

      {project && <ScalingSettings projectId={projectId} project={project} reload={reload} />}
    </div>
  );
}

export function ProjectSettingsRuntime() {
  const { projectId } = useProjectContext();

  return <ProjectRuntimeConfigSection projectId={projectId} />;
}

export function ProjectSettingsDeploy() {
  const { projectId } = useProjectContext();

  return <DeploymentSettings projectId={projectId} />;
}
