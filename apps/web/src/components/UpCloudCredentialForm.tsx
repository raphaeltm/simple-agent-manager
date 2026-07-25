import type { CredentialResponse } from '@simple-agent-manager/shared';
import { Alert, Button, Input } from '@simple-agent-manager/ui';
import { useState } from 'react';

import { useToast } from '../hooks/useToast';
import { createCredential, deleteCredential } from '../lib/api';

interface UpCloudCredentialFormProps {
  credential?: CredentialResponse | null;
  onUpdate: () => void;
}

/**
 * Form for adding/updating/deleting UpCloud credentials (username + password).
 */
export function UpCloudCredentialForm({ credential, onUpdate }: UpCloudCredentialFormProps) {
  const toast = useToast();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  let submitLabel = 'Connect';
  if (credential) submitLabel = 'Update Credentials';
  if (loading) submitLabel = 'Testing...';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setValidationMessage(null);

    try {
      const result = await createCredential({ provider: 'upcloud', username, password });
      if (result.validation?.valid === false) {
        const message = `Saved, but ${result.validation.error ?? result.validation.message}`;
        setError(message);
        toast.warning('UpCloud credentials saved with a validation warning');
        onUpdate();
        return;
      }
      setValidationMessage(result.validation?.message ?? 'UpCloud credential validated.');
      toast.success('UpCloud credentials saved');
      setUsername('');
      setPassword('');
      setShowForm(false);
      onUpdate();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save credentials');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Are you sure you want to disconnect your UpCloud account?')) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      await deleteCredential('upcloud');
      toast.success('UpCloud account disconnected');
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
              <svg
                className="h-5 w-5 text-success-fg"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
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
            <button
              onClick={() => setShowForm(true)}
              aria-label="Update UpCloud credentials"
              className="py-1 px-3 text-sm bg-transparent border-none cursor-pointer text-accent"
            >
              Update
            </button>
            <button
              onClick={handleDelete}
              disabled={loading}
              aria-label="Disconnect UpCloud account"
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
        <label
          htmlFor="upcloud-username"
          className="block text-sm font-medium text-fg-primary mb-1"
        >
          API Username
        </label>
        <Input
          id="upcloud-username"
          type="text"
          value={username}
          onChange={(e) => {
            setUsername(e.target.value);
            setValidationMessage(null);
            setError(null);
          }}
          placeholder="Enter your UpCloud API username"
          required
        />
      </div>

      <div>
        <label
          htmlFor="upcloud-password"
          className="block text-sm font-medium text-fg-primary mb-1"
        >
          Password
        </label>
        <Input
          id="upcloud-password"
          type="password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setValidationMessage(null);
            setError(null);
          }}
          placeholder="Enter your UpCloud password"
          required
        />
        <p className="mt-1 text-xs text-fg-muted">
          Find your credentials in the{' '}
          <a
            href="https://hub.upcloud.com/people/accounts"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent"
          >
            UpCloud Hub
          </a>
          &gt; People &gt; Accounts
        </p>
      </div>

      {validationMessage && <Alert variant="success">{validationMessage}</Alert>}
      {error && <Alert variant="error">{error}</Alert>}

      <div className="flex gap-3">
        <Button type="submit" disabled={loading || !username || !password} loading={loading}>
          {submitLabel}
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
