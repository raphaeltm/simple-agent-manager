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
            <div style={{ display: 'grid', gap: 'var(--sam-space-2)' }}>
              <input
                aria-label="Runtime env key"
                placeholder="API_TOKEN"
                value={envKeyInput}
                onChange={(event) => setEnvKeyInput(event.currentTarget.value)}
              />
              <input
                aria-label="Runtime env value"
                placeholder="Value"
                value={envValueInput}
                onChange={(event) => setEnvValueInput(event.currentTarget.value)}
              />
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: 'var(--sam-type-caption-size)' }}>
                <input
                  type="checkbox"
                  checked={envSecretInput}
                  onChange={(event) => setEnvSecretInput(event.currentTarget.checked)}
                />
                Secret
              </label>
              <Button
                variant="secondary"
                onClick={handleUpsertEnvVar}
                loading={savingRuntimeConfig}
                disabled={savingRuntimeConfig}
              >
                Save
              </Button>
            </div>
            {runtimeConfig.envVars.length === 0 ? (
              <div style={{ color: 'var(--sam-color-fg-muted)', fontSize: 'var(--sam-type-caption-size)' }}>
                No runtime env vars configured.
              </div>
            ) : (
              <div style={{ display: 'grid', gap: '0.5rem' }}>
                {runtimeConfig.envVars.map((item) => (
                  <div
                    key={item.key}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 'var(--sam-space-2)',
                      alignItems: 'center',
                      fontSize: 'var(--sam-type-caption-size)',
                    }}
                  >
                    <div>
                      <strong>{item.key}</strong>{' '}
                      <span style={{ color: 'var(--sam-color-fg-muted)' }}>
                        {item.isSecret ? '••••••' : item.value}
                      </span>
                    </div>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => void handleDeleteEnvVar(item.key)}
                      disabled={savingRuntimeConfig}
                    >
                      Remove
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Runtime Files */}
          <div style={{ display: 'grid', gap: 'var(--sam-space-2)' }}>
            <h3 className="sam-type-card-title" style={{ margin: 0, color: 'var(--sam-color-fg-primary)' }}>Runtime Files</h3>
            <div style={{ display: 'grid', gap: 'var(--sam-space-2)' }}>
              <input
                aria-label="Runtime file path"
                placeholder=".env.local"
                value={filePathInput}
                onChange={(event) => setFilePathInput(event.currentTarget.value)}
              />
              <textarea
                aria-label="Runtime file content"
                placeholder="FOO=bar"
                rows={4}
                value={fileContentInput}
                onChange={(event) => setFileContentInput(event.currentTarget.value)}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--sam-space-2)', flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: 'var(--sam-type-caption-size)' }}>
                  <input
                    type="checkbox"
                    checked={fileSecretInput}
                    onChange={(event) => setFileSecretInput(event.currentTarget.checked)}
                  />
                  Secret file content
                </label>
                <Button
                  variant="secondary"
                  onClick={handleUpsertFile}
                  loading={savingRuntimeConfig}
                  disabled={savingRuntimeConfig}
                >
                  Save file
                </Button>
              </div>
            </div>
            {runtimeConfig.files.length === 0 ? (
              <div style={{ color: 'var(--sam-color-fg-muted)', fontSize: 'var(--sam-type-caption-size)' }}>
                No runtime files configured.
              </div>
            ) : (
              <div style={{ display: 'grid', gap: '0.5rem' }}>
                {runtimeConfig.files.map((item) => (
                  <div
                    key={item.path}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 'var(--sam-space-2)',
                      alignItems: 'center',
                      fontSize: 'var(--sam-type-caption-size)',
                    }}
                  >
                    <div>
                      <strong>{item.path}</strong>{' '}
                      <span style={{ color: 'var(--sam-color-fg-muted)' }}>
                        {item.isSecret ? '••••••' : 'stored'}
                      </span>
                    </div>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => void handleDeleteFile(item.path)}
                      disabled={savingRuntimeConfig}
                    >
                      Remove
                    </Button>
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
