import type { CredentialResponse } from '@simple-agent-manager/shared';
import { Alert,Button, Input } from '@simple-agent-manager/ui';
import { useState } from 'react';

import { useToast } from '../hooks/useToast';
import { createCredential, deleteCredential } from '../lib/api';

interface HetznerTokenFormProps {
  credential?: CredentialResponse | null;
  onUpdate: () => void;
}

/**
 * Form for adding/updating/deleting Hetzner API token.
 */
export function HetznerTokenForm({ credential, onUpdate }: HetznerTokenFormProps) {
  const toast = useToast();
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
      toast.success('Hetzner token saved');
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
      toast.success('Hetzner account disconnected');
      onUpdate();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete token');
    } finally {
      setLoading(false);
    }
  };

  if (credential && !showForm) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between p-4 bg-success-tint border border-success/30 rounded-md">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 bg-success-tint rounded-full flex items-center justify-center">
              <svg className="h-5 w-5 text-success-fg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div>
              <p className="font-medium text-success-fg">Connected</p>
              <p className="text-sm text-fg-muted">
                Added: {new Date(credential.createdAt).toLocaleDateString()}
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setShowForm(true)} className="py-1 px-3 text-sm bg-transparent border-none cursor-pointer text-accent">
              Update
            </button>
            <button
              onClick={handleDelete}
              disabled={loading}
              className={`py-1 px-3 text-sm bg-transparent border-none cursor-pointer text-danger ${loading ? 'opacity-50' : 'opacity-100'}`}
            >
              {loading ? 'Removing...' : 'Disconnect'}
            </button>
          </div>
        </div>
        {error && <Alert variant="error">{error}</Alert>}
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div>
        <label htmlFor="hetzner-token" className="block text-sm font-medium text-fg-primary mb-1">
          Hetzner API Token
        </label>
        <Input
          id="hetzner-token"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Enter your Hetzner Cloud API token"
          required
        />
        <p className="mt-1 text-xs text-fg-muted">
          Get your API token from{' '}
          <a
            href="https://console.hetzner.cloud/projects"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent"
          >
            Hetzner Cloud Console
          </a>
          {' '}&gt; Your Project &gt; Security &gt; API Tokens
        </p>
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      <div className="flex gap-3">
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
