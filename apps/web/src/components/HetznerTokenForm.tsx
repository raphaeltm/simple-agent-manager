import { useState } from 'react';
import { createCredential, deleteCredential } from '../lib/api';
import { Button, Input, Alert } from '@simple-agent-manager/ui';
import type { CredentialResponse } from '@simple-agent-manager/shared';

interface HetznerTokenFormProps {
  credential?: CredentialResponse | null;
  onUpdate: () => void;
}

/**
 * Form for adding/updating/deleting Hetzner API token.
 */
export function HetznerTokenForm({ credential, onUpdate }: HetznerTokenFormProps) {
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      await createCredential({ provider: 'hetzner', token });
      setToken('');
      setShowForm(false);
      onUpdate();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save token');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Are you sure you want to disconnect your Hetzner account?')) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      await deleteCredential('hetzner');
      onUpdate();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete token');
    } finally {
      setLoading(false);
    }
  };

  const actionBtnStyle: React.CSSProperties = {
    padding: '4px 12px',
    fontSize: '0.875rem',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
  };

  if (credential && !showForm) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sam-space-4)' }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: 'var(--sam-space-4)',
          backgroundColor: 'rgba(34, 197, 94, 0.1)',
          border: '1px solid rgba(34, 197, 94, 0.3)',
          borderRadius: 'var(--sam-radius-md)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-3)' }}>
            <div style={{
              height: 40, width: 40,
              backgroundColor: 'rgba(34, 197, 94, 0.15)',
              borderRadius: '50%',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <svg style={{ height: 20, width: 20, color: '#4ade80' }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div>
              <p style={{ fontWeight: 500, color: '#4ade80' }}>Connected</p>
              <p style={{ fontSize: '0.875rem', color: 'var(--sam-color-fg-muted)' }}>
                Added: {new Date(credential.createdAt).toLocaleDateString()}
              </p>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 'var(--sam-space-2)' }}>
            <button onClick={() => setShowForm(true)} style={{ ...actionBtnStyle, color: 'var(--sam-color-accent-primary)' }}>
              Update
            </button>
            <button onClick={handleDelete} disabled={loading} style={{ ...actionBtnStyle, color: 'var(--sam-color-danger)', opacity: loading ? 0.5 : 1 }}>
              {loading ? 'Removing...' : 'Disconnect'}
            </button>
          </div>
        </div>
        {error && <Alert variant="error">{error}</Alert>}
      </div>
    );
  }

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: '0.875rem',
    fontWeight: 500,
    color: 'var(--sam-color-fg-primary)',
    marginBottom: 'var(--sam-space-1)',
  };

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sam-space-4)' }}>
      <div>
        <label htmlFor="hetzner-token" style={labelStyle}>Hetzner API Token</label>
        <Input
          id="hetzner-token"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Enter your Hetzner Cloud API token"
          required
        />
        <p style={{ marginTop: 'var(--sam-space-1)', fontSize: '0.75rem', color: 'var(--sam-color-fg-muted)' }}>
          Get your API token from{' '}
          <a
            href="https://console.hetzner.cloud/projects"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'var(--sam-color-accent-primary)' }}
          >
            Hetzner Cloud Console
          </a>
          {' '}&gt; Your Project &gt; Security &gt; API Tokens
        </p>
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      <div style={{ display: 'flex', gap: 'var(--sam-space-3)' }}>
        <Button type="submit" disabled={loading || !token} loading={loading}>
          {credential ? 'Update Token' : 'Connect'}
        </Button>
        {showForm && (
          <Button type="button" variant="secondary" onClick={() => setShowForm(false)}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
