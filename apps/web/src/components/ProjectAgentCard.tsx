/**
 * Per-project agent card: which account the project uses (managed in the
 * Accounts tab) and project-scoped model / permission mode overrides, which fall
 * through to your Settings → Agents defaults when empty.
 */
import type {
  AgentInfo,
  AgentPermissionMode,
  AgentType,
} from '@simple-agent-manager/shared';
import {
  AGENT_PERMISSION_MODE_LABELS,
  DEFAULT_OPENCODE_ZEN_MODEL,
  VALID_PERMISSION_MODES,
} from '@simple-agent-manager/shared';
import { Alert, Button, Card, StatusBadge } from '@simple-agent-manager/ui';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';

import type { ProjectResolution } from './accounts/account-model';
import { ModelSelect } from './ModelSelect';

const DEFAULT_SUCCESS_BANNER_MS = 3000;
const SUCCESS_BANNER_MS = Number(
  import.meta.env.VITE_SUCCESS_BANNER_MS ?? DEFAULT_SUCCESS_BANNER_MS
);

const FORM_CONTROL =
  'w-full min-h-11 py-2 px-3 rounded-sm border border-border-default bg-inset text-fg-primary text-sm outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring box-border';

function modelPlaceholderFor(agentId: string): string {
  switch (agentId) {
    case 'claude-code':
      return 'e.g. claude-opus-5, claude-sonnet-5';
    case 'openai-codex':
      return 'e.g. gpt-5-codex, o3';
    case 'google-gemini':
      return 'e.g. gemini-2.5-pro';
    case 'opencode':
      return `e.g. ${DEFAULT_OPENCODE_ZEN_MODEL}`;
    default:
      return 'Model identifier (leave empty to inherit)';
  }
}

export interface ProjectAgentCardProps {
  agent: AgentInfo;
  projectId: string;
  /** Which account this project uses for the agent; undefined while loading. */
  account: ProjectResolution | undefined;
  defaultValue: { model?: string | null; permissionMode?: AgentPermissionMode | null } | undefined;
  onSaveDefault: (
    agentType: AgentType,
    entry: { model: string | null; permissionMode: AgentPermissionMode | null }
  ) => Promise<void>;
  onClearDefault: (agentType: AgentType) => Promise<void>;
}

export function ProjectAgentCard({
  agent,
  projectId,
  account,
  defaultValue,
  onSaveDefault,
  onClearDefault,
}: ProjectAgentCardProps) {
  const [model, setModel] = useState(defaultValue?.model ?? '');
  const [permissionMode, setPermissionMode] = useState<AgentPermissionMode | ''>(
    defaultValue?.permissionMode ?? ''
  );
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    setModel(defaultValue?.model ?? '');
    setPermissionMode(defaultValue?.permissionMode ?? '');
  }, [defaultValue]);

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

  const summary = account ? describeAccount(account) : null;

  return (
    <Card
      variant="glass"
      className="p-4 flex flex-col gap-4"
      data-testid={`project-agent-card-${agent.id}`}
    >
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex flex-col gap-1 min-w-0">
          <h3 className="text-base font-semibold text-fg-primary">{agent.name}</h3>
          <p className="text-xs text-fg-muted">{agent.description}</p>
        </div>
        {summary && <StatusBadge status={summary.status} label={summary.label} />}
      </div>

      <section
        aria-labelledby={`project-agent-connection-${agent.id}`}
        className="flex flex-col gap-3 pt-4 border-t border-border-default"
      >
        <h4
          id={`project-agent-connection-${agent.id}`}
          className="text-xs font-semibold uppercase tracking-wide text-fg-muted"
        >
          Account
        </h4>
        <p className="m-0 text-xs text-fg-muted">
          {summary?.detail ?? 'Checking which account this project uses…'}{' '}
          <Link to={`/projects/${projectId}/settings/accounts`} className="font-medium text-accent">
            Manage in Accounts
          </Link>
        </p>
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
            <div
              role="alert"
              className="text-xs text-danger-fg py-2 px-3 rounded-md bg-danger-tint mt-2"
            >
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
    </Card>
  );
}

/**
 * Same vocabulary as Project settings → Accounts, read from the same resolution,
 * so the two tabs can never disagree about which account a project uses.
 */
function describeAccount(account: ProjectResolution): {
  label: string;
  status: 'connected' | 'disconnected';
  detail: string;
} {
  switch (account.source) {
    case 'pinned':
      return {
        label: 'Pinned account',
        status: 'connected',
        detail: `This project uses ${account.account.label}, pinned to it.`,
      };
    case 'default':
      return {
        label: 'Your default account',
        status: 'connected',
        detail: `This project uses your default account, ${account.account.label}.`,
      };
    case 'blocked':
      return {
        label: 'Paused pin',
        status: 'disconnected',
        detail: 'Its pinned account is paused, so this agent can’t run here.',
      };
    case 'platform':
      return {
        label: 'SAM platform',
        status: 'connected',
        detail: 'This project uses SAM’s platform account.',
      };
    case 'none':
      return {
        label: 'No account',
        status: 'disconnected',
        detail: 'No account connected for this agent yet.',
      };
  }
}
