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
  SaveAgentCredentialRequest,
} from '@simple-agent-manager/shared';
import { AGENT_CATALOG } from '@simple-agent-manager/shared';
import { Alert, Button } from '@simple-agent-manager/ui';
import { useState } from 'react';

import { useToast } from '../hooks/useToast';
import { saveAgentCredential, saveProjectAgentCredential } from '../lib/api';

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

  const selectedAgent = AGENT_CATALOG.find((a) => a.id === agentId);
  const hasOAuth = selectedAgent?.oauthSupport != null;
  const isCodexAuthJson = selectedAgent?.id === 'openai-codex' && authMethod === 'oauth-token';
  const flowVerb =
    mode === 'replace' ? 'Replace' : mode === 'project-override' ? 'Save override' : 'Connect';

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
        toast.success(`${selectedAgent?.name ?? agentId} saved for this project`);
      } else {
        await saveAgentCredential(request);
        toast.success(
          `${selectedAgent?.name ?? agentId} ${mode === 'replace' ? 'replaced' : 'connected'}`
        );
      }
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
              {authMethod === 'api-key'
                ? 'API Key'
                : isCodexAuthJson
                  ? 'Codex auth.json'
                  : 'OAuth Token'}
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
                  {selectedAgent.provider} console
                </a>
              </p>
            )}
            {authMethod === 'oauth-token' && selectedAgent.oauthSupport && (
              <p className="m-0 text-xs text-fg-muted">
                {selectedAgent.oauthSupport.setupInstructions}
              </p>
            )}
            {isCodexAuthJson ? (
              <textarea
                id="connect-credential"
                placeholder="Paste the full contents of ~/.codex/auth.json"
                value={credential}
                onChange={(e) => setCredential(e.currentTarget.value)}
                className="w-full py-2 px-3 min-h-32 resize-y border border-border-default rounded-sm bg-inset text-fg-primary text-[0.8125rem] font-mono box-border"
              />
            ) : (
              <input
                id="connect-credential"
                type="password"
                placeholder={authMethod === 'api-key' ? selectedAgent.envVarName : 'Paste token...'}
                value={credential}
                onChange={(e) => setCredential(e.currentTarget.value)}
                className="w-full py-2 px-3 min-h-9 border border-border-default rounded-sm bg-inset text-fg-primary text-[0.8125rem] font-mono box-border"
              />
            )}
          </div>

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
