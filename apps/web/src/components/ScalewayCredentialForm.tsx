import { useState } from 'react';
import { createCredential, deleteCredential } from '../lib/api';
import { useToast } from '../hooks/useToast';
import { Button, Input, Alert } from '@simple-agent-manager/ui';
import type { CredentialResponse } from '@simple-agent-manager/shared';

interface ScalewayCredentialFormProps {
  credential?: CredentialResponse | null;
  onUpdate: () => void;
}

/**
 * Form for adding/updating/deleting Scaleway credentials (secret key + project ID).
 */
export function ScalewayCredentialForm({ credential, onUpdate }: ScalewayCredentialFormProps) {
  const toast = useToast();
  const [secretKey, setSecretKey] = useState('');
  const [projectId, setProjectId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      await createCredential({ provider: 'scaleway', secretKey, projectId });
      toast.success('Scaleway credentials saved');
      setSecretKey('');
      setProjectId('');
      setShowForm(false);
      onUpdate();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save credentials');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Are you sure you want to disconnect your Scaleway account?')) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      await deleteCredential('scaleway');
      toast.success('Scaleway account disconnected');
      onUpdate();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete credentials');
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
        <label htmlFor="scaleway-secret-key" className="block text-sm font-medium text-fg-primary mb-1">
          API Secret Key
        </label>
        <Input
          id="scaleway-secret-key"
          type="password"
          value={secretKey}
          onChange={(e) => setSecretKey(e.target.value)}
          placeholder="Enter your Scaleway API secret key"
          required
        />
      </div>

      <div>
        <label htmlFor="scaleway-project-id" className="block text-sm font-medium text-fg-primary mb-1">
          Project ID
        </label>
        <Input
          id="scaleway-project-id"
          type="text"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          placeholder="Enter your Scaleway project ID"
          required
        />
      </div>

      <p className="text-xs text-fg-muted">
        Find your credentials in the{' '}
        <a
          href="https://console.scaleway.com/project/credentials"
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent"
        >
          Scaleway Console
        </a>
        {' '}&gt; Project &gt; Credentials
      </p>

      {error && <Alert variant="error">{error}</Alert>}

      <div className="flex gap-3">
        <Button type="submit" disabled={loading || !secretKey || !projectId} loading={loading}>
          {credential ? 'Update Credentials' : 'Connect'}
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
