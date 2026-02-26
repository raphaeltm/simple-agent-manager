/**
 * SettingsDrawer — slide-over panel for project settings.
 *
 * Renders the same settings content (VM size, env vars, runtime files)
 * as the ProjectSettings page but in a drawer overlay. Opened via the
 * gear icon in the project header.
 *
 * See: specs/022-simplified-chat-ux/tasks.md (T038-T040)
 */
import { type FC, useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ProjectRuntimeConfigResponse, VMSize } from '@simple-agent-manager/shared';
import { Button, Spinner } from '@simple-agent-manager/ui';
import {
  getProjectRuntimeConfig,
  updateProject,
  upsertProjectRuntimeEnvVar,
  deleteProjectRuntimeEnvVar,
  upsertProjectRuntimeFile,
  deleteProjectRuntimeFile,
} from '../../lib/api';
import { useToast } from '../../hooks/useToast';
import { useProjectContext } from '../../pages/ProjectContext';

const VM_SIZES: { value: VMSize; label: string; description: string }[] = [
  { value: 'small', label: 'Small', description: '2 vCPUs, 4 GB RAM' },
  { value: 'medium', label: 'Medium', description: '4 vCPUs, 8 GB RAM' },
  { value: 'large', label: 'Large', description: '8 vCPUs, 16 GB RAM' },
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

  // Sync VM size from project
  useEffect(() => {
    if (project) {
      setDefaultVmSize(project.defaultVmSize ?? null);
    }
  }, [project]);

  // Load runtime config when drawer opens
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

  useEffect(() => {
    if (open) {
      void loadRuntimeConfig();
      setIsDirty(false);
    }
  }, [open, loadRuntimeConfig]);

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
  });

  // Close with unsaved changes confirmation (T040)
  const handleClose = () => {
    if (isDirty) {
      const confirmed = window.confirm('You have unsaved changes. Discard them?');
      if (!confirmed) return;
    }
    setIsDirty(false);
    onClose();
  };

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

  const inputStyle: React.CSSProperties = {
    display: 'block',
    width: '100%',
    padding: '0.375rem 0.625rem',
    minHeight: '36px',
    border: '1px solid var(--sam-color-border-default)',
    borderRadius: 'var(--sam-radius-sm)',
    backgroundColor: 'var(--sam-color-bg-inset)',
    color: 'var(--sam-color-fg-primary)',
    fontSize: '0.8125rem',
    fontFamily: 'inherit',
    boxSizing: 'border-box' as const,
  };

  const listItemStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sam-space-2)',
    padding: '0.375rem 0.5rem',
    borderBottom: '1px solid var(--sam-color-border-default)',
    fontSize: '0.8125rem',
  };

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={handleBackdropClick}
        style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'var(--sam-color-bg-overlay)',
          zIndex: 'var(--sam-z-drawer-backdrop)' as unknown as number,
        }}
      >
        {/* Drawer panel */}
        <div
          ref={drawerRef}
          style={{
            position: 'fixed',
            top: 0,
            right: 0,
            bottom: 0,
            width: 'min(480px, 90vw)',
            backgroundColor: 'var(--sam-color-bg-surface)',
            boxShadow: 'var(--sam-shadow-overlay)',
            overflowY: 'auto',
            zIndex: 'var(--sam-z-drawer)' as unknown as number,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {/* Header */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: 'var(--sam-space-4)',
            borderBottom: '1px solid var(--sam-color-border-default)',
            flexShrink: 0,
          }}>
            <h2 style={{
              margin: 0,
              fontSize: 'var(--sam-type-section-heading-size)',
              fontWeight: 600,
              color: 'var(--sam-color-fg-primary)',
            }}>
              Project Settings
            </h2>
            <button
              type="button"
              onClick={handleClose}
              aria-label="Close settings"
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--sam-color-fg-muted)',
                padding: 'var(--sam-space-1)',
                borderRadius: 'var(--sam-radius-sm)',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          {/* Content */}
          <div style={{ flex: 1, padding: 'var(--sam-space-4)', display: 'grid', gap: 'var(--sam-space-4)' }}>
            {/* Default VM Size */}
            <section style={{ display: 'grid', gap: 'var(--sam-space-3)' }}>
              <div>
                <h3 className="sam-type-card-title" style={{ margin: 0, color: 'var(--sam-color-fg-primary)' }}>
                  Default Node Size
                </h3>
                <p style={{ margin: '4px 0 0', fontSize: 'var(--sam-type-caption-size)', color: 'var(--sam-color-fg-muted)' }}>
                  Used when launching new workspaces. Click again to clear.
                </p>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--sam-space-2)' }}>
                {VM_SIZES.map((size) => {
                  const isSelected = defaultVmSize === size.value;
                  return (
                    <button
                      key={size.value}
                      type="button"
                      aria-pressed={isSelected}
                      disabled={savingVmSize}
                      onClick={() => void handleSaveVmSize(size.value)}
                      style={{
                        padding: 'var(--sam-space-2)',
                        border: isSelected
                          ? '2px solid var(--sam-color-accent-primary)'
                          : '1px solid var(--sam-color-border-default)',
                        borderRadius: 'var(--sam-radius-md)',
                        textAlign: 'left',
                        cursor: savingVmSize ? 'wait' : 'pointer',
                        backgroundColor: isSelected
                          ? 'var(--sam-color-accent-primary-tint)'
                          : 'var(--sam-color-bg-inset)',
                        color: 'var(--sam-color-fg-primary)',
                        opacity: savingVmSize ? 0.6 : 1,
                      }}
                    >
                      <div style={{ fontWeight: 500, fontSize: '0.8125rem' }}>{size.label}</div>
                      <div style={{ fontSize: 'var(--sam-type-caption-size)', color: 'var(--sam-color-fg-muted)', marginTop: '2px' }}>
                        {size.description}
                      </div>
                    </button>
                  );
                })}
              </div>
              {!defaultVmSize && (
                <div style={{ fontSize: 'var(--sam-type-caption-size)', color: 'var(--sam-color-fg-muted)' }}>
                  No default set — uses platform default (Medium).
                </div>
              )}
            </section>

            {/* Runtime Config */}
            <section style={{ display: 'grid', gap: 'var(--sam-space-3)' }}>
              <h3 className="sam-type-card-title" style={{ margin: 0, color: 'var(--sam-color-fg-primary)' }}>
                Runtime Config
              </h3>

              {runtimeConfigLoading ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-2)' }}>
                  <Spinner size="sm" />
                  <span style={{ fontSize: '0.8125rem' }}>Loading...</span>
                </div>
              ) : (
                <div style={{ display: 'grid', gap: 'var(--sam-space-4)' }}>
                  {/* Environment Variables */}
                  <div style={{ display: 'grid', gap: 'var(--sam-space-2)' }}>
                    <h4 style={{ margin: 0, fontSize: '0.8125rem', fontWeight: 600, color: 'var(--sam-color-fg-primary)' }}>
                      Environment Variables
                    </h4>
                    <div style={{ display: 'flex', gap: 'var(--sam-space-2)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                      <div style={{ flex: '1 1 100px', minWidth: 0 }}>
                        <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--sam-color-fg-muted)', marginBottom: '2px' }}>Key</label>
                        <input
                          type="text"
                          placeholder="API_TOKEN"
                          value={envKeyInput}
                          onChange={(e) => { setEnvKeyInput(e.currentTarget.value); markDirty(); }}
                          style={inputStyle}
                        />
                      </div>
                      <div style={{ flex: '2 1 140px', minWidth: 0 }}>
                        <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--sam-color-fg-muted)', marginBottom: '2px' }}>Value</label>
                        <input
                          type="text"
                          placeholder="Value"
                          value={envValueInput}
                          onChange={(e) => { setEnvValueInput(e.currentTarget.value); markDirty(); }}
                          style={inputStyle}
                        />
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-2)', flexShrink: 0 }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.75rem', color: 'var(--sam-color-fg-muted)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                          <input type="checkbox" checked={envSecretInput} onChange={(e) => setEnvSecretInput(e.currentTarget.checked)} />
                          Secret
                        </label>
                        <Button variant="secondary" size="sm" onClick={handleUpsertEnvVar} loading={savingRuntimeConfig} disabled={savingRuntimeConfig}>
                          Add
                        </Button>
                      </div>
                    </div>

                    {runtimeConfig.envVars.length === 0 ? (
                      <div style={{ color: 'var(--sam-color-fg-muted)', fontSize: '0.75rem' }}>No environment variables configured.</div>
                    ) : (
                      <div style={{ border: '1px solid var(--sam-color-border-default)', borderRadius: 'var(--sam-radius-sm)', overflow: 'hidden' }}>
                        {runtimeConfig.envVars.map((item, idx) => (
                          <div key={item.key} style={{ ...listItemStyle, borderBottom: idx === runtimeConfig.envVars.length - 1 ? 'none' : listItemStyle.borderBottom }}>
                            <code style={{ fontWeight: 600, color: 'var(--sam-color-fg-primary)', fontSize: '0.8125rem' }}>{item.key}</code>
                            <span style={{ color: 'var(--sam-color-fg-muted)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              = {item.isSecret ? '••••••' : item.value}
                            </span>
                            {item.isSecret && (
                              <span style={{ fontSize: '0.6875rem', color: 'var(--sam-color-fg-muted)', backgroundColor: 'var(--sam-color-bg-inset)', padding: '1px 6px', borderRadius: 'var(--sam-radius-sm)', flexShrink: 0 }}>secret</span>
                            )}
                            <button
                              onClick={() => void handleDeleteEnvVar(item.key)}
                              disabled={savingRuntimeConfig}
                              aria-label={`Remove ${item.key}`}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--sam-color-fg-muted)', padding: '4px', borderRadius: 'var(--sam-radius-sm)', display: 'inline-flex', flexShrink: 0 }}
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
                  <div style={{ display: 'grid', gap: 'var(--sam-space-2)' }}>
                    <h4 style={{ margin: 0, fontSize: '0.8125rem', fontWeight: 600, color: 'var(--sam-color-fg-primary)' }}>
                      Runtime Files
                    </h4>
                    <div style={{ display: 'grid', gap: 'var(--sam-space-2)' }}>
                      <div>
                        <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--sam-color-fg-muted)', marginBottom: '2px' }}>File path</label>
                        <input
                          type="text"
                          placeholder=".env.local"
                          value={filePathInput}
                          onChange={(e) => { setFilePathInput(e.currentTarget.value); markDirty(); }}
                          style={inputStyle}
                        />
                      </div>
                      <div>
                        <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--sam-color-fg-muted)', marginBottom: '2px' }}>Content</label>
                        <textarea
                          placeholder="FOO=bar"
                          rows={3}
                          value={fileContentInput}
                          onChange={(e) => { setFileContentInput(e.currentTarget.value); markDirty(); }}
                          style={{ ...inputStyle, minHeight: 'auto', resize: 'vertical', fontFamily: 'var(--sam-font-mono, monospace)' }}
                        />
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--sam-space-2)' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.75rem', color: 'var(--sam-color-fg-muted)', cursor: 'pointer' }}>
                          <input type="checkbox" checked={fileSecretInput} onChange={(e) => setFileSecretInput(e.currentTarget.checked)} />
                          Secret file content
                        </label>
                        <Button variant="secondary" size="sm" onClick={handleUpsertFile} loading={savingRuntimeConfig} disabled={savingRuntimeConfig}>
                          Add file
                        </Button>
                      </div>
                    </div>

                    {runtimeConfig.files.length === 0 ? (
                      <div style={{ color: 'var(--sam-color-fg-muted)', fontSize: '0.75rem' }}>No runtime files configured.</div>
                    ) : (
                      <div style={{ border: '1px solid var(--sam-color-border-default)', borderRadius: 'var(--sam-radius-sm)', overflow: 'hidden' }}>
                        {runtimeConfig.files.map((item, idx) => (
                          <div key={item.path} style={{ ...listItemStyle, borderBottom: idx === runtimeConfig.files.length - 1 ? 'none' : listItemStyle.borderBottom }}>
                            <code style={{ fontWeight: 600, color: 'var(--sam-color-fg-primary)', fontSize: '0.8125rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{item.path}</code>
                            <span style={{ flex: 1 }} />
                            {item.isSecret && (
                              <span style={{ fontSize: '0.6875rem', color: 'var(--sam-color-fg-muted)', backgroundColor: 'var(--sam-color-bg-inset)', padding: '1px 6px', borderRadius: 'var(--sam-radius-sm)', flexShrink: 0 }}>secret</span>
                            )}
                            <button
                              onClick={() => void handleDeleteFile(item.path)}
                              disabled={savingRuntimeConfig}
                              aria-label={`Remove ${item.path}`}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--sam-color-fg-muted)', padding: '4px', borderRadius: 'var(--sam-radius-sm)', display: 'inline-flex', flexShrink: 0 }}
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

            {/* Project Views — power-user links to hidden routes */}
            <section style={{ display: 'grid', gap: 'var(--sam-space-3)' }}>
              <div>
                <h3 className="sam-type-card-title" style={{ margin: 0, color: 'var(--sam-color-fg-primary)' }}>
                  Project Views
                </h3>
                <p style={{ margin: '4px 0 0', fontSize: 'var(--sam-type-caption-size)', color: 'var(--sam-color-fg-muted)' }}>
                  Advanced views for managing workspaces, tasks, and activity.
                </p>
              </div>
              <div style={{ display: 'grid', gap: 'var(--sam-space-1)' }}>
                {[
                  { label: 'Overview', description: 'Workspaces & launch controls', path: `/projects/${projectId}/overview` },
                  { label: 'Tasks', description: 'Task list & management', path: `/projects/${projectId}/tasks` },
                  { label: 'Activity', description: 'Project event feed', path: `/projects/${projectId}/activity` },
                ].map((link) => (
                  <button
                    key={link.path}
                    type="button"
                    onClick={() => { onClose(); navigate(link.path); }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 'var(--sam-space-2)',
                      width: '100%',
                      padding: 'var(--sam-space-2) var(--sam-space-3)',
                      background: 'none',
                      border: '1px solid var(--sam-color-border-default)',
                      borderRadius: 'var(--sam-radius-sm)',
                      cursor: 'pointer',
                      color: 'var(--sam-color-fg-primary)',
                      textAlign: 'left',
                    }}
                    className="sam-hover-surface"
                  >
                    <div>
                      <div style={{ fontSize: '0.8125rem', fontWeight: 500 }}>{link.label}</div>
                      <div style={{ fontSize: 'var(--sam-type-caption-size)', color: 'var(--sam-color-fg-muted)' }}>
                        {link.description}
                      </div>
                    </div>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: 'var(--sam-color-fg-muted)' }}>
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
