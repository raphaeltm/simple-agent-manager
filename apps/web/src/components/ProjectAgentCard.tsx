/**
 * Per-project unified agent card. Combines project credential override
 * (delegates to AgentKeyCard scope='project') with project-scoped model /
 * permission mode overrides. Both subsections fall through to user-level
 * values when empty.
 */
import type {
  AgentCredentialInfo,
  AgentInfo,
  AgentPermissionMode,
  AgentType,
  CredentialKind,
  SaveAgentCredentialRequest,
} from '@simple-agent-manager/shared';
import {
  AGENT_PERMISSION_MODE_LABELS,
  VALID_PERMISSION_MODES,
} from '@simple-agent-manager/shared';
import { Alert, Button, StatusBadge } from '@simple-agent-manager/ui';
import { useEffect, useState } from 'react';

import { AgentKeyCard } from './AgentKeyCard';
import { ModelSelect } from './ModelSelect';

const SUCCESS_BANNER_MS = 3000;

const FORM_CONTROL =
  'w-full min-h-11 py-2 px-3 rounded-sm border border-border-default bg-inset text-fg-primary text-sm outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring box-border';

function modelPlaceholderFor(agentId: string): string {
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
      return 'Model identifier (leave empty to inherit)';
  }
}

export interface ProjectAgentCardProps {
  agent: AgentInfo;
  projectCredentials: AgentCredentialInfo[] | null;
  userCredentials: AgentCredentialInfo[];
  defaultValue: { model?: string | null; permissionMode?: AgentPermissionMode | null } | undefined;
  onSaveCredential: (req: SaveAgentCredentialRequest) => Promise<void>;
  onDeleteCredential: (agentType: AgentType, credentialKind: CredentialKind) => Promise<void>;
  onSaveDefault: (
    agentType: AgentType,
    entry: { model: string | null; permissionMode: AgentPermissionMode | null },
  ) => Promise<void>;
  onClearDefault: (agentType: AgentType) => Promise<void>;
}

export function ProjectAgentCard({
  agent,
  projectCredentials,
  userCredentials,
  defaultValue,
  onSaveCredential,
  onDeleteCredential,
  onSaveDefault,
  onClearDefault,
}: ProjectAgentCardProps) {
  const [model, setModel] = useState(defaultValue?.model ?? '');
  const [permissionMode, setPermissionMode] = useState<AgentPermissionMode | ''>(
    defaultValue?.permissionMode ?? '',
  );
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    setModel(defaultValue?.model ?? '');
    setPermissionMode(defaultValue?.permissionMode ?? '');
  }, [defaultValue]);

  const hasCredentialOverride = (projectCredentials?.length ?? 0) > 0;
  const activeUserCred = userCredentials.find((c) => c.isActive);
  const hasUserCredential = userCredentials.length > 0;

  const hasConfigOverride = Boolean(defaultValue?.model || defaultValue?.permissionMode);
  const configChanged =
    (model.trim() || null) !== (defaultValue?.model ?? null) ||
    (permissionMode || null) !== (defaultValue?.permissionMode ?? null);

  const handleSaveConfig = async () => {
    try {
      setError(null);
      setSuccess(false);
      setSaving(true);
      await onSaveDefault(agent.id, {
        model: model.trim() || null,
        permissionMode: (permissionMode || null) as AgentPermissionMode | null,
      });
      setSuccess(true);
      setTimeout(() => setSuccess(false), SUCCESS_BANNER_MS);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save project override');
    } finally {
      setSaving(false);
    }
  };

  const handleClearConfig = async () => {
    try {
      setError(null);
      setSuccess(false);
      setClearing(true);
      await onClearDefault(agent.id);
      setModel('');
      setPermissionMode('');
      setSuccess(true);
      setTimeout(() => setSuccess(false), SUCCESS_BANNER_MS);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear project override');
    } finally {
      setClearing(false);
    }
  };

  // Project-scope status label reflects override presence only — user inheritance is
  // surfaced via inline copy below the credential form.
  const statusLabel = hasCredentialOverride
    ? 'Project override'
    : hasUserCredential
      ? 'Inheriting user credential'
      : 'No credential';
  const statusKind: 'connected' | 'disconnected' =
    hasCredentialOverride || hasUserCredential ? 'connected' : 'disconnected';

  return (
    <div
      className="border border-border-default rounded-md p-4 flex flex-col gap-4"
      data-testid={`project-agent-card-${agent.id}`}
    >
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex flex-col gap-1 min-w-0">
          <h3 className="text-base font-semibold text-fg-primary">{agent.name}</h3>
          <p className="text-xs text-fg-muted">{agent.description}</p>
        </div>
        <StatusBadge status={statusKind} label={statusLabel} />
      </div>

      <section
        aria-labelledby={`project-agent-connection-${agent.id}`}
        className="flex flex-col gap-3 pt-4 border-t border-border-default"
      >
        <h4
          id={`project-agent-connection-${agent.id}`}
          className="text-xs font-semibold uppercase tracking-wide text-fg-muted"
        >
          Credential (project override)
        </h4>
        <AgentKeyCard
          agent={agent}
          credentials={projectCredentials}
          onSave={onSaveCredential}
          onDelete={onDeleteCredential}
          scope="project"
          embedded
        />
        {!hasCredentialOverride && hasUserCredential && (
          <p className="text-xs text-fg-muted">
            Inheriting user credential
            {activeUserCred?.maskedKey ? ` (${activeUserCred.maskedKey})` : ''} — add an override
            above to use a different key for this project only.
          </p>
        )}
        {!hasCredentialOverride && !hasUserCredential && (
          <p className="text-xs text-fg-muted">
            No user-level credential set. Adding one here creates a project-scoped credential.
            To set a default across all your projects, use Settings → Agents.
          </p>
        )}
      </section>

      <section
        aria-labelledby={`project-agent-config-${agent.id}`}
        className="flex flex-col gap-3 pt-4 border-t border-border-default"
      >
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h4
            id={`project-agent-config-${agent.id}`}
            className="text-xs font-semibold uppercase tracking-wide text-fg-muted"
          >
            Configuration (project override)
          </h4>
          {hasConfigOverride && (
            <span className="text-xs text-accent" aria-label="Project override active">
              override active
            </span>
          )}
        </div>

        {error && (
          <Alert variant="error" onDismiss={() => setError(null)}>
            {error}
          </Alert>
        )}
        {success && <Alert variant="success">Project override saved</Alert>}

        <div>
          <label
            htmlFor={`project-agent-model-${agent.id}`}
            className="text-sm font-medium text-fg-primary mb-1 block"
          >
            Model
          </label>
          <div className="text-xs text-fg-muted mb-2">
            Leave empty to inherit your user-level model.
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

        <div>
          <label
            htmlFor={`project-agent-permission-${agent.id}`}
            className="text-sm font-medium text-fg-primary mb-1 block"
          >
            Permission Mode
          </label>
          <div className="text-xs text-fg-muted mb-2">
            Leave empty to inherit your user-level setting.
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
            onClick={() => void handleSaveConfig()}
            disabled={saving || clearing || !configChanged}
            loading={saving}
            data-testid={`project-agent-save-${agent.id}`}
          >
            Save Override
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void handleClearConfig()}
            disabled={saving || clearing || !hasConfigOverride}
            loading={clearing}
            data-testid={`project-agent-clear-${agent.id}`}
          >
            Clear Override
          </Button>
        </div>
      </section>
    </div>
  );
}
