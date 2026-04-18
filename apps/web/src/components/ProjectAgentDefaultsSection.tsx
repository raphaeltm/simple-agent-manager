/**
 * Per-project agent defaults section — surfaces a card per agent type with a
 * model selector and permission mode picker. Project-level settings fall through
 * to user-level agent settings when cleared.
 *
 * Part of Phase 1 of the multi-level configuration override system.
 * Resolution chain: task explicit > agent profile > project.agentDefaults > user agent_settings > platform default.
 */
import type {
  AgentInfo,
  AgentPermissionMode,
  AgentType,
  ProjectAgentDefaults,
} from '@simple-agent-manager/shared';
import {
  AGENT_PERMISSION_MODE_LABELS,
  VALID_PERMISSION_MODES,
} from '@simple-agent-manager/shared';
import { Alert, Button, Spinner } from '@simple-agent-manager/ui';
import { useCallback, useEffect, useState } from 'react';

import { listAgents, updateProject } from '../lib/api';
import { ModelSelect } from './ModelSelect';

const SUCCESS_BANNER_MS = 3000;

const FORM_CONTROL =
  'w-full min-h-11 py-2 px-3 rounded-sm border border-border-default bg-inset text-fg-primary text-sm outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring box-border';

function modelPlaceholderFor(agentId: AgentType | string): string {
  switch (agentId) {
    case 'claude-code':
      return 'e.g. claude-opus-4-6, claude-sonnet-4-5-20250929';
    case 'openai-codex':
      return 'e.g. gpt-5-codex, o3';
    case 'google-gemini':
      return 'e.g. gemini-2.5-pro';
    case 'opencode':
      return 'e.g. scaleway/qwen3-coder-30b-a3b-instruct';
    default:
      return 'Model identifier (leave empty to fall through)';
  }
}

interface AgentDefaultCardProps {
  agent: AgentInfo;
  value: { model?: string | null; permissionMode?: AgentPermissionMode | null } | undefined;
  onSave: (
    agentType: AgentType,
    entry: { model: string | null; permissionMode: AgentPermissionMode | null }
  ) => Promise<void>;
  onClear: (agentType: AgentType) => Promise<void>;
}

