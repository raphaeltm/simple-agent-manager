/**
 * Connect step for an agent account inside the connect sheet. Saves through the
 * validated legacy path (`saveAgentCredential` / `saveProjectAgentCredential`),
 * which also mirrors the account into the cc_* tables and makes it the default
 * for its scope.
 */
import type {
  AgentType,
  CredentialKind,
  OpenCodeProvider,
  SaveAgentCredentialRequest,
} from '@simple-agent-manager/shared';
import {
  AGENT_CATALOG,
  DEFAULT_OPENCODE_PROVIDER,
  OPENCODE_PROVIDER_OPTIONS,
  OPENCODE_PROVIDERS,
} from '@simple-agent-manager/shared';
import { Alert, Button } from '@simple-agent-manager/ui';
import { Check } from 'lucide-react';
import { useState } from 'react';

import { useToast } from '../../hooks/useToast';
import { saveAgentCredential, saveAgentSettings, saveProjectAgentCredential } from '../../lib/api';
import { AgentCredentialConnectTrigger } from '../CodexConnectTrigger';
import { getAccountProvider } from './provider-meta';

export interface AgentConnectFormProps {
  agentId: string;
  /** When set, writes a project-scoped account (the project's override). */
  projectId?: string;
  /** Pre-select API key vs subscription, e.g. when replacing an account. */
  initialAuthMethod?: CredentialKind;
  /** Called after a successful save so the sheet can move on. */
  onConnected?: () => void;
  onCancel?: () => void;
}

const SUBSCRIPTION_COPY: Record<string, { title: string; detail: string }> = {
  'claude-code': {
    title: 'Claude subscription',
    detail: 'Use your Pro or Max plan with a setup token.',
  },
  'openai-codex': {
    title: 'ChatGPT sign-in',
    detail: 'Use your ChatGPT plan through Codex’s auth.json.',
  },
};

const fieldClass =
  'w-full py-2 px-3 min-h-11 border border-border-default rounded-sm bg-inset text-fg-primary text-[0.8125rem] box-border';

