/**
 * An agent's defaults — model, permission mode and (where it applies) the AI
 * provider and OpenCode provider. Defaults belong to the agent, never to an
 * account: they apply whichever account a project resolves to, and project
 * profiles can override them.
 */
import type {
  AgentInfo,
  AgentPermissionMode,
  AgentProviderMode,
  AgentSettingsResponse,
  AgentType,
  OpenCodeProvider,
  SaveAgentSettingsRequest,
} from '@simple-agent-manager/shared';
import {
  AGENT_PERMISSION_MODE_LABELS,
  DEFAULT_AGENT_PERMISSION_MODE,
  DEFAULT_OPENCODE_PROVIDER,
  DEFAULT_OPENCODE_ZEN_MODEL,
  getModelsForAgent,
  OPENCODE_PROVIDER_OPTIONS,
  OPENCODE_PROVIDERS,
  VALID_PERMISSION_MODES,
} from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { Check, Layers } from 'lucide-react';
import { useEffect, useState } from 'react';

import { ProviderMark } from './accounts/AccountBits';
import { getAccountProvider } from './accounts/provider-meta';
import { ModelSelect } from './ModelSelect';

const DEFAULT_SUCCESS_BANNER_MS = 3000;
const SUCCESS_BANNER_MS = Number(
  import.meta.env.VITE_SUCCESS_BANNER_MS ?? DEFAULT_SUCCESS_BANNER_MS
);

/** OpenCode's own console, the only place Zen credit balance is visible. */
const OPENCODE_CONSOLE_URL = 'https://opencode.ai/zen';

const PROVIDER_MODE_LABELS: Record<AgentProviderMode | '', string> = {
  '': 'Automatic — your connected account',
  'user-api-key': 'Your API key',
  oauth: 'Your subscription',
  sam: 'SAM platform',
};

export interface AgentSettingsCardProps {
  agent: AgentInfo;
  settings: AgentSettingsResponse | null;
  onSave: (agentType: AgentType, data: SaveAgentSettingsRequest) => Promise<void>;
  onReset: (agentType: AgentType) => Promise<void>;
}

const fieldClass =
  'w-full min-h-11 py-2 px-3 rounded-sm border border-border-default bg-inset text-fg-primary text-sm outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring box-border';

function modelName(agentType: string, modelId: string): string {
  if (!modelId) return 'its default model';
  return getModelsForAgent(agentType).find((model) => model.id === modelId)?.name ?? modelId;
}

