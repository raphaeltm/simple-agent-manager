/**
 * SettingsDrawer — slide-over panel for project settings.
 *
 * Renders the same settings content (VM size, env vars, runtime files)
 * as the ProjectSettings page but in a drawer overlay. Opened via the
 * gear icon in the project header.
 *
 * See: specs/022-simplified-chat-ux/tasks.md (T038-T040)
 */
import type { ProjectRuntimeConfigResponse, VMSize, WorkspaceProfile } from '@simple-agent-manager/shared';
import { Button, Spinner } from '@simple-agent-manager/ui';
import { type FC, useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useToast } from '../../hooks/useToast';
import {
  deleteProjectRuntimeEnvVar,
  deleteProjectRuntimeFile,
  getProjectRuntimeConfig,
  updateProject,
  upsertProjectRuntimeEnvVar,
  upsertProjectRuntimeFile,
} from '../../lib/api';
import { useProjectContext } from '../../pages/ProjectContext';
import { DeploymentSettings } from '../DeploymentSettings';

const VM_SIZES: { value: VMSize; label: string; description: string }[] = [
  { value: 'small', label: 'Small', description: '2 vCPUs, 4 GB RAM' },
  { value: 'medium', label: 'Medium', description: '4 vCPUs, 8 GB RAM' },
  { value: 'large', label: 'Large', description: '8 vCPUs, 16 GB RAM' },
];

const WORKSPACE_PROFILES: { value: WorkspaceProfile; label: string; description: string }[] = [
  { value: 'full', label: 'Full', description: 'Build project devcontainer' },
  { value: 'lightweight', label: 'Lightweight', description: 'Skip build, ~20s startup' },
];

interface SettingsDrawerProps {
  open: boolean;
  onClose: () => void;
}

