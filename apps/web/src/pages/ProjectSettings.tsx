import { useCallback, useEffect, useState } from 'react';
import type { ProjectRuntimeConfigResponse } from '@simple-agent-manager/shared';
import { Button, Spinner } from '@simple-agent-manager/ui';
import {
  getProjectRuntimeConfig,
  upsertProjectRuntimeEnvVar,
  deleteProjectRuntimeEnvVar,
  upsertProjectRuntimeFile,
  deleteProjectRuntimeFile,
} from '../lib/api';
import { useToast } from '../hooks/useToast';
import { useProjectContext } from './ProjectContext';

export function ProjectSettings() {
  const toast = useToast();
  const { projectId } = useProjectContext();

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
    boxSizing: 'border-box',
  };

  const listItemStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sam-space-2)',
    padding: '0.375rem 0.5rem',
    borderBottom: '1px solid var(--sam-color-border-default)',
    fontSize: '0.8125rem',
  };

  const deleteButtonStyle: React.CSSProperties = {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    color: 'var(--sam-color-fg-muted)',
    padding: '4px',
    borderRadius: 'var(--sam-radius-sm)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    transition: 'color 150ms',
  };

  return (
    <section
      style={{
        border: '1px solid var(--sam-color-border-default)',
        borderRadius: 'var(--sam-radius-md)',
        background: 'var(--sam-color-bg-surface)',
        padding: 'var(--sam-space-4)',
        display: 'grid',
        gap: 'var(--sam-space-3)',
      }}
    >
      <h2 className="sam-type-section-heading" style={{ margin: 0, color: 'var(--sam-color-fg-primary)' }}>
        Runtime Config
      </h2>

      {runtimeConfigLoading ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-2)' }}>
          <Spinner size="sm" />
          <span>Loading runtime config...</span>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 'var(--sam-space-4)' }}>
          {/* Environment Variables */}
          <div style={{ display: 'grid', gap: 'var(--sam-space-2)' }}>
            <h3 className="sam-type-card-title" style={{ margin: 0, color: 'var(--sam-color-fg-primary)' }}>Environment Variables</h3>

            {/* Add form — key and value on same row */}
            <div style={{ display: 'flex', gap: 'var(--sam-space-2)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 140px', minWidth: 0 }}>
                <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--sam-color-fg-muted)', marginBottom: '2px' }}>Key</label>
                <input
                  type="text"
                  aria-label="Runtime env key"
                  placeholder="API_TOKEN"
                  value={envKeyInput}
                  onChange={(event) => setEnvKeyInput(event.currentTarget.value)}
                  style={inputStyle}
                />
              </div>
              <div style={{ flex: '2 1 200px', minWidth: 0 }}>
                <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--sam-color-fg-muted)', marginBottom: '2px' }}>Value</label>
                <input
                  type="text"
                  aria-label="Runtime env value"
                  placeholder="Value"
                  value={envValueInput}
                  onChange={(event) => setEnvValueInput(event.currentTarget.value)}
                  style={inputStyle}
                />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-2)', flexShrink: 0 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.75rem', color: 'var(--sam-color-fg-muted)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
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
              <div style={{ color: 'var(--sam-color-fg-muted)', fontSize: '0.75rem', padding: '0.25rem 0' }}>
                No environment variables configured.
              </div>
            ) : (
              <div style={{ border: '1px solid var(--sam-color-border-default)', borderRadius: 'var(--sam-radius-sm)', overflow: 'hidden' }}>
                {runtimeConfig.envVars.map((item, idx) => (
                  <div
                    key={item.key}
                    style={{
                      ...listItemStyle,
                      borderBottom: idx === runtimeConfig.envVars.length - 1 ? 'none' : listItemStyle.borderBottom,
                    }}
                  >
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
                      style={deleteButtonStyle}
                      aria-label={`Remove ${item.key}`}
                      title={`Remove ${item.key}`}
                      onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--sam-color-danger)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--sam-color-fg-muted)'; }}
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
            <h3 className="sam-type-card-title" style={{ margin: 0, color: 'var(--sam-color-fg-primary)' }}>Runtime Files</h3>

            {/* Add form */}
            <div style={{ display: 'grid', gap: 'var(--sam-space-2)' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--sam-color-fg-muted)', marginBottom: '2px' }}>File path</label>
                <input
                  type="text"
                  aria-label="Runtime file path"
                  placeholder=".env.local"
                  value={filePathInput}
                  onChange={(event) => setFilePathInput(event.currentTarget.value)}
                  style={inputStyle}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--sam-color-fg-muted)', marginBottom: '2px' }}>Content</label>
                <textarea
                  aria-label="Runtime file content"
                  placeholder="FOO=bar"
                  rows={3}
                  value={fileContentInput}
                  onChange={(event) => setFileContentInput(event.currentTarget.value)}
                  style={{ ...inputStyle, minHeight: 'auto', resize: 'vertical', fontFamily: 'var(--sam-font-mono, monospace)', fontSize: '0.8125rem' }}
                />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--sam-space-2)', flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.75rem', color: 'var(--sam-color-fg-muted)', cursor: 'pointer' }}>
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
              <div style={{ color: 'var(--sam-color-fg-muted)', fontSize: '0.75rem', padding: '0.25rem 0' }}>
                No runtime files configured.
              </div>
            ) : (
              <div style={{ border: '1px solid var(--sam-color-border-default)', borderRadius: 'var(--sam-radius-sm)', overflow: 'hidden' }}>
                {runtimeConfig.files.map((item, idx) => (
                  <div
                    key={item.path}
                    style={{
                      ...listItemStyle,
                      borderBottom: idx === runtimeConfig.files.length - 1 ? 'none' : listItemStyle.borderBottom,
                    }}
                  >
                    <code style={{ fontWeight: 600, color: 'var(--sam-color-fg-primary)', fontSize: '0.8125rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{item.path}</code>
                    <span style={{ flex: 1 }} />
                    {item.isSecret && (
                      <span style={{ fontSize: '0.6875rem', color: 'var(--sam-color-fg-muted)', backgroundColor: 'var(--sam-color-bg-inset)', padding: '1px 6px', borderRadius: 'var(--sam-radius-sm)', flexShrink: 0 }}>secret</span>
                    )}
                    <button
                      onClick={() => void handleDeleteFile(item.path)}
                      disabled={savingRuntimeConfig}
                      style={deleteButtonStyle}
                      aria-label={`Remove ${item.path}`}
                      title={`Remove ${item.path}`}
                      onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--sam-color-danger)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--sam-color-fg-muted)'; }}
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
  );
}