export function AgentSettingsCard({ agent, settings, onSave, onReset }: AgentSettingsCardProps) {
  const [model, setModel] = useState(settings?.model ?? '');
  const [permissionMode, setPermissionMode] = useState<AgentPermissionMode>(
    settings?.permissionMode ?? DEFAULT_AGENT_PERMISSION_MODE
  );
  const [opencodeProvider, setOpencodeProvider] = useState<OpenCodeProvider>(
    settings?.opencodeProvider ?? DEFAULT_OPENCODE_PROVIDER
  );
  const [opencodeBaseUrl, setOpencodeBaseUrl] = useState(settings?.opencodeBaseUrl ?? '');
  const [providerMode, setProviderMode] = useState<AgentProviderMode | ''>(
    settings?.providerMode ?? ''
  );
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const provider = getAccountProvider('agent', agent.id);
  const isOpenCode = agent.id === 'opencode';
  const supportsSamProvider = agent.id === 'claude-code' || agent.id === 'openai-codex';
  const supportsOAuthProvider = agent.id === 'claude-code';
  const providerMeta = OPENCODE_PROVIDERS[opencodeProvider];
  const showBaseUrl = opencodeProvider === 'custom';
  const openCodeModelProviderFilter: readonly string[] | undefined = (() => {
    if (!isOpenCode) return undefined;
    if (opencodeProvider === 'opencode-zen') return ['opencode'];
    if (opencodeProvider === 'opencode-go') return ['opencode-go'];
    return undefined;
  })();
  const useOpenCodeModelCatalog = isOpenCode && openCodeModelProviderFilter !== undefined;

  // Sync state when settings prop changes
  useEffect(() => {
    setModel(settings?.model ?? '');
    setPermissionMode(settings?.permissionMode ?? DEFAULT_AGENT_PERMISSION_MODE);
    setOpencodeProvider(settings?.opencodeProvider ?? DEFAULT_OPENCODE_PROVIDER);
    setOpencodeBaseUrl(settings?.opencodeBaseUrl ?? '');
    setProviderMode(settings?.providerMode ?? '');
  }, [settings]);

  const handleSave = async () => {
    try {
      setError(null);
      setSuccess(null);
      setSaving(true);
      const data: SaveAgentSettingsRequest = {
        model: model.trim() || null,
        permissionMode,
      };
      if (isOpenCode) {
        data.opencodeProvider = opencodeProvider;
        data.opencodeBaseUrl = opencodeBaseUrl.trim() || null;
      }
      if (supportsSamProvider) {
        data.providerMode = providerMode || null;
      }
      await onSave(agent.id, data);
      setSuccess('Saved');
      setTimeout(() => setSuccess(null), SUCCESS_BANNER_MS);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    try {
      setError(null);
      setSuccess(null);
      setResetting(true);
      await onReset(agent.id);
      setModel('');
      setPermissionMode(DEFAULT_AGENT_PERMISSION_MODE);
      setOpencodeProvider(DEFAULT_OPENCODE_PROVIDER);
      setOpencodeBaseUrl('');
      setProviderMode('');
      setSuccess('Back to SAM’s settings');
      setTimeout(() => setSuccess(null), SUCCESS_BANNER_MS);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset settings');
    } finally {
      setResetting(false);
    }
  };

  const modelPlaceholder = (() => {
    if (isOpenCode && providerMeta) return providerMeta.modelPlaceholder;
    switch (agent.id) {
      case 'claude-code':
        return 'e.g. claude-opus-5, claude-sonnet-5';
      case 'openai-codex':
        return 'e.g. gpt-5-codex, o3';
      case 'google-gemini':
        return 'e.g. gemini-2.5-pro';
      case 'opencode':
        return `e.g. ${DEFAULT_OPENCODE_ZEN_MODEL}`;
      default:
        return 'Model identifier';
    }
  })();

  const hasChanges = (() => {
    if ((model.trim() || null) !== (settings?.model ?? null)) return true;
    if (permissionMode !== (settings?.permissionMode ?? DEFAULT_AGENT_PERMISSION_MODE)) return true;
    if (isOpenCode) {
      if (opencodeProvider !== (settings?.opencodeProvider ?? DEFAULT_OPENCODE_PROVIDER))
        return true;
      if ((opencodeBaseUrl.trim() || null) !== (settings?.opencodeBaseUrl ?? null)) return true;
    }
    if (supportsSamProvider) {
      if ((providerMode || null) !== (settings?.providerMode ?? null)) return true;
    }
    return false;
  })();

  const permissionLabel = AGENT_PERMISSION_MODE_LABELS[permissionMode] ?? permissionMode;

  return (
    <article
      className="flex min-w-0 flex-col gap-4 rounded-lg border border-border-default bg-surface p-4"
      data-testid={`agent-settings-${agent.id}`}
    >
      <header className="flex min-w-0 items-center gap-2.5">
        <ProviderMark provider={provider} size={32} />
        <div className="min-w-0">
          <h3 className="m-0 truncate text-sm font-semibold text-fg-primary">{agent.name}</h3>
          <p className="m-0 text-[11px] text-fg-muted">Any {provider.company} account</p>
        </div>
      </header>

      <p className="m-0 rounded-md bg-inset px-3 py-2 text-[13px] leading-relaxed text-fg-muted">
        When you use <strong className="text-fg-primary">{agent.name}</strong>, SAM runs{' '}
        <strong className="text-fg-primary">{modelName(agent.id, model.trim())}</strong> with{' '}
        <strong className="text-fg-primary">{permissionLabel.toLowerCase()}</strong>
        {supportsSamProvider && providerMode === 'sam' ? (
          <>
            {' '}
            through the <strong className="text-fg-primary">SAM platform</strong>
          </>
        ) : null}
        .
      </p>

      {isOpenCode && (
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor={`opencode-provider-${agent.id}`}
            className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted"
          >
            OpenCode provider
          </label>
          <select
            id={`opencode-provider-${agent.id}`}
            value={opencodeProvider}
            onChange={(e) => {
              const val = e.target.value as OpenCodeProvider;
              setOpencodeProvider(val);
              if (val !== 'custom') setOpencodeBaseUrl('');
            }}
            className={fieldClass}
            data-testid="opencode-provider-select"
          >
            {OPENCODE_PROVIDER_OPTIONS.map((p) => (
              <option key={p} value={p}>
                {OPENCODE_PROVIDERS[p].label}
              </option>
            ))}
          </select>
          {opencodeProvider === 'opencode-zen' && (
            <p className="m-0 text-xs text-fg-muted" data-testid="opencode-zen-balance-note">
              Zen bills per request from a credit balance that only OpenCode&apos;s console shows,
              so SAM cannot display remaining Zen credit.{' '}
              <a
                href={OPENCODE_CONSOLE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent underline-offset-2 hover:underline"
              >
                Check your balance in the OpenCode console
              </a>
              {
                '. OpenCode Go plans report rolling, weekly and monthly usage in the session header.'
              }
            </p>
          )}
        </div>
      )}

      {isOpenCode && showBaseUrl && (
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor={`opencode-base-url-${agent.id}`}
            className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted"
          >
            Base URL
          </label>
          <input
            id={`opencode-base-url-${agent.id}`}
            type="url"
            value={opencodeBaseUrl}
            onChange={(e) => setOpencodeBaseUrl(e.target.value)}
            placeholder="https://api.example.com/v1"
            className={fieldClass}
            data-testid="opencode-base-url-input"
          />
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor={`model-input-${agent.id}`}
          className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted"
        >
          Model
        </label>
        <ModelSelect
          id={`model-input-${agent.id}`}
          agentType={agent.id}
          value={model}
          onChange={setModel}
          placeholder={modelPlaceholder}
          useDynamicCatalog={useOpenCodeModelCatalog}
          modelProviderFilter={openCodeModelProviderFilter}
          allowStaticCatalog={!isOpenCode || useOpenCodeModelCatalog}
          data-testid={`model-input-${agent.id}`}
        />
        <p className="m-0 text-[11px] text-fg-muted">
          Leave empty for the agent&apos;s default. Availability depends on the account&apos;s plan.
        </p>
      </div>

      <fieldset className="m-0 flex min-w-0 flex-col gap-1.5 border-none p-0">
        <legend className="mb-1.5 p-0 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
          Permissions
        </legend>
        <div className="flex flex-wrap gap-1.5">
          {VALID_PERMISSION_MODES.map((mode) => {
            const checked = permissionMode === mode;
            return (
              <label
                key={mode}
                className={`inline-flex min-h-9 cursor-pointer items-center rounded-full border px-3 text-xs font-medium transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus-ring ${
                  checked
                    ? 'border-accent bg-accent-tint text-fg-primary'
                    : 'border-border-default text-fg-muted hover:text-fg-primary'
                }`}
              >
                <input
                  type="radio"
                  className="sr-only"
                  name={`permission-mode-${agent.id}`}
                  value={mode}
                  checked={checked}
                  onChange={() => setPermissionMode(mode as AgentPermissionMode)}
                  data-testid={`permission-mode-${agent.id}-${mode}`}
                />
                {checked && <Check size={12} aria-hidden="true" className="-ml-0.5 mr-1" />}
                {AGENT_PERMISSION_MODE_LABELS[mode] || mode}
              </label>
            );
          })}
        </div>
        {permissionMode === 'bypassPermissions' && (
          <p
            role="note"
            className="m-0 rounded-md bg-warning-tint px-3 py-2 text-xs text-warning-fg"
          >
            Bypass disables all safety prompts: the agent runs commands and edits files without
            asking. Workspaces are isolated VMs or containers.
          </p>
        )}
      </fieldset>

      {supportsSamProvider && (
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor={`provider-mode-${agent.id}`}
            className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted"
          >
            Billing
          </label>
          <select
            id={`provider-mode-${agent.id}`}
            value={providerMode}
            onChange={(e) => setProviderMode(e.target.value as AgentProviderMode | '')}
            className={fieldClass}
            data-testid={`provider-mode-${agent.id}`}
          >
            <option value="">{PROVIDER_MODE_LABELS['']}</option>
            <option value="user-api-key">{PROVIDER_MODE_LABELS['user-api-key']}</option>
            {supportsOAuthProvider && <option value="oauth">{PROVIDER_MODE_LABELS.oauth}</option>}
            <option value="sam">{PROVIDER_MODE_LABELS.sam}</option>
          </select>
          {providerMode === 'sam' && (
            <p className="m-0 rounded-md border border-border-default bg-inset px-3 py-2 text-xs text-fg-muted">
              Requests go through the SAM platform proxy and count against your daily token budget
              and monthly cost cap instead of your own account.
            </p>
          )}
        </div>
      )}

      <footer className="flex flex-wrap items-center gap-2 border-t border-border-default pt-3">
        <Button
          size="sm"
          onClick={() => void handleSave()}
          disabled={saving || resetting || !hasChanges}
          loading={saving}
          data-testid={`save-settings-${agent.id}`}
        >
          Save changes
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void handleReset()}
          disabled={saving || resetting}
          loading={resetting}
          data-testid={`reset-settings-${agent.id}`}
        >
          Reset
        </Button>
        {/* Feedback sits beside the buttons: the top of a tall card is off-screen on phones. */}
        <span role="status" className="text-xs text-success-fg">
          {success}
        </span>
        {error && (
          <p role="alert" className="m-0 w-full text-xs text-danger-fg">
            {error}
          </p>
        )}
        <span className="inline-flex min-w-0 items-center gap-1 text-[11px] text-fg-muted sm:ml-auto">
          <Layers size={12} aria-hidden="true" className="shrink-0" />
          Project profiles can override these.
        </span>
      </footer>
    </article>
  );
}
