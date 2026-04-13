import type { AgentCredentialInfo, AgentInfo, AgentType, CredentialKind, OpenCodeProvider, SaveAgentCredentialRequest } from '@simple-agent-manager/shared';
import { getAgentDefinition, OPENCODE_PROVIDERS } from '@simple-agent-manager/shared';
import { Alert, Button, Input, StatusBadge } from '@simple-agent-manager/ui';
import { useState } from 'react';

interface AgentKeyCardProps {
  agent: AgentInfo;
  credentials?: AgentCredentialInfo[] | null; // Now an array for multiple credential types
  onSave: (request: SaveAgentCredentialRequest) => Promise<void>;
  onDelete: (agentType: AgentType, credentialKind: CredentialKind) => Promise<void>;
  /** The currently selected OpenCode provider (from agent settings). Affects key labels. */
  opencodeProvider?: OpenCodeProvider | null;
}

/**
 * Card for managing a single agent's credentials (API key and/or OAuth token).
 */
export function AgentKeyCard({ agent, credentials, onSave, onDelete, opencodeProvider }: AgentKeyCardProps) {
  const [credential, setCredential] = useState('');
  const [credentialKind, setCredentialKind] = useState<CredentialKind>('api-key');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  // Get agent definition for OAuth support check
  const agentDef = getAgentDefinition(agent.id);
  const supportsOAuth = !!agentDef?.oauthSupport;

  // Find active credential
  const activeCredential = credentials?.find(c => c.isActive);
  const hasAnyCredential = (credentials?.length ?? 0) > 0;

  // OpenCode can use Scaleway cloud credential as fallback (only when using Scaleway provider)
  const isOpenCodePlatform = agent.id === 'opencode' && opencodeProvider === 'platform';
  const usesScalewayFallback = agent.fallbackCredentialSource === 'scaleway-cloud' && (!opencodeProvider || opencodeProvider === 'scaleway');

  // Get provider-specific key label for OpenCode
  const opencodeKeyLabel = agent.id === 'opencode' && opencodeProvider
    ? OPENCODE_PROVIDERS[opencodeProvider]?.keyLabel || 'API Key'
    : null;
  const opencodeKeyHelp = agent.id === 'opencode' && opencodeProvider
    ? OPENCODE_PROVIDERS[opencodeProvider]?.keyHelpText || ''
    : null;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      await onSave({
        agentType: agent.id,
        credentialKind,
        credential,
        autoActivate: true,
      });
      setCredential('');
      setShowForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save credential');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (kind: CredentialKind) => {
    const typeLabel = kind === 'oauth-token' ? 'OAuth token' : 'API key';
    if (!confirm(`Remove the ${agent.name} ${typeLabel}? You won't be able to use this agent until you add a new credential.`)) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      await onDelete(agent.id, kind);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to remove ${typeLabel}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="border border-border-default rounded-md p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-medium text-fg-primary">{agent.name}</h3>
          <p className="text-xs text-fg-muted">{agent.description}</p>
        </div>
        <StatusBadge
          status={hasAnyCredential || usesScalewayFallback || isOpenCodePlatform ? 'connected' : 'disconnected'}
          label={
            isOpenCodePlatform
              ? 'Platform AI'
              : hasAnyCredential
                ? activeCredential?.label || (activeCredential?.credentialKind === 'oauth-token' ? 'Connected (OAuth)' : 'Connected')
                : usesScalewayFallback
                  ? 'Using Scaleway Cloud Key'
                  : 'Not Configured'
          }
        />
      </div>

      {isOpenCodePlatform && !showForm && (
        <div className="flex items-center justify-between p-3 bg-inset rounded-sm">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-fg-muted">SAM Platform (Workers AI)</span>
            <span className="text-sm text-fg-primary">
              Using SAM&apos;s platform AI — daily limit applies. No API key needed.
            </span>
          </div>
        </div>
      )}

      {usesScalewayFallback && !hasAnyCredential && !showForm && !isOpenCodePlatform && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between p-3 bg-inset rounded-sm">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-fg-muted">Scaleway Cloud Provider Credential</span>
              <span className="text-sm text-fg-primary">
                Your Scaleway cloud credential is being used for inference. No separate key needed.
              </span>
            </div>
          </div>
          <p className="text-xs text-fg-muted">
            To use a different key for inference, you can save a dedicated credential below.{' '}
            <button
              type="button"
              onClick={() => setShowForm(true)}
              className="text-xs bg-transparent border-none cursor-pointer p-0 text-accent underline"
            >
              Add dedicated key
            </button>
          </p>
        </div>
      )}

      {activeCredential && !showForm && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between p-3 bg-inset rounded-sm">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-fg-muted">
                {activeCredential.credentialKind === 'oauth-token' ? 'OAuth Token' : 'API Key'}
                {activeCredential.label && ` (${activeCredential.label})`}
              </span>
              <span className="text-sm text-fg-muted font-mono">
                {activeCredential.maskedKey}
              </span>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setShowForm(true)} className="text-xs bg-transparent border-none cursor-pointer py-0.5 px-2 text-accent">
                Update
              </button>
              <button
                onClick={() => handleDelete(activeCredential.credentialKind)}
                disabled={loading}
                className={`text-xs bg-transparent border-none cursor-pointer py-0.5 px-2 text-danger ${loading ? 'opacity-50' : 'opacity-100'}`}
              >
                {loading ? 'Removing...' : 'Remove'}
              </button>
            </div>
          </div>
          {error && <Alert variant="error">{error}</Alert>}
        </div>
      )}

      {((!hasAnyCredential && !usesScalewayFallback && !isOpenCodePlatform) || showForm) && (
        <form onSubmit={handleSave} className="flex flex-col gap-3">
          {supportsOAuth && (
            <div className="flex gap-2 mb-2">
              <button
                type="button"
                onClick={() => { setCredentialKind('api-key'); setCredential(''); }}
                className={`py-2 px-3 border border-border-default rounded-sm text-sm cursor-pointer ${
                  credentialKind === 'api-key'
                    ? 'bg-accent text-white'
                    : 'bg-transparent text-fg-primary'
                }`}
              >
                API Key
              </button>
              <button
                type="button"
                onClick={() => { setCredentialKind('oauth-token'); setCredential(''); }}
                className={`py-2 px-3 border border-border-default rounded-sm text-sm cursor-pointer ${
                  credentialKind === 'oauth-token'
                    ? 'bg-accent text-white'
                    : 'bg-transparent text-fg-primary'
                }`}
              >
                {agent.id === 'openai-codex' ? 'ChatGPT Subscription' : 'OAuth Token (Pro/Max)'}
              </button>
            </div>
          )}

          <div>
            {credentialKind === 'oauth-token' && agent.id === 'openai-codex' ? (
              <textarea
                value={credential}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setCredential(e.target.value)}
                placeholder='Paste the full contents of ~/.codex/auth.json'
                required
                rows={6}
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                autoComplete="off"
                className="w-full px-3 py-2 bg-transparent border border-border-default rounded-sm text-sm text-fg-primary font-mono resize-y focus:outline-none focus:border-accent"
              />
            ) : (
              <Input
                type="password"
                value={credential}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCredential(e.target.value)}
                placeholder={
                  credentialKind === 'oauth-token'
                    ? 'Paste your OAuth token from "claude setup-token"'
                    : opencodeKeyLabel
                      ? `Enter your ${opencodeKeyLabel}`
                      : agent.id === 'opencode'
                        ? 'Enter your Scaleway Secret Key'
                        : `Enter your ${agent.name} API key`
                }
                required
              />
            )}
            <p className="mt-1 text-xs text-fg-muted">
              {credentialKind === 'oauth-token' && agentDef?.oauthSupport ? (
                <>
                  {agentDef.oauthSupport.setupInstructions}{' '}
                  <a href={agentDef.oauthSupport.subscriptionUrl} target="_blank" rel="noopener noreferrer" className="text-accent">
                    View subscription
                  </a>
                </>
              ) : agent.id === 'opencode' && opencodeKeyHelp ? (
                <>{opencodeKeyHelp}</>
              ) : agent.id === 'opencode' ? (
                <>
                  Create a Scaleway API key with <strong>GenerativeApisModelAccess</strong> permission at{' '}
                  <a href={agent.credentialHelpUrl} target="_blank" rel="noopener noreferrer" className="text-accent">
                    Scaleway IAM Console
                  </a>
                </>
              ) : (
                <>
                  Get your API key from{' '}
                  <a href={agent.credentialHelpUrl} target="_blank" rel="noopener noreferrer" className="text-accent">
                    {agent.name} Console
                  </a>
                </>
              )}
            </p>
          </div>

          {error && <Alert variant="error">{error}</Alert>}

          <div className="flex gap-2">
            <Button type="submit" disabled={loading || !credential} loading={loading} size="sm">
              {hasAnyCredential ? 'Update Credential' : 'Save Credential'}
            </Button>
            {showForm && (
              <Button type="button" variant="secondary" size="sm" onClick={() => { setShowForm(false); setError(null); setCredential(''); }}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