function AgentDefaultCard({ agent, value, onSave, onClear }: AgentDefaultCardProps) {
  const [model, setModel] = useState(value?.model ?? '');
  const [permissionMode, setPermissionMode] = useState<AgentPermissionMode | ''>(
    value?.permissionMode ?? ''
  );
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    setModel(value?.model ?? '');
    setPermissionMode(value?.permissionMode ?? '');
  }, [value]);

  const hasValue = Boolean(value?.model || value?.permissionMode);
  const changed =
    (model.trim() || null) !== (value?.model ?? null) ||
    (permissionMode || null) !== (value?.permissionMode ?? null);

  const handleSave = async () => {
    try {
      setError(null);
      setSuccess(false);
      setSaving(true);
      await onSave(agent.id, {
        model: model.trim() || null,
        permissionMode: (permissionMode || null) as AgentPermissionMode | null,
      });
      setSuccess(true);
      setTimeout(() => setSuccess(false), SUCCESS_BANNER_MS);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save project agent default');
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    try {
      setError(null);
      setSuccess(false);
      setClearing(true);
      await onClear(agent.id);
      setModel('');
      setPermissionMode('');
      setSuccess(true);
      setTimeout(() => setSuccess(false), SUCCESS_BANNER_MS);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear project agent default');
    } finally {
      setClearing(false);
    }
  };

  return (
    <div
      className="p-4 rounded-md border border-border-default bg-inset"
      data-testid={`project-agent-default-${agent.id}`}
    >
      <div className="mb-2 font-semibold text-base text-fg-primary flex items-center gap-2">
        {agent.name}
        {hasValue && (
          <span className="text-xs text-accent font-normal" aria-label="Project override active">
            (project override)
          </span>
        )}
      </div>

      {error && (
        <div className="mb-3">
          <Alert variant="error" onDismiss={() => setError(null)}>
            {error}
          </Alert>
        </div>
      )}
      {success && (
        <div className="mb-3">
          <Alert variant="success">Project default saved</Alert>
        </div>
      )}

      <div className="mb-4">
        <label
          htmlFor={`project-agent-model-${agent.id}`}
          className="text-sm font-medium text-fg-primary mb-1 block"
        >
          Model
        </label>
        <div className="text-xs text-fg-muted mb-2">
          Leave empty to fall through to your user-level agent settings.
        </div>
        <ModelSelect
          id={`project-agent-model-${agent.id}`}
          agentType={agent.id}
          value={model}
          onChange={setModel}
          placeholder={modelPlaceholderFor(agent.id)}
          data-testid={`project-agent-model-input-${agent.id}`}
        />
      </div>

      <div className="mb-4">
        <label
          htmlFor={`project-agent-permission-${agent.id}`}
          className="text-sm font-medium text-fg-primary mb-1 block"
        >
          Permission Mode
        </label>
        <div className="text-xs text-fg-muted mb-2">
          Leave empty to fall through to your user-level setting.
        </div>
        <select
          id={`project-agent-permission-${agent.id}`}
          value={permissionMode}
          onChange={(e) => setPermissionMode(e.target.value as AgentPermissionMode | '')}
          className={FORM_CONTROL}
          data-testid={`project-agent-permission-select-${agent.id}`}
        >
          <option value="">Inherit from user settings</option>
          {VALID_PERMISSION_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {AGENT_PERMISSION_MODE_LABELS[mode] || mode}
            </option>
          ))}
        </select>
        {permissionMode === 'bypassPermissions' && (
          <div role="alert" className="text-xs text-danger-fg py-2 px-3 rounded-md bg-danger-tint mt-2">
            ⚠ Warning: bypassPermissions disables all safety prompts for this project.
          </div>
        )}
      </div>

      <div className="flex gap-3 flex-wrap">
        <Button
          size="sm"
          variant="primary"
          onClick={() => void handleSave()}
          disabled={saving || clearing || !changed}
          loading={saving}
          data-testid={`project-agent-save-${agent.id}`}
        >
          Save
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void handleClear()}
          disabled={saving || clearing || !hasValue}
          loading={clearing}
          data-testid={`project-agent-clear-${agent.id}`}
        >
          Clear project override
        </Button>
      </div>
    </div>
  );
}

interface ProjectAgentDefaultsSectionProps {
  projectId: string;
  initialAgentDefaults: ProjectAgentDefaults | null | undefined;
  onUpdated: (next: ProjectAgentDefaults | null) => void;
}

export function ProjectAgentDefaultsSection({
  projectId,
  initialAgentDefaults,
  onUpdated,
}: ProjectAgentDefaultsSectionProps) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [defaults, setDefaults] = useState<ProjectAgentDefaults>(initialAgentDefaults ?? {});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    setDefaults(initialAgentDefaults ?? {});
  }, [initialAgentDefaults]);

  const loadAgents = useCallback(async () => {
    try {
      setLoadError(null);
      const result = await listAgents();
      setAgents(result.agents);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load agents');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  const handleSave = async (
    agentType: AgentType,
    entry: { model: string | null; permissionMode: AgentPermissionMode | null }
  ) => {
    // Build next map: omit the entry entirely if both fields are null.
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

  const handleClear = async (agentType: AgentType) => {
    const next: ProjectAgentDefaults = { ...defaults };
    delete next[agentType];
    const payload = Object.keys(next).length === 0 ? null : next;
    const updated = await updateProject(projectId, { agentDefaults: payload });
    setDefaults(updated.agentDefaults ?? {});
    onUpdated(updated.agentDefaults ?? null);
  };

  if (loading && agents.length === 0) {
    return (
      <div className="flex justify-center p-4">
        <Spinner size="md" />
      </div>
    );
  }

  if (loadError) {
    return <Alert variant="error">{loadError}</Alert>;
  }

  return (
    <div className="flex flex-col gap-4" data-testid="project-agent-defaults-section">
      {agents.map((agent) => (
        <AgentDefaultCard
          key={agent.id}
          agent={agent}
          value={defaults[agent.id]}
          onSave={handleSave}
          onClear={handleClear}
        />
      ))}
    </div>
  );
}
