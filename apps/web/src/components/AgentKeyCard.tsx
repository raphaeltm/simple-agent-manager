import { useState } from 'react';
import { Button, Input, Alert, StatusBadge } from '@simple-agent-manager/ui';
import type { AgentInfo, AgentCredentialInfo, AgentType } from '@simple-agent-manager/shared';

interface AgentKeyCardProps {
  agent: AgentInfo;
  credential?: AgentCredentialInfo | null;
  onSave: (agentType: AgentType, apiKey: string) => Promise<void>;
  onDelete: (agentType: AgentType) => Promise<void>;
}

/**
 * Card for managing a single agent's API key.
 */
export function AgentKeyCard({ agent, credential, onSave, onDelete }: AgentKeyCardProps) {
  const [apiKey, setApiKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      await onSave(agent.id, apiKey);
      setApiKey('');
      setShowForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save API key');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Remove the ${agent.name} API key? You won't be able to use this agent until you add a new key.`)) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      await onDelete(agent.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove API key');
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
        <StatusBadge status={credential ? 'connected' : 'disconnected'} label={credential ? 'Connected' : 'Not Configured'} />
      </div>

      {credential && !showForm && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sam-space-3)' }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: 'var(--sam-space-3)',
            backgroundColor: 'var(--sam-color-bg-inset)',
            borderRadius: 'var(--sam-radius-sm)',
          }}>
            <span style={{ fontSize: '0.875rem', color: 'var(--sam-color-fg-muted)', fontFamily: 'monospace' }}>{credential.maskedKey}</span>
            <div style={{ display: 'flex', gap: 'var(--sam-space-2)' }}>
              <button onClick={() => setShowForm(true)} style={{ ...actionBtnStyle, color: 'var(--sam-color-accent-primary)' }}>
                Update
              </button>
              <button onClick={handleDelete} disabled={loading} style={{ ...actionBtnStyle, color: 'var(--sam-color-danger)', opacity: loading ? 0.5 : 1 }}>
                {loading ? 'Removing...' : 'Remove'}
              </button>
            </div>
          </div>
          {error && <Alert variant="error">{error}</Alert>}
        </div>
      )}

      {(!credential || showForm) && (
        <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sam-space-3)' }}>
          <div>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={`Enter your ${agent.name} API key`}
              required
            />
            <p style={{ marginTop: 'var(--sam-space-1)', fontSize: '0.75rem', color: 'var(--sam-color-fg-muted)' }}>
              Get your API key from{' '}
              <a href={agent.credentialHelpUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--sam-color-accent-primary)' }}>
                {agent.name} Console
              </a>
            </p>
          </div>

          {error && <Alert variant="error">{error}</Alert>}

          <div style={{ display: 'flex', gap: 'var(--sam-space-2)' }}>
            <Button type="submit" disabled={loading || !apiKey} loading={loading} size="sm">
              {credential ? 'Update Key' : 'Save Key'}
            </Button>
            {showForm && (
              <Button type="button" variant="secondary" size="sm" onClick={() => { setShowForm(false); setError(null); setApiKey(''); }}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
