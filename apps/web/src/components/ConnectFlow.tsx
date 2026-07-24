/**
 * Guided Connect flow — lets users connect an agent credential through the
 * validated legacy save path (saveAgentCredential / saveProjectAgentCredential).
 *
 * Steps:
 *   1. Select consumer (agent)
 *   2. Choose auth method (API key / OAuth token)
 *   3. Enter credential
 *   4. Save via legacy path
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
import { useState } from 'react';

import { useToast } from '../hooks/useToast';
import { saveAgentCredential, saveAgentSettings, saveProjectAgentCredential } from '../lib/api';
import { CodexConnectTrigger } from './CodexConnectTrigger';

interface ConnectFlowProps {
  /** When set, writes project-scoped credentials. */
  projectId?: string;
  /** Pre-select a specific agent to connect. */
  initialAgentId?: string;
  /** Pre-select API key vs OAuth/auth.json for row-level replace actions. */
  initialAuthMethod?: CredentialKind;
  /** Adjusts button copy for connect, replace, and project override flows. */
  mode?: 'connect' | 'replace' | 'project-override';
  /** Called after a successful save so parent can refresh. */
  onConnected?: () => void;
  /** Called when user cancels or closes the flow. */
  onCancel?: () => void;
}

type ConnectFlowMode = 'connect' | 'replace' | 'project-override';

function getFlowVerb(mode: ConnectFlowMode): string {
  switch (mode) {
    case 'replace':
      return 'Replace';
    case 'project-override':
      return 'Save override';
    case 'connect':
      return 'Connect';
  }
}

function getSuccessMessage(agentName: string, mode: ConnectFlowMode, isProjectScoped: boolean): string {
  if (isProjectScoped) {
    return `${agentName} saved for this project`;
  }
  return `${agentName} ${mode === 'replace' ? 'replaced' : 'connected'}`;
}

function getCredentialLabel(
  authMethod: CredentialKind,
  isOpenCodeApiKey: boolean,
  isCodexAuthJson: boolean
): string {
  if (authMethod === 'api-key') {
    return isOpenCodeApiKey ? 'OpenCode API Key' : 'API Key';
  }
  return isCodexAuthJson ? 'Codex auth.json' : 'OAuth Token';
}

function getCredentialPlaceholder(
  authMethod: CredentialKind,
  isOpenCodeApiKey: boolean,
  envVarName: string
): string {
  if (authMethod !== 'api-key') {
    return 'Paste token...';
  }
  return isOpenCodeApiKey ? 'OPENCODE_API_KEY' : envVarName;
}