export function AgentConnectForm({
  agentId,
  projectId,
  initialAuthMethod,
  onConnected,
  onCancel,
}: Readonly<AgentConnectFormProps>) {
  const toast = useToast();
  const agent = AGENT_CATALOG.find((candidate) => candidate.id === agentId);
  const hasSubscription = agent?.oauthSupport != null;
  const [authMethod, setAuthMethod] = useState<CredentialKind>(
    initialAuthMethod ?? (hasSubscription && SUBSCRIPTION_COPY[agentId] ? 'oauth-token' : 'api-key')
  );
  const [credential, setCredential] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opencodeProvider, setOpencodeProvider] =
    useState<OpenCodeProvider>(DEFAULT_OPENCODE_PROVIDER);
  const [opencodeModel, setOpencodeModel] = useState('');
  const [opencodeBaseUrl, setOpencodeBaseUrl] = useState('');
  // Whether the guided sign-in button is on screen; the manual field is worded
  // as its alternative only when it is.
  const [guidedShown, setGuidedShown] = useState(false);
  const [savedCredential, setSavedCredential] = useState<string | null>(null);

  if (!agent) {
    return <Alert variant="error">This agent is not available on this installation.</Alert>;
  }

  const isCodexAuthJson = agent.id === 'openai-codex' && authMethod === 'oauth-token';
  const isGuidedSubscription =
    authMethod === 'oauth-token' && (agent.id === 'openai-codex' || agent.id === 'claude-code');
  const isOpenCodeApiKey = agent.id === 'opencode' && authMethod === 'api-key';
  // OpenCode provider + model live in user-scoped agent settings, so they are
  // only offered when connecting your own default.
  const showOpenCodeConfig = isOpenCodeApiKey && !projectId;
  const opencodeProviderMeta = OPENCODE_PROVIDERS[opencodeProvider];
  const subscription = SUBSCRIPTION_COPY[agent.id] ?? {
    title: 'OAuth token',
    detail: agent.oauthSupport?.setupInstructions ?? 'Use a subscription token.',
  };

  const methods: Array<{ id: CredentialKind; title: string; detail: string }> = [
    ...(hasSubscription ? [{ id: 'oauth-token' as const, ...subscription }] : []),
    {
      id: 'api-key',
      title: isOpenCodeApiKey || agent.id === 'opencode' ? 'OpenCode Zen or Go key' : 'API key',
      detail:
        agent.id === 'opencode'
          ? 'Pay from your OpenCode Zen credits or Go plan.'
          : `Pay-as-you-go key from your ${getAccountProvider('agent', agent.id).company} console.`,
    },
  ];

  const handleSave = async () => {
    if (!credential.trim()) return;
    setSaving(true);
    setError(null);
    const request: SaveAgentCredentialRequest = {
      agentType: agent.id as AgentType,
      credentialKind: authMethod,
      credential: credential.trim(),
    };
    try {
      // A retry after only the settings step failed must not store the key twice.
      if (savedCredential !== request.credential) {
        const saved = projectId
          ? await saveProjectAgentCredential(projectId, request)
          : await saveAgentCredential(request);
        setSavedCredential(request.credential);
        if (saved.validation?.valid === false) {
          toast.warning(`${agent.name} saved, but the credential looks invalid`);
        }
      }
      if (showOpenCodeConfig) {
        await saveAgentSettings('opencode', {
          opencodeProvider,
          opencodeBaseUrl: opencodeProvider === 'custom' ? opencodeBaseUrl.trim() || null : null,
          model: opencodeModel.trim() || null,
        });
      }
      toast.success(projectId ? `${agent.name} saved for this project` : `${agent.name} connected`);
      onConnected?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save credential');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <Alert variant="error" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      {methods.length > 1 && (
        <div role="radiogroup" aria-label="How to connect" className="flex flex-col gap-2">
          {methods.map((method) => {
            const active = method.id === authMethod;
            return (
              <button
                key={method.id}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => {
                  setAuthMethod(method.id);
                  setCredential('');
                }}
                className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 text-left ${
                  active ? 'border-accent bg-accent-tint' : 'border-border-default bg-inset'
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                    active ? 'border-accent bg-accent' : 'border-border-default'
                  }`}
                >
                  {active && <Check size={10} className="text-fg-on-accent" />}
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-semibold text-fg-primary">{method.title}</span>
                  <span className="text-xs text-fg-muted">{method.detail}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        {isGuidedSubscription && (
          <AgentCredentialConnectTrigger
            agentType={agent.id as 'openai-codex' | 'claude-code'}
            scope={projectId ? 'project' : 'user'}
            onConnected={onConnected}
            onAvailabilityChange={setGuidedShown}
          />
        )}
        <label htmlFor="connect-credential" className="text-xs font-medium text-fg-muted">
          {credentialLabel(
            authMethod,
            isOpenCodeApiKey,
            isCodexAuthJson,
            isGuidedSubscription && guidedShown
          )}
        </label>
        {authMethod === 'api-key' && agent.credentialHelpUrl && (
          <p className="m-0 text-xs text-fg-muted">
            Get your key from{' '}
            <a
              href={agent.credentialHelpUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent"
            >
              {isOpenCodeApiKey ? 'OpenCode' : `${agent.provider} console`}
            </a>
          </p>
        )}
        {authMethod === 'oauth-token' && agent.oauthSupport && (
          <p className="m-0 text-xs text-fg-muted">{agent.oauthSupport.setupInstructions}</p>
        )}
        {isCodexAuthJson ? (
          <textarea
            id="connect-credential"
            placeholder="Paste the full contents of ~/.codex/auth.json"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            value={credential}
            onChange={(e) => setCredential(e.currentTarget.value)}
            className={`${fieldClass} min-h-32 resize-y font-mono`}
          />
        ) : (
          <input
            id="connect-credential"
            type="password"
            autoComplete="off"
            placeholder={credentialPlaceholder(authMethod, isOpenCodeApiKey, agent.envVarName)}
            value={credential}
            onChange={(e) => setCredential(e.currentTarget.value)}
            className={`${fieldClass} font-mono`}
          />
        )}
        <p className="m-0 text-[11px] text-fg-muted">
          Encrypted before it’s stored. SAM never shows it again.
        </p>
      </div>

      {showOpenCodeConfig && (
        <>
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="connect-opencode-provider"
              className="text-xs font-medium text-fg-muted"
            >
              OpenCode provider
            </label>
            <select
              id="connect-opencode-provider"
              value={opencodeProvider}
              onChange={(e) => setOpencodeProvider(e.currentTarget.value as OpenCodeProvider)}
              className={fieldClass}
            >
              {OPENCODE_PROVIDER_OPTIONS.map((provider) => (
                <option key={provider} value={provider}>
                  {OPENCODE_PROVIDERS[provider].label}
                </option>
              ))}
            </select>
          </div>
          {opencodeProvider === 'custom' && (
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="connect-opencode-base-url"
                className="text-xs font-medium text-fg-muted"
              >
                Base URL
              </label>
              <input
                id="connect-opencode-base-url"
                type="text"
                placeholder="https://your-endpoint/v1"
                value={opencodeBaseUrl}
                onChange={(e) => setOpencodeBaseUrl(e.currentTarget.value)}
                className={`${fieldClass} font-mono`}
              />
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="connect-opencode-model" className="text-xs font-medium text-fg-muted">
              Model
            </label>
            <input
              id="connect-opencode-model"
              type="text"
              placeholder={opencodeProviderMeta.modelPlaceholder}
              value={opencodeModel}
              onChange={(e) => setOpencodeModel(e.currentTarget.value)}
              className={`${fieldClass} font-mono`}
            />
          </div>
        </>
      )}

      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
        )}
        <Button
          variant="primary"
          size="sm"
          loading={saving}
          disabled={saving || !credential.trim()}
          onClick={() => void handleSave()}
        >
          {projectId ? 'Use for this project' : 'Connect'}
        </Button>
      </div>
    </div>
  );
}

function credentialLabel(
  authMethod: CredentialKind,
  isOpenCodeApiKey: boolean,
  isCodexAuthJson: boolean,
  isGuided: boolean
): string {
  if (authMethod === 'api-key') return isOpenCodeApiKey ? 'OpenCode API key' : 'API key';
  if (isCodexAuthJson) return isGuided ? 'Or paste auth.json manually' : 'Codex auth.json';
  return isGuided ? 'Or paste a setup token manually' : 'Setup token';
}

function credentialPlaceholder(
  authMethod: CredentialKind,
  isOpenCodeApiKey: boolean,
  envVarName: string
): string {
  if (authMethod !== 'api-key') return 'Paste your setup token';
  return isOpenCodeApiKey ? 'OPENCODE_API_KEY' : envVarName;
}
