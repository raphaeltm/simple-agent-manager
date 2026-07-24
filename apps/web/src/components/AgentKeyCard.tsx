import type { AgentCredentialInfo, AgentInfo, AgentType, CredentialKind, OpenCodeProvider, SaveAgentCredentialRequest } from '@simple-agent-manager/shared';
import { getAgentDefinition, OPENCODE_PROVIDERS, resolveOpenCodeProvider } from '@simple-agent-manager/shared';
import { Alert, Button, Input, StatusBadge } from '@simple-agent-manager/ui';
import { useState } from 'react';

import { CodexConnectTrigger } from './CodexConnectTrigger';

interface AgentKeyCardProps {
  agent: AgentInfo;
  credentials?: AgentCredentialInfo[] | null; // Now an array for multiple credential types
  onSave: (request: SaveAgentCredentialRequest) => Promise<AgentCredentialInfo>;
  onDelete: (agentType: AgentType, credentialKind: CredentialKind) => Promise<void>;
  /** The currently selected OpenCode provider (from agent settings). Affects key labels. */
  opencodeProvider?: OpenCodeProvider | null;
  /**
   * Scope context for this card:
   *   - 'user' (default): user-level credential — removal disables the agent until a new key is added.
   *   - 'project': project-scoped override — removal falls back to the user-level credential.
   * Affects delete confirmation copy.
   */
  scope?: 'user' | 'project';
  /**
   * When true, render only the credential body (no outer border, no agent header or
   * status badge). Used when the card is embedded inside a larger unified AgentCard
   * that already shows the agent name/status in its own header.
   */
  embedded?: boolean;
  /**
   * Called after the guided "Connect with Codex" flow captures + saves a
   * credential, so the parent can refresh the credential list (same refresh it
   * performs after a manual save). No-op when the guided flow is unavailable.
   */
  onCredentialConnected?: () => void;
}

/**
 * Card for managing a single agent's credentials (API key and/or OAuth token).
 */
export function AgentKeyCard({ agent, credentials, onSave, onDelete, opencodeProvider, scope = 'user', embedded = false, onCredentialConnected }: AgentKeyCardProps) {
  const [credential, setCredential] = useState('');
  const [credentialKind, setCredentialKind] = useState<CredentialKind>('api-key');
  const [loading, setLoading] = useState(false);
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  // Get agent definition for OAuth support check
  const agentDef = getAgentDefinition(agent.id);
  const supportsOAuth = !!agentDef?.oauthSupport;

  // Find active credential
  const activeCredential = credentials?.find(c => c.isActive);
  const hasAnyCredential = (credentials?.length ?? 0) > 0;
  const effectiveOpenCodeProvider =
    agent.id === 'opencode' ? resolveOpenCodeProvider(opencodeProvider) : null;
  let saveCredentialLabel = 'Save Credential';
  if (hasAnyCredential) saveCredentialLabel = 'Update Credential';
  if (loading) saveCredentialLabel = 'Testing...';

  // Get provider-specific key label for OpenCode
  const opencodeKeyLabel = effectiveOpenCodeProvider
    ? OPENCODE_PROVIDERS[effectiveOpenCodeProvider]?.keyLabel || 'API Key'
    : null;
  const opencodeKeyHelp = effectiveOpenCodeProvider
    ? OPENCODE_PROVIDERS[effectiveOpenCodeProvider]?.keyHelpText || ''
    : null;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setValidationMessage(null);

    try {
      const result = await onSave({
        agentType: agent.id,
        credentialKind,
        credential,
        autoActivate: true,
      });
      if (result.validation?.valid === false) {
        setError(`Saved, but ${result.validation.error ?? result.validation.message}`);
        return;
      }
      setValidationMessage(result.validation?.message ?? 'Credential validated.');
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
    const consequence =
      scope === 'project'
        ? 'This project will fall back to your user-level credential.'
        : "You won't be able to use this agent until you add a new credential.";
    if (!confirm(`Remove the ${agent.name} ${typeLabel}? ${consequence}`)) {
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

  const body = (
    <>
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

      {(!hasAnyCredential || showForm) && (
        <form onSubmit={handleSave} className="flex flex-col gap-3">
          {supportsOAuth && (
            <div className="flex gap-2 mb-2">
              <button
                type="button"
                onClick={() => { setCredentialKind('api-key'); setCredential(''); setError(null); setValidationMessage(null); }}
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
                onClick={() => { setCredentialKind('oauth-token'); setCredential(''); setError(null); setValidationMessage(null); }}
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
              <div className="flex flex-col gap-3">
                {/* Guided flow (only rendered when the platform gate is enabled). */}
                <CodexConnectTrigger scope={scope} onConnected={onCredentialConnected} />
                <div className="text-xs font-medium text-fg-muted">
                  Or paste auth.json manually
                </div>
                <textarea
                  value={credential}
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => { setCredential(e.target.value); setError(null); setValidationMessage(null); }}
                  placeholder='Paste the full contents of ~/.codex/auth.json'
                  required
                  rows={6}
                  spellCheck={false}
                  autoCorrect="off"
                  autoCapitalize="off"
                  autoComplete="off"
                  className="w-full px-3 py-2 bg-transparent border border-border-default rounded-sm text-sm text-fg-primary font-mono resize-y focus:outline-none focus:border-accent"
                />
              </div>
            ) : (
              <Input
                type="password"
                value={credential}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => { setCredential(e.target.value); setError(null); setValidationMessage(null); }}
                placeholder={
                  credentialKind === 'oauth-token'
                    ? 'Paste your OAuth token from "claude setup-token"'
                    : opencodeKeyLabel
                      ? `Enter your ${opencodeKeyLabel}`
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

          {validationMessage && <Alert variant="success">{validationMessage}</Alert>}
          {error && <Alert variant="error">{error}</Alert>}

          <div className="flex gap-2">
            <Button type="submit" disabled={loading || !credential} loading={loading} size="sm">
              {saveCredentialLabel}
            </Button>
            {showForm && (
              <Button type="button" variant="secondary" size="sm" onClick={() => { setShowForm(false); setError(null); setValidationMessage(null); setCredential(''); }}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      )}
    </>
  );

  if (embedded) {
    return body;
  }

  return (
    <div className="border border-border-default rounded-md p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-medium text-fg-primary">{agent.name}</h3>
          <p className="text-xs text-fg-muted">{agent.description}</p>
        </div>
        <StatusBadge
          status={hasAnyCredential ? 'connected' : 'disconnected'}
          label={
            hasAnyCredential
              ? activeCredential?.label || (activeCredential?.credentialKind === 'oauth-token' ? 'Connected (OAuth)' : 'Connected')
              : 'Not Configured'
          }
        />
      </div>
      {body}
    </div>
  );
}
