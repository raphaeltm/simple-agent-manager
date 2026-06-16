import type { ProjectRuntimeConfigResponse } from '@simple-agent-manager/shared';
import { Button, Spinner } from '@simple-agent-manager/ui';
import { useCallback, useEffect, useState } from 'react';

import { useToast } from '../../hooks/useToast';
import {
  deleteProjectRuntimeEnvVar,
  deleteProjectRuntimeFile,
  getProjectRuntimeConfig,
  upsertProjectRuntimeEnvVar,
  upsertProjectRuntimeFile,
} from '../../lib/api';

interface ProjectRuntimeConfigSectionProps {
  projectId: string;
}

export function ProjectRuntimeConfigSection({ projectId }: ProjectRuntimeConfigSectionProps) {
  const toast = useToast();
  const [runtimeConfig, setRuntimeConfig] = useState<ProjectRuntimeConfigResponse>({
    envVars: [],
    files: [],
  });
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

  useEffect(() => {
    void loadRuntimeConfig();
  }, [loadRuntimeConfig]);

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
    <section className="glass-surface rounded-lg p-4 grid gap-3">
      <h2 className="sam-type-section-heading m-0 text-fg-primary">Runtime Config</h2>

      {runtimeConfigLoading ? (
        <div className="flex items-center gap-2">
          <Spinner size="sm" />
          <span>Loading runtime config...</span>
        </div>
      ) : (
        <div className="grid gap-4">
          <RuntimeEnvVars
            envVars={runtimeConfig.envVars}
            envKeyInput={envKeyInput}
            envValueInput={envValueInput}
            envSecretInput={envSecretInput}
            saving={savingRuntimeConfig}
            onKeyChange={setEnvKeyInput}
            onValueChange={setEnvValueInput}
            onSecretChange={setEnvSecretInput}
            onSave={() => void handleUpsertEnvVar()}
            onDelete={(key) => void handleDeleteEnvVar(key)}
          />
          <RuntimeFiles
            files={runtimeConfig.files}
            filePathInput={filePathInput}
            fileContentInput={fileContentInput}
            fileSecretInput={fileSecretInput}
            saving={savingRuntimeConfig}
            onPathChange={setFilePathInput}
            onContentChange={setFileContentInput}
            onSecretChange={setFileSecretInput}
            onSave={() => void handleUpsertFile()}
            onDelete={(path) => void handleDeleteFile(path)}
          />
        </div>
      )}
    </section>
  );
}

type RuntimeEnvVar = ProjectRuntimeConfigResponse['envVars'][number];
type RuntimeFile = ProjectRuntimeConfigResponse['files'][number];

interface RuntimeEnvVarsProps {
  envVars: RuntimeEnvVar[];
  envKeyInput: string;
  envValueInput: string;
  envSecretInput: boolean;
  saving: boolean;
  onKeyChange: (value: string) => void;
  onValueChange: (value: string) => void;
  onSecretChange: (value: boolean) => void;
  onSave: () => void;
  onDelete: (key: string) => void;
}