export const SettingsDrawer: FC<SettingsDrawerProps> = ({ open, onClose }) => {
  const toast = useToast();
  const navigate = useNavigate();
  const { projectId, project, reload } = useProjectContext();
  const drawerRef = useRef<HTMLDivElement>(null);

  // Track dirty state for unsaved changes confirmation (T040)
  const [isDirty, setIsDirty] = useState(false);

  // VM size
  const [defaultVmSize, setDefaultVmSize] = useState<VMSize | null>(project?.defaultVmSize ?? null);
  const [savingVmSize, setSavingVmSize] = useState(false);

  // Workspace profile
  const [defaultWorkspaceProfile, setDefaultWorkspaceProfile] = useState<WorkspaceProfile | null>(
    (project?.defaultWorkspaceProfile as WorkspaceProfile | null) ?? null
  );
  const [savingWorkspaceProfile, setSavingWorkspaceProfile] = useState(false);

  // Runtime config
  const [runtimeConfig, setRuntimeConfig] = useState<ProjectRuntimeConfigResponse>({ envVars: [], files: [] });
  const [runtimeConfigLoading, setRuntimeConfigLoading] = useState(true);
  const [savingRuntimeConfig, setSavingRuntimeConfig] = useState(false);

  // Env var form
  const [envKeyInput, setEnvKeyInput] = useState('');
  const [envValueInput, setEnvValueInput] = useState('');
  const [envSecretInput, setEnvSecretInput] = useState(false);

  // File form
  const [filePathInput, setFilePathInput] = useState('');
  const [fileContentInput, setFileContentInput] = useState('');
  const [fileSecretInput, setFileSecretInput] = useState(false);

  // Sync VM size and workspace profile from project
  useEffect(() => {
    if (project) {
      setDefaultVmSize(project.defaultVmSize ?? null);
      setDefaultWorkspaceProfile((project.defaultWorkspaceProfile as WorkspaceProfile | null) ?? null);
    }
  }, [project]);

  // Runtime config refresh indicator (separate from initial loading)
  const [runtimeConfigRefreshing, setRuntimeConfigRefreshing] = useState(false);
  const hasLoadedRuntimeRef = useRef(false);

  // Load runtime config when drawer opens
  const loadRuntimeConfig = useCallback(async () => {
    try {
      if (hasLoadedRuntimeRef.current) {
        setRuntimeConfigRefreshing(true);
      } else {
        setRuntimeConfigLoading(true);
      }
      const config = await getProjectRuntimeConfig(projectId);
      setRuntimeConfig(config);
      hasLoadedRuntimeRef.current = true;
    } catch {
      toast.error('Failed to load runtime config');
    } finally {
      setRuntimeConfigLoading(false);
      setRuntimeConfigRefreshing(false);
    }
  }, [projectId, toast]);

  useEffect(() => {
    if (open) {
      void loadRuntimeConfig();
      setIsDirty(false);
    }
  }, [open, loadRuntimeConfig]);

  // Close with unsaved changes confirmation (T040)
  const handleClose = useCallback(() => {
    if (isDirty) {
      const confirmed = window.confirm('You have unsaved changes. Discard them?');
      if (!confirmed) return;
    }
    setIsDirty(false);
    onClose();
  }, [isDirty, onClose]);

  // Prevent body scroll when open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  // Focus drawer when opened
  useEffect(() => {
    if (open && drawerRef.current) {
      drawerRef.current.focus();
    }
  }, [open]);

  // Close on Escape key
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, handleClose]);

  // Click outside to close
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (drawerRef.current && !drawerRef.current.contains(e.target as Node)) {
      handleClose();
    }
  };

  // VM size handlers
  const handleSaveVmSize = async (size: VMSize) => {
    const newSize = size === defaultVmSize ? null : size;
    setSavingVmSize(true);
    setDefaultVmSize(newSize);
    try {
      await updateProject(projectId, { defaultVmSize: newSize });
      await reload();
      toast.success(newSize ? `Default VM size set to ${newSize}` : 'Default VM size cleared');
    } catch (err) {
      setDefaultVmSize(project?.defaultVmSize ?? null);
      toast.error(err instanceof Error ? err.message : 'Failed to update VM size');
    } finally {
      setSavingVmSize(false);
    }
  };

  // Workspace profile handlers
  const handleSaveWorkspaceProfile = async (profile: WorkspaceProfile) => {
    const newProfile = profile === defaultWorkspaceProfile ? null : profile;
    setSavingWorkspaceProfile(true);
    setDefaultWorkspaceProfile(newProfile);
    try {
      await updateProject(projectId, { defaultWorkspaceProfile: newProfile });
      await reload();
      toast.success(newProfile ? `Default workspace profile set to ${newProfile}` : 'Default workspace profile cleared');
    } catch (err) {
      setDefaultWorkspaceProfile((project?.defaultWorkspaceProfile as WorkspaceProfile | null) ?? null);
      toast.error(err instanceof Error ? err.message : 'Failed to update workspace profile');
    } finally {
      setSavingWorkspaceProfile(false);
    }
  };

  // Env var handlers
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
      setIsDirty(false);
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

  // File handlers
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
      setIsDirty(false);
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

  // Track dirty state for form inputs
  const markDirty = () => { if (!isDirty) setIsDirty(true); };

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={handleBackdropClick}
        className="fixed inset-0 bg-overlay z-drawer-backdrop"
      >
        {/* Drawer panel */}
        <div
          ref={drawerRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="settings-drawer-title"
          tabIndex={-1}
          className="fixed top-0 right-0 bottom-0 w-[min(480px,90vw)] bg-surface shadow-overlay overflow-y-auto z-drawer flex flex-col outline-none"
        >
          {/* Header */}
          <div className="flex items-center justify-between p-4 border-b border-border-default shrink-0">
            <h2 id="settings-drawer-title" className="m-0 text-base font-semibold text-fg-primary">
              Project Settings
            </h2>
            <button
              type="button"
              onClick={handleClose}
              aria-label="Close settings"
              className="bg-transparent border-none cursor-pointer text-fg-muted p-1 rounded-sm flex items-center"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 p-4 grid gap-4">
            {/* Default VM Size */}
            <section className="grid gap-3">
              <div>
                <h3 className="sam-type-card-title m-0 text-fg-primary">
                  Default Node Size
                </h3>
                <p className="m-0 mt-1 text-xs text-fg-muted">
                  Used when launching new workspaces. Click again to clear.
                </p>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {VM_SIZES.map((size) => {
                  const isSelected = defaultVmSize === size.value;
                  return (
                    <button
                      key={size.value}
                      type="button"
                      aria-pressed={isSelected}
                      disabled={savingVmSize}
                      onClick={() => void handleSaveVmSize(size.value)}
                      className={`p-2 rounded-md text-left text-fg-primary ${
                        isSelected
                          ? 'border-2 border-accent bg-accent-tint'
                          : 'border border-border-default bg-inset'
                      } ${savingVmSize ? 'cursor-wait opacity-60' : 'cursor-pointer'}`}
                    >
                      <div className="font-medium text-[0.8125rem]">{size.label}</div>
                      <div className="text-xs text-fg-muted mt-0.5">
                        {size.description}
                      </div>
                    </button>
                  );
                })}
              </div>
              {!defaultVmSize && (
                <div className="text-xs text-fg-muted">
                  No default set — uses platform default (Medium).
                </div>
              )}
            </section>

            {/* Default Workspace Profile */}
            <section className="grid gap-3">
              <div>
                <h3 className="sam-type-card-title m-0 text-fg-primary">
                  Workspace Profile
                </h3>
                <p className="m-0 mt-1 text-xs text-fg-muted">
                  Full builds the project devcontainer. Lightweight skips the build for faster startup (~20s). Click again to clear.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {WORKSPACE_PROFILES.map((profile) => {
                  const isSelected = defaultWorkspaceProfile === profile.value;
                  return (
                    <button
                      key={profile.value}
                      type="button"
                      aria-pressed={isSelected}
                      disabled={savingWorkspaceProfile}
                      onClick={() => void handleSaveWorkspaceProfile(profile.value)}
                      className={`p-2 rounded-md text-left text-fg-primary ${
                        isSelected
                          ? 'border-2 border-accent bg-accent-tint'
                          : 'border border-border-default bg-inset'
                      } ${savingWorkspaceProfile ? 'cursor-wait opacity-60' : 'cursor-pointer'}`}
                    >
                      <div className="font-medium text-[0.8125rem]">{profile.label}</div>
                      <div className="text-xs text-fg-muted mt-0.5">
                        {profile.description}
                      </div>
                    </button>
                  );
                })}
              </div>
              {!defaultWorkspaceProfile && (
                <div className="text-xs text-fg-muted">
                  No default set — uses platform default (Full).
                </div>
              )}
            </section>

            {/* Runtime Config */}
            <section className="grid gap-3">
              <h3 className="sam-type-card-title m-0 text-fg-primary flex items-center gap-2">
                Runtime Config
                {runtimeConfigRefreshing && <Spinner size="sm" />}
              </h3>

              {runtimeConfigLoading && runtimeConfig.envVars.length === 0 && runtimeConfig.files.length === 0 ? (
                <div className="flex items-center gap-2">
                  <Spinner size="sm" />
                  <span className="text-[0.8125rem]">Loading...</span>
                </div>
              ) : (
                <div className="grid gap-4">
                  {/* Environment Variables */}
                  <div className="grid gap-2">
                    <h4 className="m-0 text-[0.8125rem] font-semibold text-fg-primary">
                      Environment Variables
                    </h4>
                    <div className="flex gap-2 items-end flex-wrap">
                      <div className="flex-[1_1_100px] min-w-0">
                        <label className="block text-xs text-fg-muted mb-0.5">Key</label>
                        <input
                          type="text"
                          placeholder="API_TOKEN"
                          value={envKeyInput}
                          onChange={(e) => { setEnvKeyInput(e.currentTarget.value); markDirty(); }}
                          className="block w-full py-1.5 px-2.5 min-h-9 border border-border-default rounded-sm bg-inset text-fg-primary text-[0.8125rem] font-[inherit] box-border"
                        />
                      </div>
                      <div className="flex-[2_1_140px] min-w-0">
                        <label className="block text-xs text-fg-muted mb-0.5">Value</label>
                        <input
                          type="text"
                          placeholder="Value"
                          value={envValueInput}
                          onChange={(e) => { setEnvValueInput(e.currentTarget.value); markDirty(); }}
                          className="block w-full py-1.5 px-2.5 min-h-9 border border-border-default rounded-sm bg-inset text-fg-primary text-[0.8125rem] font-[inherit] box-border"
                        />
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <label className="flex items-center gap-1 text-xs text-fg-muted cursor-pointer whitespace-nowrap">
                          <input type="checkbox" checked={envSecretInput} onChange={(e) => setEnvSecretInput(e.currentTarget.checked)} />
                          Secret
                        </label>
                        <Button variant="secondary" size="sm" onClick={handleUpsertEnvVar} loading={savingRuntimeConfig} disabled={savingRuntimeConfig}>
                          Add
                        </Button>
                      </div>
                    </div>

                    {runtimeConfig.envVars.length === 0 ? (
                      <div className="text-fg-muted text-xs">No environment variables configured.</div>
                    ) : (
                      <div className="border border-border-default rounded-sm overflow-hidden">
                        {runtimeConfig.envVars.map((item, idx) => (
                          <div key={item.key} className={`flex items-center gap-2 py-1.5 px-2 text-[0.8125rem] ${idx < runtimeConfig.envVars.length - 1 ? 'border-b border-border-default' : ''}`}>
                            <code className="font-semibold text-fg-primary text-[0.8125rem]">{item.key}</code>
                            <span className="text-fg-muted flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                              = {item.isSecret ? '••••••' : item.value}
                            </span>
                            {item.isSecret && (
                              <span className="text-[0.6875rem] text-fg-muted bg-inset px-1.5 py-px rounded-sm shrink-0">secret</span>
                            )}
                            <button
                              onClick={() => void handleDeleteEnvVar(item.key)}
                              disabled={savingRuntimeConfig}
                              aria-label={`Remove ${item.key}`}
                              className="bg-transparent border-none cursor-pointer text-fg-muted p-1 rounded-sm inline-flex shrink-0 hover:text-danger"
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
                    <h4 className="m-0 text-[0.8125rem] font-semibold text-fg-primary">
                      Runtime Files
                    </h4>
                    <div className="grid gap-2">
                      <div>
                        <label className="block text-xs text-fg-muted mb-0.5">File path</label>
                        <input
                          type="text"
                          placeholder=".env.local"
                          value={filePathInput}
                          onChange={(e) => { setFilePathInput(e.currentTarget.value); markDirty(); }}
                          className="block w-full py-1.5 px-2.5 min-h-9 border border-border-default rounded-sm bg-inset text-fg-primary text-[0.8125rem] font-[inherit] box-border"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-fg-muted mb-0.5">Content</label>
                        <textarea
                          placeholder="FOO=bar"
                          rows={3}
                          value={fileContentInput}
                          onChange={(e) => { setFileContentInput(e.currentTarget.value); markDirty(); }}
                          className="block w-full py-1.5 px-2.5 border border-border-default rounded-sm bg-inset text-fg-primary text-[0.8125rem] font-mono resize-y box-border"
                        />
                      </div>
                      <div className="flex justify-between items-center gap-2">
                        <label className="flex items-center gap-1 text-xs text-fg-muted cursor-pointer">
                          <input type="checkbox" checked={fileSecretInput} onChange={(e) => setFileSecretInput(e.currentTarget.checked)} />
                          Secret file content
                        </label>
                        <Button variant="secondary" size="sm" onClick={handleUpsertFile} loading={savingRuntimeConfig} disabled={savingRuntimeConfig}>
                          Add file
                        </Button>
                      </div>
                    </div>

                    {runtimeConfig.files.length === 0 ? (
                      <div className="text-fg-muted text-xs">No runtime files configured.</div>
                    ) : (
                      <div className="border border-border-default rounded-sm overflow-hidden">
                        {runtimeConfig.files.map((item, idx) => (
                          <div key={item.path} className={`flex items-center gap-2 py-1.5 px-2 text-[0.8125rem] ${idx < runtimeConfig.files.length - 1 ? 'border-b border-border-default' : ''}`}>
                            <code className="font-semibold text-fg-primary text-[0.8125rem] overflow-hidden text-ellipsis whitespace-nowrap min-w-0">{item.path}</code>
                            <span className="flex-1" />
                            {item.isSecret && (
                              <span className="text-[0.6875rem] text-fg-muted bg-inset px-1.5 py-px rounded-sm shrink-0">secret</span>
                            )}
                            <button
                              onClick={() => void handleDeleteFile(item.path)}
                              disabled={savingRuntimeConfig}
                              aria-label={`Remove ${item.path}`}
                              className="bg-transparent border-none cursor-pointer text-fg-muted p-1 rounded-sm inline-flex shrink-0 hover:text-danger"
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
            <DeploymentSettings projectId={projectId} compact />

            {/* Quick Links — navigation to related settings and project views */}
            <section className="grid gap-3">
              <div>
                <h3 className="sam-type-card-title m-0 text-fg-primary">
                  Quick Links
                </h3>
                <p className="m-0 mt-1 text-xs text-fg-muted">
                  Cloud provider setup, tasks, and activity.
                </p>
              </div>
              <div className="grid gap-1">
                {[
                  { label: 'Cloud Providers', description: 'Connect Hetzner, GCP, or Scaleway', path: '/settings/cloud-provider' },
                  { label: 'Tasks', description: 'Task list & management', path: `/projects/${projectId}/tasks` },
                  { label: 'Activity', description: 'Project event feed', path: `/projects/${projectId}/activity` },
                ].map((link) => (
                  <button
                    key={link.path}
                    type="button"
                    onClick={() => { onClose(); navigate(link.path); }}
                    className="sam-hover-surface flex items-center justify-between gap-2 w-full py-2 px-3 bg-transparent border border-border-default rounded-sm cursor-pointer text-fg-primary text-left"
                  >
                    <div>
                      <div className="text-[0.8125rem] font-medium">{link.label}</div>
                      <div className="text-xs text-fg-muted">
                        {link.description}
                      </div>
                    </div>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-fg-muted">
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </button>
                ))}
              </div>
            </section>
          </div>
        </div>
      </div>
    </>
  );
};
