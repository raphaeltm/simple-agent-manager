import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ProjectRuntimeConfigResponse, ProviderCatalog, VMSize } from '@simple-agent-manager/shared';
import {
  AGENT_CATALOG,
  DEFAULT_WORKSPACE_IDLE_TIMEOUT_MS,
  MIN_WORKSPACE_IDLE_TIMEOUT_MS,
  MAX_WORKSPACE_IDLE_TIMEOUT_MS,
} from '@simple-agent-manager/shared';
import { Button, Spinner, Skeleton } from '@simple-agent-manager/ui';
import {
  getProjectRuntimeConfig,
  getProviderCatalog,
  updateProject,
  deleteProject,
  upsertProjectRuntimeEnvVar,
  deleteProjectRuntimeEnvVar,
  upsertProjectRuntimeFile,
  deleteProjectRuntimeFile,
} from '../lib/api';
import { useToast } from '../hooks/useToast';
import { useAgentProfiles } from '../hooks/useAgentProfiles';
import { useProjectContext } from './ProjectContext';
import { DeploymentSettings } from '../components/DeploymentSettings';
import { ProfileList } from '../components/agent-profiles/ProfileList';
import { ScalingSettings } from '../components/ScalingSettings';

const FALLBACK_VM_SIZES: { value: VMSize; label: string; description: string }[] = [
  { value: 'small', label: 'Small', description: '2-3 vCPUs, 4 GB RAM' },
  { value: 'medium', label: 'Medium', description: '4 vCPUs, 8-12 GB RAM' },
  { value: 'large', label: 'Large', description: '8 vCPUs, 16-32 GB RAM' },
];