export function ConnectFlow({
  projectId,
  initialAgentId,
  initialAuthMethod,
  mode = projectId ? 'project-override' : 'connect',
  onConnected,
  onCancel,
}: ConnectFlowProps) {
  const toast = useToast();
  const [agentId, setAgentId] = useState<string>(initialAgentId ?? '');
  const [authMethod, setAuthMethod] = useState<CredentialKind>(initialAuthMethod ?? 'api-key');
  const [credential, setCredential] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opencodeProvider, setOpencodeProvider] = useState<OpenCodeProvider>(DEFAULT_OPENCODE_PROVIDER);
  const [opencodeModel, setOpencodeModel] = useState('');
  const [opencodeBaseUrl, setOpencodeBaseUrl] = useState('');

  const selectedAgent = AGENT_CATALOG.find((a) => a.id === agentId);
  const hasOAuth = selectedAgent?.oauthSupport != null;
  const isCodexAuthJson = selectedAgent?.id === 'openai-codex' && authMethod === 'oauth-token';
  const isOpenCodeApiKey = selectedAgent?.id === 'opencode' && authMethod === 'api-key';
  // OpenCode provider + model selection lives in the same flow as the key, but
  // agent-settings are user-scoped only — so we only surface it for user-scope connects.
  const showOpenCodeConfig = isOpenCodeApiKey && !projectId;
  const opencodeProviderMeta = OPENCODE_PROVIDERS[opencodeProvider];
  const flowVerb = getFlowVerb(mode);

  const handleSave = async () => {
    if (!agentId || !credential.trim()) return;
    setSaving(true);
    setError(null);

    const request: SaveAgentCredentialRequest = {
      agentType: agentId as AgentType,
      credentialKind: authMethod,
      credential: credential.trim(),
    };

    try {
      if (projectId) {
        await saveProjectAgentCredential(projectId, request);
      } else {
        await saveAgentCredential(request);
      }
      if (showOpenCodeConfig) {
        await saveAgentSettings('opencode', {
          opencodeProvider,
          opencodeBaseUrl:
            opencodeProvider === 'custom' ? opencodeBaseUrl.trim() || null : null,
          model: opencodeModel.trim() || null,
        });
      }
      toast.success(getSuccessMessage(selectedAgent?.name ?? agentId, mode, Boolean(projectId)));
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

      {/* Step 1: Select agent */}
      <div className="flex flex-col gap-1.5">
        <div className="text-xs font-medium text-fg-muted">Agent</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {AGENT_CATALOG.map((agent) => {
            const isSelected = agentId === agent.id;
            return (
              <button
                key={agent.id}
                type="button"
                aria-pressed={isSelected}
                onClick={() => {
                  setAgentId(agent.id);
                  setAuthMethod('api-key');
                  setCredential('');
                }}
                className={`p-2.5 rounded-md text-left transition-all ${
                  isSelected
                    ? 'border-2 border-accent bg-accent-tint'
                    : 'border border-border-default bg-[color-mix(in_srgb,var(--sam-glass-nested-bg)_80%,transparent)]'
                } cursor-pointer`}
              >
                <div className="text-sm font-medium text-fg-primary">{agent.name}</div>
                <div className="text-xs text-fg-muted mt-0.5">{agent.description}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Step 2 + 3: Auth method & credential (shown after agent selection) */}
      {selectedAgent && (
        <>
          {/* Auth method selector */}
          <div className="flex flex-col gap-1.5">
            <div className="text-xs font-medium text-fg-muted">Authentication method</div>
            <div className="flex gap-2">
              <button
                type="button"
                aria-pressed={authMethod === 'api-key'}
                onClick={() => {
                  setAuthMethod('api-key');
                  setCredential('');
                }}
                className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-all ${
                  authMethod === 'api-key'
                    ? 'border-2 border-accent bg-accent-tint text-fg-primary'
                    : 'border border-border-default text-fg-muted'
                } cursor-pointer`}
              >
                API Key
              </button>
              {hasOAuth && (
                <button
                  type="button"
                  aria-pressed={authMethod === 'oauth-token'}
                  onClick={() => {
                    setAuthMethod('oauth-token');
                    setCredential('');
                  }}
                  className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-all ${
                    authMethod === 'oauth-token'
                      ? 'border-2 border-accent bg-accent-tint text-fg-primary'
                      : 'border border-border-default text-fg-muted'
                  } cursor-pointer`}
                >
                  {selectedAgent.id === 'openai-codex' ? 'Codex auth.json' : 'OAuth / Subscription'}
                </button>
              )}
            </div>
          </div>

          {/* Credential input */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="connect-credential" className="text-xs font-medium text-fg-muted">
              {getCredentialLabel(authMethod, isOpenCodeApiKey, isCodexAuthJson)}
            </label>
            {authMethod === 'api-key' && selectedAgent.credentialHelpUrl && (
              <p className="m-0 text-xs text-fg-muted">
                Get your key from{' '}
                <a
                  href={selectedAgent.credentialHelpUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent"
                >
                  {isOpenCodeApiKey ? 'OpenCode' : `${selectedAgent.provider} console`}
                </a>
              </p>
            )}
            {authMethod === 'oauth-token' && selectedAgent.oauthSupport && (
              <p className="m-0 text-xs text-fg-muted">
                {selectedAgent.oauthSupport.setupInstructions}
              </p>
            )}
            {isCodexAuthJson ? (
              <div className="flex flex-col gap-2">
                {/* Guided flow (only rendered when the platform gate is enabled). */}
                <CodexConnectTrigger scope={projectId ? 'project' : 'user'} onConnected={onConnected} />
                <div className="text-xs font-medium text-fg-muted">
                  Or paste auth.json manually
                </div>
                <textarea
                  id="connect-credential"
                  placeholder="Paste the full contents of ~/.codex/auth.json"
                  value={credential}
                  onChange={(e) => setCredential(e.currentTarget.value)}
                  className="w-full py-2 px-3 min-h-32 resize-y border border-border-default rounded-sm bg-inset text-fg-primary text-[0.8125rem] font-mono box-border"
                />
              </div>
            ) : (
              <input
                id="connect-credential"
                type="password"
                placeholder={getCredentialPlaceholder(
                  authMethod,
                  isOpenCodeApiKey,
                  selectedAgent.envVarName
                )}
                value={credential}
                onChange={(e) => setCredential(e.currentTarget.value)}
                className="w-full py-2 px-3 min-h-9 border border-border-default rounded-sm bg-inset text-fg-primary text-[0.8125rem] font-mono box-border"
              />
            )}
          </div>

          {/* OpenCode provider + model (same flow as the key, user scope only) */}
          {showOpenCodeConfig && (
            <>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="connect-opencode-provider" className="text-xs font-medium text-fg-muted">
                  OpenCode provider
                </label>
                <select
                  id="connect-opencode-provider"
                  value={opencodeProvider}
                  onChange={(e) => setOpencodeProvider(e.currentTarget.value as OpenCodeProvider)}
                  className="w-full py-2 px-3 min-h-9 border border-border-default rounded-sm bg-inset text-fg-primary text-[0.8125rem] box-border"
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
                  <label htmlFor="connect-opencode-base-url" className="text-xs font-medium text-fg-muted">
                    Base URL
                  </label>
                  <input
                    id="connect-opencode-base-url"
                    type="text"
                    placeholder="https://your-endpoint/v1"
                    value={opencodeBaseUrl}
                    onChange={(e) => setOpencodeBaseUrl(e.currentTarget.value)}
                    className="w-full py-2 px-3 min-h-9 border border-border-default rounded-sm bg-inset text-fg-primary text-[0.8125rem] font-mono box-border"
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
                  className="w-full py-2 px-3 min-h-9 border border-border-default rounded-sm bg-inset text-fg-primary text-[0.8125rem] font-mono box-border"
                />
              </div>
            </>
          )}

          {/* Actions */}
          <div className="flex gap-2 justify-end">
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
              {flowVerb}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
