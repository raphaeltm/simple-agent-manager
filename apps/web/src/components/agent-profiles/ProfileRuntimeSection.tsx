import type { ProjectRuntimeConfigResponse } from '@simple-agent-manager/shared';
import { Button, Spinner } from '@simple-agent-manager/ui';
import { type FC, useCallback, useEffect, useRef, useState } from 'react';

import { useToast } from '../../hooks/useToast';
import {
  deleteProfileRuntimeEnvVar,
  deleteProfileRuntimeFile,
  getProfileRuntimeConfig,
  upsertProfileRuntimeEnvVar,
  upsertProfileRuntimeFile,
} from '../../lib/api';

interface ProfileRuntimeSectionProps {
  projectId: string;
  profileId: string;
}

export const ProfileRuntimeSection: FC<ProfileRuntimeSectionProps> = ({
  projectId,
  profileId,
}) => {
  const toast = useToast();

  const [config, setConfig] = useState<ProjectRuntimeConfigResponse>({ envVars: [], files: [] });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Env var form
  const [envKey, setEnvKey] = useState('');
  const [envValue, setEnvValue] = useState('');
  const [envSecret, setEnvSecret] = useState(false);

  // File form
  const [filePath, setFilePath] = useState('');
  const [fileContent, setFileContent] = useState('');
  const [fileSecret, setFileSecret] = useState(false);

  const loadedRef = useRef(false);

  const loadConfig = useCallback(async () => {
    try {
      if (!loadedRef.current) setLoading(true);
      const res = await getProfileRuntimeConfig(projectId, profileId);
      setConfig(res);
      loadedRef.current = true;
    } catch {
      toast.error('Failed to load profile runtime config');
    } finally {
      setLoading(false);
    }
  }, [projectId, profileId, toast]);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const handleAddEnvVar = async () => {
    const key = envKey.trim();
    if (!key) {
      toast.error('Key is required');
      return;
    }
    setSaving(true);
    try {
      const res = await upsertProfileRuntimeEnvVar(projectId, profileId, {
        key,
        value: envValue,
        isSecret: envSecret,
      });
      setConfig(res);
      setEnvKey('');
      setEnvValue('');
      setEnvSecret(false);
      toast.success(`Saved ${key}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save env var');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteEnvVar = async (key: string) => {
    setSaving(true);
    try {
      const res = await deleteProfileRuntimeEnvVar(projectId, profileId, key);
      setConfig(res);
      toast.success(`Removed ${key}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove env var');
    } finally {
      setSaving(false);
    }
  };

  const handleAddFile = async () => {
    const path = filePath.trim();
    if (!path) {
      toast.error('File path is required');
      return;
    }
    setSaving(true);
    try {
      const res = await upsertProfileRuntimeFile(projectId, profileId, {
        path,
        content: fileContent,
        isSecret: fileSecret,
      });
      setConfig(res);
      setFilePath('');
      setFileContent('');
      setFileSecret(false);
      toast.success(`Saved ${path}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save file');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteFile = async (path: string) => {
    setSaving(true);
    try {
      const res = await deleteProfileRuntimeFile(projectId, profileId, path);
      setConfig(res);
      toast.success(`Removed ${path}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove file');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-2">
        <Spinner size="sm" />
        <span className="text-sm text-fg-muted">Loading runtime config...</span>
      </div>
    );
  }

  const preventEnterSubmit = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') e.preventDefault();
  };

  return (
    <div className="grid gap-4">
      {/* Environment Variables */}
      <div className="grid gap-2">
        <h4 className="m-0 text-sm font-semibold text-fg-primary">
          Environment Variables
        </h4>
        <p className="m-0 text-xs text-fg-muted">
          Injected into the workspace at dispatch time. Secrets are encrypted at rest.
        </p>

        <div className="flex gap-2 items-end flex-wrap">
          <div className="flex-[1_1_100px] min-w-0">
            <label htmlFor="env-key-input" className="block text-xs text-fg-muted mb-0.5">Key</label>
            <input
              id="env-key-input"
              type="text"
              placeholder="API_TOKEN"
              value={envKey}
              onChange={(e) => setEnvKey(e.currentTarget.value)}
              onKeyDown={preventEnterSubmit}
              disabled={saving}
              className="block w-full py-1.5 px-2.5 min-h-[44px] border border-border-default rounded-sm bg-inset text-fg-primary text-sm font-[inherit] box-border"
            />
          </div>
          <div className="flex-[2_1_140px] min-w-0">
            <label htmlFor="env-value-input" className="block text-xs text-fg-muted mb-0.5">Value</label>
            <input
              id="env-value-input"
              type="text"
              placeholder="Value"
              value={envValue}
              onChange={(e) => setEnvValue(e.currentTarget.value)}
              onKeyDown={preventEnterSubmit}
              disabled={saving}
              className="block w-full py-1.5 px-2.5 min-h-[44px] border border-border-default rounded-sm bg-inset text-fg-primary text-sm font-[inherit] box-border"
            />
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <label className="flex items-center gap-1 text-xs text-fg-muted cursor-pointer whitespace-nowrap">
              <input
                type="checkbox"
                checked={envSecret}
                onChange={(e) => setEnvSecret(e.currentTarget.checked)}
                disabled={saving}
              />
              Secret
            </label>
            <Button
              type="button"
              variant="secondary"
              size="md"
              onClick={() => void handleAddEnvVar()}
              loading={saving}
              disabled={saving}
            >
              Add
            </Button>
          </div>
        </div>

        {config.envVars.length === 0 ? (
          <div className="text-fg-muted text-xs">No environment variables configured.</div>
        ) : (
          <div className="border border-border-default rounded-sm overflow-hidden">
            {config.envVars.map((item, idx) => (
              <div
                key={item.key}
                className={`flex items-center gap-2 py-1.5 px-2 text-sm ${
                  idx < config.envVars.length - 1 ? 'border-b border-border-default' : ''
                }`}
              >
                <code className="font-semibold text-fg-primary text-sm">{item.key}</code>
                <span className="text-fg-muted flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                  = {item.isSecret ? '••••••' : item.value}
                </span>
                {item.isSecret && (
                  <span className="text-xs text-fg-muted bg-inset px-1.5 py-px rounded-sm shrink-0">
                    secret
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => void handleDeleteEnvVar(item.key)}
                  disabled={saving}
                  aria-label={`Remove ${item.key}`}
                  className="bg-transparent border-none cursor-pointer text-fg-muted p-2.5 rounded-sm inline-flex shrink-0 hover:text-danger min-w-[44px] min-h-[44px] items-center justify-center"
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
        <h4 className="m-0 text-sm font-semibold text-fg-primary">
          Runtime Files
        </h4>
        <p className="m-0 text-xs text-fg-muted">
          Written to the workspace filesystem at dispatch time.
        </p>

        <div className="grid gap-2">
          <div>
            <label htmlFor="file-path-input" className="block text-xs text-fg-muted mb-0.5">File path</label>
            <input
              id="file-path-input"
              type="text"
              placeholder=".env.local"
              value={filePath}
              onChange={(e) => setFilePath(e.currentTarget.value)}
              onKeyDown={preventEnterSubmit}
              disabled={saving}
              className="block w-full py-1.5 px-2.5 min-h-[44px] border border-border-default rounded-sm bg-inset text-fg-primary text-sm font-[inherit] box-border"
            />
          </div>
          <div>
            <label htmlFor="file-content-input" className="block text-xs text-fg-muted mb-0.5">Content</label>
            <textarea
              id="file-content-input"
              placeholder="FOO=bar"
              rows={3}
              value={fileContent}
              onChange={(e) => setFileContent(e.currentTarget.value)}
              disabled={saving}
              className="block w-full py-1.5 px-2.5 border border-border-default rounded-sm bg-inset text-fg-primary text-sm font-mono resize-y box-border"
            />
          </div>
          <div className="flex justify-between items-center gap-2">
            <label className="flex items-center gap-1 text-xs text-fg-muted cursor-pointer">
              <input
                type="checkbox"
                checked={fileSecret}
                onChange={(e) => setFileSecret(e.currentTarget.checked)}
                disabled={saving}
              />
              Secret file content
            </label>
            <Button
              type="button"
              variant="secondary"
              size="md"
              onClick={() => void handleAddFile()}
              loading={saving}
              disabled={saving}
            >
              Add file
            </Button>
          </div>
        </div>

        {config.files.length === 0 ? (
          <div className="text-fg-muted text-xs">No runtime files configured.</div>
        ) : (
          <div className="border border-border-default rounded-sm overflow-hidden">
            {config.files.map((item, idx) => (
              <div
                key={item.path}
                className={`flex items-center gap-2 py-1.5 px-2 text-sm ${
                  idx < config.files.length - 1 ? 'border-b border-border-default' : ''
                }`}
              >
                <code className="font-semibold text-fg-primary text-sm overflow-hidden text-ellipsis whitespace-nowrap min-w-0">
                  {item.path}
                </code>
                <span className="flex-1" />
                {item.isSecret && (
                  <span className="text-xs text-fg-muted bg-inset px-1.5 py-px rounded-sm shrink-0">
                    secret
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => void handleDeleteFile(item.path)}
                  disabled={saving}
                  aria-label={`Remove ${item.path}`}
                  className="bg-transparent border-none cursor-pointer text-fg-muted p-2.5 rounded-sm inline-flex shrink-0 hover:text-danger min-w-[44px] min-h-[44px] items-center justify-center"
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
  );
};