function RuntimeEnvVars({
  envVars,
  envKeyInput,
  envValueInput,
  envSecretInput,
  saving,
  onKeyChange,
  onValueChange,
  onSecretChange,
  onSave,
  onDelete,
}: RuntimeEnvVarsProps) {
  return (
    <div className="grid gap-2">
      <h3 className="sam-type-card-title m-0 text-fg-primary">Environment Variables</h3>
      <div className="flex gap-2 items-end flex-wrap">
        <div className="flex-[1_1_140px] min-w-0">
          <label className="block text-xs text-fg-muted mb-0.5">Key</label>
          <input
            type="text"
            aria-label="Runtime env key"
            placeholder="API_TOKEN"
            value={envKeyInput}
            onChange={(event) => onKeyChange(event.currentTarget.value)}
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
            onChange={(event) => onValueChange(event.currentTarget.value)}
            className="block w-full py-1.5 px-2.5 min-h-9 border border-border-default rounded-sm bg-inset text-fg-primary text-[0.8125rem] font-[inherit] box-border"
          />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <label className="flex items-center gap-1 text-xs text-fg-muted cursor-pointer whitespace-nowrap">
            <input
              type="checkbox"
              checked={envSecretInput}
              onChange={(event) => onSecretChange(event.currentTarget.checked)}
            />
            Secret
          </label>
          <Button
            variant="secondary"
            size="sm"
            onClick={onSave}
            loading={saving}
            disabled={saving}
            style={{ minHeight: '36px' }}
          >
            Add
          </Button>
        </div>
      </div>

      {envVars.length === 0 ? (
        <div className="text-fg-muted text-xs py-1">No environment variables configured.</div>
      ) : (
        <div className="border border-border-default rounded-sm overflow-hidden">
          {envVars.map((item, index) => (
            <RuntimeConfigRow
              key={item.key}
              label={item.key}
              value={item.isSecret ? '••••••' : `= ${item.value}`}
              isSecret={item.isSecret}
              isLast={index === envVars.length - 1}
              saving={saving}
              onDelete={() => onDelete(item.key)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface RuntimeFilesProps {
  files: RuntimeFile[];
  filePathInput: string;
  fileContentInput: string;
  fileSecretInput: boolean;
  saving: boolean;
  onPathChange: (value: string) => void;
  onContentChange: (value: string) => void;
  onSecretChange: (value: boolean) => void;
  onSave: () => void;
  onDelete: (path: string) => void;
}

function RuntimeFiles({
  files,
  filePathInput,
  fileContentInput,
  fileSecretInput,
  saving,
  onPathChange,
  onContentChange,
  onSecretChange,
  onSave,
  onDelete,
}: RuntimeFilesProps) {
  return (
    <div className="grid gap-2">
      <h3 className="sam-type-card-title m-0 text-fg-primary">Runtime Files</h3>
      <div className="grid gap-2">
        <div>
          <label className="block text-xs text-fg-muted mb-0.5">File path</label>
          <input
            type="text"
            aria-label="Runtime file path"
            placeholder=".env.local"
            value={filePathInput}
            onChange={(event) => onPathChange(event.currentTarget.value)}
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
            onChange={(event) => onContentChange(event.currentTarget.value)}
            className="block w-full py-1.5 px-2.5 border border-border-default rounded-sm bg-inset text-fg-primary text-[0.8125rem] font-mono resize-y box-border"
          />
        </div>
        <div className="flex justify-between items-center gap-2 flex-wrap">
          <label className="flex items-center gap-1 text-xs text-fg-muted cursor-pointer">
            <input
              type="checkbox"
              checked={fileSecretInput}
              onChange={(event) => onSecretChange(event.currentTarget.checked)}
            />
            Secret file content
          </label>
          <Button
            variant="secondary"
            size="sm"
            onClick={onSave}
            loading={saving}
            disabled={saving}
            style={{ minHeight: '36px' }}
          >
            Add file
          </Button>
        </div>
      </div>

      {files.length === 0 ? (
        <div className="text-fg-muted text-xs py-1">No runtime files configured.</div>
      ) : (
        <div className="border border-border-default rounded-sm overflow-hidden">
          {files.map((item, index) => (
            <RuntimeConfigRow
              key={item.path}
              label={item.path}
              isSecret={item.isSecret}
              isLast={index === files.length - 1}
              saving={saving}
              onDelete={() => onDelete(item.path)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface RuntimeConfigRowProps {
  label: string;
  value?: string;
  isSecret: boolean;
  isLast: boolean;
  saving: boolean;
  onDelete: () => void;
}

function RuntimeConfigRow({
  label,
  value,
  isSecret,
  isLast,
  saving,
  onDelete,
}: RuntimeConfigRowProps) {
  return (
    <div
      className={`flex items-center gap-2 py-1.5 px-2 text-[0.8125rem] ${
        isLast ? '' : 'border-b border-border-default'
      }`}
    >
      <code className="font-semibold text-fg-primary text-[0.8125rem] overflow-hidden text-ellipsis whitespace-nowrap min-w-0">
        {label}
      </code>
      {value ? (
        <span className="text-fg-muted flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
          {value}
        </span>
      ) : (
        <span className="flex-1" />
      )}
      {isSecret && (
        <span className="text-[0.6875rem] text-fg-muted bg-inset px-1.5 py-px rounded-sm shrink-0">
          secret
        </span>
      )}
      <button
        onClick={onDelete}
        disabled={saving}
        className="bg-transparent border-none cursor-pointer text-fg-muted p-1 rounded-sm inline-flex items-center justify-center shrink-0 transition-colors hover:text-danger"
        aria-label={`Remove ${label}`}
        title={`Remove ${label}`}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}