export function ProjectSettings() {
  const toast = useToast();
  const navigate = useNavigate();
  const { projectId, project, reload } = useProjectContext();

  // Agent profiles
  const {
    profiles: agentProfiles,
    loading: profilesLoading,
    error: profilesError,
    createProfile,
    updateProfile,
    deleteProfile: deleteAgentProfile,
  } = useAgentProfiles(projectId);

  // Project name editing
  const [projectName, setProjectName] = useState(project?.name ?? '');
  const [savingName, setSavingName] = useState(false);

  // Delete project
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);

  const [defaultVmSize, setDefaultVmSize] = useState<VMSize | null>(project?.defaultVmSize ?? null);
  const [savingVmSize, setSavingVmSize] = useState(false);
  const [defaultAgentType, setDefaultAgentType] = useState<string | null>(project?.defaultAgentType ?? null);
  const [savingAgentType, setSavingAgentType] = useState(false);

  // Workspace idle timeout (node idle timeout is managed in ScalingSettings)
  const [workspaceIdleTimeoutMs, setWorkspaceIdleTimeoutMs] = useState<number>(
    project?.workspaceIdleTimeoutMs ?? DEFAULT_WORKSPACE_IDLE_TIMEOUT_MS
  );
  const [savingWorkspaceTimeout, setSavingWorkspaceTimeout] = useState(false);

  // Provider catalog for accurate VM size descriptions
  const [catalog, setCatalog] = useState<ProviderCatalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);

  useEffect(() => {
    setCatalogLoading(true);
    getProviderCatalog()
      .then((resp) => {
        setCatalog(resp.catalogs[0] ?? null);
      })
      .catch(() => {
        // Catalog unavailable — use fallback descriptions
      })
      .finally(() => {
        setCatalogLoading(false);
      });
  }, []);

  // Build VM size options from catalog or fallback
  const vmSizes = catalog
    ? (['small', 'medium', 'large'] as VMSize[]).map((size) => {
        const info = catalog.sizes[size];
        return {
          value: size,
          label: size.charAt(0).toUpperCase() + size.slice(1),
          description: info
            ? `${info.vcpu} vCPUs, ${info.ramGb} GB RAM \u2014 ${info.price}`
            : size,
        };
      })
    : FALLBACK_VM_SIZES;

  // Sync from project when it reloads
  useEffect(() => {
    if (project) {
      setProjectName(project.name);
      setDefaultVmSize(project.defaultVmSize ?? null);
      setDefaultAgentType(project.defaultAgentType ?? null);
      setWorkspaceIdleTimeoutMs(project.workspaceIdleTimeoutMs ?? DEFAULT_WORKSPACE_IDLE_TIMEOUT_MS);
    }
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

  const handleSaveVmSize = async (size: VMSize) => {
    // If clicking the already-selected size, clear to platform default
    const newSize = size === defaultVmSize ? null : size;
    setSavingVmSize(true);
    setDefaultVmSize(newSize);
    try {
      await updateProject(projectId, { defaultVmSize: newSize });
      await reload();
      toast.success(newSize ? `Default VM size set to ${newSize}` : 'Default VM size cleared (will use platform default)');
    } catch (err) {
      // Revert on error
      setDefaultVmSize(project?.defaultVmSize ?? null);
      toast.error(err instanceof Error ? err.message : 'Failed to update VM size');
    } finally {
      setSavingVmSize(false);
    }
  };

  const handleSaveAgentType = async (agentId: string) => {
    const newType = agentId === defaultAgentType ? null : agentId;
    setSavingAgentType(true);
    setDefaultAgentType(newType);
    try {
      await updateProject(projectId, { defaultAgentType: newType });
      await reload();
      toast.success(newType ? `Default agent set to ${AGENT_CATALOG.find(a => a.id === newType)?.name ?? newType}` : 'Default agent cleared (will use platform default)');
    } catch (err) {
      setDefaultAgentType(project?.defaultAgentType ?? null);
      toast.error(err instanceof Error ? err.message : 'Failed to update agent type');
    } finally {
      setSavingAgentType(false);
    }
  };

  const handleSaveWorkspaceTimeout = async () => {
    setSavingWorkspaceTimeout(true);
    try {
      await updateProject(projectId, { workspaceIdleTimeoutMs });
      await reload();
      toast.success('Workspace idle timeout saved');
    } catch (err) {
      setWorkspaceIdleTimeoutMs(project?.workspaceIdleTimeoutMs ?? DEFAULT_WORKSPACE_IDLE_TIMEOUT_MS);
      toast.error(err instanceof Error ? err.message : 'Failed to update timeout');
    } finally {
      setSavingWorkspaceTimeout(false);
    }
  };

  const [runtimeConfig, setRuntimeConfig] = useState<ProjectRuntimeConfigResponse>({ envVars: [], files: [] });
  const [runtimeConfigLoading, setRuntimeConfigLoading] = useState(true);
  const [savingRuntimeConfig, setSavingRuntimeConfig] = useState(false);

  const [envKeyInput, setEnvKeyInput] = useState('');
  const [envValueInput, setEnvValueInput] = useState('');
  const [envSecretInput, setEnvSecretInput] = useState(false);
  const [filePathInput, setFilePathInput] = useState('');
  const [fileContentInput, setFileContentInput] = useState('');
  const [fileSecretInput, setFileSecretInput] = useState(false);

  const loadRuntimeConfig = useCallback(async () => {
    try {
      setRuntimeConfigLoading(true);
      const config = await getProjectRuntimeConfig(projectId);
      setRuntimeConfig(config);
    } catch {
      toast.error('Failed to load runtime config');
    } finally {
      setRuntimeConfigLoading(false);
    }
  }, [projectId, toast]);

  useEffect(() => { void loadRuntimeConfig(); }, [loadRuntimeConfig]);

  const handleUpsertEnvVar = async () => {
    if (!envKeyInput.trim()) {
      toast.error('Env key is required');
      return;
    }
    try {
      setSavingRuntimeConfig(true);
      const response = await upsertProjectRuntimeEnvVar(projectId, {
        key: envKeyInput.trim(),
        value: envValueInput,
        isSecret: envSecretInput,
      });
      setRuntimeConfig(response);
      setEnvKeyInput('');
      setEnvValueInput('');
      setEnvSecretInput(false);
      toast.success('Runtime env var saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save env var');
    } finally {
      setSavingRuntimeConfig(false);
    }
  };

  const handleDeleteEnvVar = async (envKey: string) => {
    try {
      setSavingRuntimeConfig(true);
      const response = await deleteProjectRuntimeEnvVar(projectId, envKey);
      setRuntimeConfig(response);
      toast.success(`Removed ${envKey}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove env var');
    } finally {
      setSavingRuntimeConfig(false);
    }
  };

  const handleUpsertFile = async () => {
    if (!filePathInput.trim()) {
      toast.error('File path is required');
      return;
    }
    try {
      setSavingRuntimeConfig(true);
      const response = await upsertProjectRuntimeFile(projectId, {
        path: filePathInput.trim(),
        content: fileContentInput,
        isSecret: fileSecretInput,
      });
      setRuntimeConfig(response);
      setFilePathInput('');
      setFileContentInput('');
      setFileSecretInput(false);
      toast.success('Runtime file saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save runtime file');
    } finally {
      setSavingRuntimeConfig(false);
    }
  };

  const handleDeleteFile = async (path: string) => {
    try {
      setSavingRuntimeConfig(true);
      const response = await deleteProjectRuntimeFile(projectId, path);
      setRuntimeConfig(response);
      toast.success(`Removed ${path}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove runtime file');
    } finally {
      setSavingRuntimeConfig(false);
    }
  };

  return (
    <div className="grid gap-4">
      {/* Project Name */}
      <section className="border border-border-default rounded-md bg-surface p-4 grid gap-3">
        <div>
          <h2 className="sam-type-section-heading m-0 text-fg-primary">
            Project Name
          </h2>
          <p className="m-0 mt-1 text-xs text-fg-muted">
            The display name for this project.
          </p>
        </div>
        <div className="flex gap-2 items-end">
          <input
            type="text"
            aria-label="Project name"
            value={projectName}
            onChange={(e) => setProjectName(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleSaveName(); }}
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

      {/* Default VM Size */}
      <section className="border border-border-default rounded-md bg-surface p-4 grid gap-3">
        <div>
          <h2 className="sam-type-section-heading m-0 text-fg-primary">
            Default Node Size
          </h2>
          <p className="m-0 mt-1 text-xs text-fg-muted">
            Used when launching new workspaces from this project. Click again to clear.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {vmSizes.map((size) => {
            const isSelected = defaultVmSize === size.value;
            return (
              <button
                key={size.value}
                type="button"
                aria-pressed={isSelected}
                disabled={savingVmSize || catalogLoading}
                onClick={() => void handleSaveVmSize(size.value)}
                className={`p-3 rounded-md text-left text-fg-primary transition-all ${
                  isSelected
                    ? 'border-2 border-accent bg-accent-tint'
                    : 'border border-border-default bg-inset'
                } ${savingVmSize || catalogLoading ? 'cursor-wait opacity-60' : 'cursor-pointer'}`}
              >
                <div className="font-medium">{size.label}</div>
                <div className="text-xs text-fg-muted mt-0.5">
                  {catalogLoading ? (
                    <Skeleton width="80%" height="10px" />
                  ) : (
                    size.description
                  )}
                </div>
              </button>
            );
          })}
        </div>
        {!defaultVmSize && (
          <div className="text-xs text-fg-muted">
            No default set — workspaces will use the platform default (Medium).
          </div>
        )}
      </section>

      {/* Default Agent Type */}
      <section className="border border-border-default rounded-md bg-surface p-4 grid gap-3">
        <div>
          <h2 className="sam-type-section-heading m-0 text-fg-primary">
            Default Agent Type
          </h2>
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
                    : 'border border-border-default bg-inset'
                } ${savingAgentType ? 'cursor-wait opacity-60' : 'cursor-pointer'}`}
              >
                <div className="font-medium">{agent.name}</div>
                <div className="text-xs text-fg-muted mt-0.5">
                  {agent.description}
                </div>
              </button>
            );
          })}
        </div>
        {!defaultAgentType && (
          <div className="text-xs text-fg-muted">
            No default set — tasks will use the platform default (Claude Code).
          </div>
        )}
      </section>

      {/* Workspace Idle Timeout */}
      <section className="border border-border-default rounded-md bg-surface p-4 grid gap-3">
        <div>
          <h2 className="sam-type-section-heading m-0 text-fg-primary">
            Workspace Idle Timeout
          </h2>
          <p className="m-0 mt-1 text-xs text-fg-muted">
            How long workspaces stay active when idle. Workspaces with no messages or terminal activity beyond the timeout are automatically cleaned up.
          </p>
        </div>
        <div>
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
              Default: {DEFAULT_WORKSPACE_IDLE_TIMEOUT_MS / (60 * 60 * 1000)}h. Range: 30m \u2013 24h.
            </p>
        </div>
        <div className="flex justify-end">
          <Button
            size="sm"
            loading={savingWorkspaceTimeout}
            disabled={
              savingWorkspaceTimeout ||
              workspaceIdleTimeoutMs === (project?.workspaceIdleTimeoutMs ?? DEFAULT_WORKSPACE_IDLE_TIMEOUT_MS)
            }
            onClick={() => void handleSaveWorkspaceTimeout()}
          >
            Save
          </Button>
        </div>
      </section>

      {/* Scaling & Scheduling */}
      {project && (
        <ScalingSettings projectId={projectId} project={project} reload={reload} />
      )}

    {/* Runtime Config */}
    <section className="border border-border-default rounded-md bg-surface p-4 grid gap-3">
      <h2 className="sam-type-section-heading m-0 text-fg-primary">
        Runtime Config
      </h2>

      {runtimeConfigLoading ? (
        <div className="flex items-center gap-2">
          <Spinner size="sm" />
          <span>Loading runtime config...</span>
        </div>
      ) : (
        <div className="grid gap-4">
          {/* Environment Variables */}
          <div className="grid gap-2">
            <h3 className="sam-type-card-title m-0 text-fg-primary">Environment Variables</h3>

            {/* Add form — key and value on same row */}
            <div className="flex gap-2 items-end flex-wrap">
              <div className="flex-[1_1_140px] min-w-0">
                <label className="block text-xs text-fg-muted mb-0.5">Key</label>
                <input
                  type="text"
                  aria-label="Runtime env key"
                  placeholder="API_TOKEN"
                  value={envKeyInput}
                  onChange={(event) => setEnvKeyInput(event.currentTarget.value)}
                  className="block w-full py-1.5 px-2.5 min-h-9 border border-border-default rounded-sm bg-inset text-fg-primary text-[0.8125rem] font-[inherit] box-border"
                />
              </div>
              <div className="flex-[2_1_200px] min-w-0">
                <label className="block text-xs text-fg-muted mb-0.5">Value</label>
                <input
                  type="text"
                  aria-label="Runtime env value"
                  placeholder="Value"
                  value={envValueInput}
                  onChange={(event) => setEnvValueInput(event.currentTarget.value)}
                  className="block w-full py-1.5 px-2.5 min-h-9 border border-border-default rounded-sm bg-inset text-fg-primary text-[0.8125rem] font-[inherit] box-border"
                />
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <label className="flex items-center gap-1 text-xs text-fg-muted cursor-pointer whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={envSecretInput}
                    onChange={(event) => setEnvSecretInput(event.currentTarget.checked)}
                  />
                  Secret
                </label>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleUpsertEnvVar}
                  loading={savingRuntimeConfig}
                  disabled={savingRuntimeConfig}
                  style={{ minHeight: '36px' }}
                >
                  Add
                </Button>
              </div>
            </div>

            {/* Env var list */}
            {runtimeConfig.envVars.length === 0 ? (
              <div className="text-fg-muted text-xs py-1">
                No environment variables configured.
              </div>
            ) : (
              <div className="border border-border-default rounded-sm overflow-hidden">
                {runtimeConfig.envVars.map((item, idx) => (
                  <div
                    key={item.key}
                    className={`flex items-center gap-2 py-1.5 px-2 text-[0.8125rem] ${idx < runtimeConfig.envVars.length - 1 ? 'border-b border-border-default' : ''}`}
                  >
                    <code className="font-semibold text-fg-primary text-[0.8125rem]">{item.key}</code>
                    <span className="text-fg-muted flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                      = {item.isSecret ? '\u2022\u2022\u2022\u2022\u2022\u2022' : item.value}
                    </span>
                    {item.isSecret && (
                      <span className="text-[0.6875rem] text-fg-muted bg-inset px-1.5 py-px rounded-sm shrink-0">secret</span>
                    )}
                    <button
                      onClick={() => void handleDeleteEnvVar(item.key)}
                      disabled={savingRuntimeConfig}
                      className="bg-transparent border-none cursor-pointer text-fg-muted p-1 rounded-sm inline-flex items-center justify-center shrink-0 transition-colors hover:text-danger"
                      aria-label={`Remove ${item.key}`}
                      title={`Remove ${item.key}`}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Runtime Files */}
          <div className="grid gap-2">
            <h3 className="sam-type-card-title m-0 text-fg-primary">Runtime Files</h3>

            {/* Add form */}
            <div className="grid gap-2">
              <div>
                <label className="block text-xs text-fg-muted mb-0.5">File path</label>
                <input
                  type="text"
                  aria-label="Runtime file path"
                  placeholder=".env.local"
                  value={filePathInput}
                  onChange={(event) => setFilePathInput(event.currentTarget.value)}
                  className="block w-full py-1.5 px-2.5 min-h-9 border border-border-default rounded-sm bg-inset text-fg-primary text-[0.8125rem] font-[inherit] box-border"
                />
              </div>
              <div>
                <label className="block text-xs text-fg-muted mb-0.5">Content</label>
                <textarea
                  aria-label="Runtime file content"
                  placeholder="FOO=bar"
                  rows={3}
                  value={fileContentInput}
                  onChange={(event) => setFileContentInput(event.currentTarget.value)}
                  className="block w-full py-1.5 px-2.5 border border-border-default rounded-sm bg-inset text-fg-primary text-[0.8125rem] font-mono resize-y box-border"
                />
              </div>
              <div className="flex justify-between items-center gap-2 flex-wrap">
                <label className="flex items-center gap-1 text-xs text-fg-muted cursor-pointer">
                  <input
                    type="checkbox"
                    checked={fileSecretInput}
                    onChange={(event) => setFileSecretInput(event.currentTarget.checked)}
                  />
                  Secret file content
                </label>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleUpsertFile}
                  loading={savingRuntimeConfig}
                  disabled={savingRuntimeConfig}
                  style={{ minHeight: '36px' }}
                >
                  Add file
                </Button>
              </div>
            </div>

            {/* File list */}
            {runtimeConfig.files.length === 0 ? (
              <div className="text-fg-muted text-xs py-1">
                No runtime files configured.
              </div>
            ) : (
              <div className="border border-border-default rounded-sm overflow-hidden">
                {runtimeConfig.files.map((item, idx) => (
                  <div
                    key={item.path}
                    className={`flex items-center gap-2 py-1.5 px-2 text-[0.8125rem] ${idx < runtimeConfig.files.length - 1 ? 'border-b border-border-default' : ''}`}
                  >
                    <code className="font-semibold text-fg-primary text-[0.8125rem] overflow-hidden text-ellipsis whitespace-nowrap min-w-0">{item.path}</code>
                    <span className="flex-1" />
                    {item.isSecret && (
                      <span className="text-[0.6875rem] text-fg-muted bg-inset px-1.5 py-px rounded-sm shrink-0">secret</span>
                    )}
                    <button
                      onClick={() => void handleDeleteFile(item.path)}
                      disabled={savingRuntimeConfig}
                      className="bg-transparent border-none cursor-pointer text-fg-muted p-1 rounded-sm inline-flex items-center justify-center shrink-0 transition-colors hover:text-danger"
                      aria-label={`Remove ${item.path}`}
                      title={`Remove ${item.path}`}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </section>

      {/* Deploy to Cloud */}
      <DeploymentSettings projectId={projectId} />

      {/* Agent Profiles */}
      <section className="border border-border-default rounded-md bg-surface p-4">
        <ProfileList
          profiles={agentProfiles}
          loading={profilesLoading}
          error={profilesError}
          onCreateProfile={createProfile}
          onUpdateProfile={updateProfile}
          onDeleteProfile={deleteAgentProfile}
        />
      </section>

      {/* Danger Zone */}
      <section className="border border-danger rounded-md bg-surface p-4 grid gap-3">
        <div>
          <h2 className="sam-type-section-heading m-0 text-danger">
            Danger Zone
          </h2>
          <p className="m-0 mt-1 text-xs text-fg-muted">
            Permanently delete this project and all associated data. This action cannot be undone.
          </p>
        </div>
        {!showDeleteConfirm ? (
          <div>
            <Button
              variant="danger"
              size="sm"
              onClick={() => setShowDeleteConfirm(true)}
            >
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
                onClick={() => { setShowDeleteConfirm(false); setDeleteConfirmText(''); }}
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
