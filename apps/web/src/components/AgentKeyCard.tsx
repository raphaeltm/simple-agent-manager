import { useState } from 'react';
import { Button, Input, Alert, StatusBadge } from '@simple-agent-manager/ui';
import type { AgentInfo, AgentCredentialInfo, AgentType, CredentialKind, SaveAgentCredentialRequest } from '@simple-agent-manager/shared';
import { getAgentDefinition } from '@simple-agent-manager/shared';

interface AgentKeyCardProps {
  agent: AgentInfo;
  credentials?: AgentCredentialInfo[] | null; // Now an array for multiple credential types
  onSave: (request: SaveAgentCredentialRequest) => Promise<void>;
  onDelete: (agentType: AgentType, credentialKind: CredentialKind) => Promise<void>;
}

/**
 * Card for managing a single agent's credentials (API key and/or OAuth token).
 */
export function AgentKeyCard({ agent, credentials, onSave, onDelete }: AgentKeyCardProps) {
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

  const actionBtnStyle: React.CSSProperties = {
    fontSize: '0.75rem',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: '2px 8px',
  };

  return (
    <div style={{
      border: '1px solid var(--sam-color-border-default)',
      borderRadius: 'var(--sam-radius-md)',
      padding: 'var(--sam-space-4)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--sam-space-3)' }}>
        <div>
          <h3 style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--sam-color-fg-primary)' }}>{agent.name}</h3>
          <p style={{ fontSize: '0.75rem', color: 'var(--sam-color-fg-muted)' }}>{agent.description}</p>
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

      {activeCredential && !showForm && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sam-space-3)' }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: 'var(--sam-space-3)',
            backgroundColor: 'var(--sam-color-bg-inset)',
            borderRadius: 'var(--sam-radius-sm)',
          }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sam-space-1)' }}>
              <span style={{ fontSize: '0.75rem', color: 'var(--sam-color-fg-muted)' }}>
                {activeCredential.credentialKind === 'oauth-token' ? 'OAuth Token' : 'API Key'}
                {activeCredential.label && ` (${activeCredential.label})`}
              </span>
              <span style={{ fontSize: '0.875rem', color: 'var(--sam-color-fg-muted)', fontFamily: 'monospace' }}>
                {activeCredential.maskedKey}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 'var(--sam-space-2)' }}>
              <button onClick={() => setShowForm(true)} style={{ ...actionBtnStyle, color: 'var(--sam-color-accent-primary)' }}>
                Update
              </button>
              <button onClick={() => handleDelete(activeCredential.credentialKind)} disabled={loading} style={{ ...actionBtnStyle, color: 'var(--sam-color-danger)', opacity: loading ? 0.5 : 1 }}>
                {loading ? 'Removing...' : 'Remove'}
              </button>
            </div>
          </div>
          {error && <Alert variant="error">{error}</Alert>}
        </div>
      )}

      {(!hasAnyCredential || showForm) && (
        <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sam-space-3)' }}>
          {supportsOAuth && agent.id === 'claude-code' && (
            <div style={{ display: 'flex', gap: 'var(--sam-space-2)', marginBottom: 'var(--sam-space-2)' }}>
              <button
                type="button"
                onClick={() => setCredentialKind('api-key')}
                style={{
                  padding: '8px 12px',
                  border: '1px solid var(--sam-color-border-default)',
                  borderRadius: 'var(--sam-radius-sm)',
                  backgroundColor: credentialKind === 'api-key' ? 'var(--sam-color-accent-primary)' : 'transparent',
                  color: credentialKind === 'api-key' ? 'white' : 'var(--sam-color-fg-primary)',
                  cursor: 'pointer',
                  fontSize: '0.875rem',
                }}
              >
                API Key
              </button>
              <button
                type="button"
                onClick={() => setCredentialKind('oauth-token')}
                style={{
                  padding: '8px 12px',
                  border: '1px solid var(--sam-color-border-default)',
                  borderRadius: 'var(--sam-radius-sm)',
                  backgroundColor: credentialKind === 'oauth-token' ? 'var(--sam-color-accent-primary)' : 'transparent',
                  color: credentialKind === 'oauth-token' ? 'white' : 'var(--sam-color-fg-primary)',
                  cursor: 'pointer',
                  fontSize: '0.875rem',
                }}
              >
                OAuth Token (Pro/Max)
              </button>
            </div>
          )}

          <div>
            <Input
              type="password"
              value={credential}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCredential(e.target.value)}
              placeholder={
                credentialKind === 'oauth-token'
                  ? 'Paste your OAuth token from "claude setup-token"'
                  : `Enter your ${agent.name} API key`
              }
              required
            />
            <p style={{ marginTop: 'var(--sam-space-1)', fontSize: '0.75rem', color: 'var(--sam-color-fg-muted)' }}>
              {credentialKind === 'oauth-token' && agentDef?.oauthSupport ? (
                <>
                  {agentDef.oauthSupport.setupInstructions}{' '}
                  <a href={agentDef.oauthSupport.subscriptionUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--sam-color-accent-primary)' }}>
                    View subscription
                  </a>
                </>
              ) : (
                <>
                  Get your API key from{' '}
                  <a href={agent.credentialHelpUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--sam-color-accent-primary)' }}>
                    {agent.name} Console
                  </a>
                </>
              )}
            </p>
          </div>

          {error && <Alert variant="error">{error}</Alert>}

          <div style={{ display: 'flex', gap: 'var(--sam-space-2)' }}>
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
