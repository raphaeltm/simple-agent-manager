import type { CredentialResponse } from '@simple-agent-manager/shared';
import { Alert, Button, Input } from '@simple-agent-manager/ui';
import { useState } from 'react';

import { useToast } from '../hooks/useToast';
import { createCredential, deleteCredential } from '../lib/api';

interface InfomaniakCredentialFormProps {
  readonly credential?: CredentialResponse | null;
  readonly onUpdate: () => void;
}

/**
 * Form for adding/updating/deleting Infomaniak credentials (secret key + application credential ID).
 */
export function InfomaniakCredentialForm({ credential, onUpdate }: InfomaniakCredentialFormProps) {
  const toast = useToast();
  const [applicationCredentialSecret, setApplicationCredentialSecret] = useState('');
  const [applicationCredentialId, setApplicationCredentialId] = useState('');
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
      const result = await createCredential({
        provider: 'infomaniak',
        applicationCredentialSecret,
        applicationCredentialId,
      });
      if (result.validation?.valid === false) {
        const message = `Saved, but ${result.validation.error ?? result.validation.message}`;
        setError(message);
        toast.warning('Infomaniak credentials saved with a validation warning');
        onUpdate();
        return;
      }
      setValidationMessage(result.validation?.message ?? 'Infomaniak credential validated.');
      toast.success('Infomaniak credentials saved');
      setApplicationCredentialSecret('');
      setApplicationCredentialId('');
      setShowForm(false);
      onUpdate();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save credentials');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Are you sure you want to disconnect your Infomaniak account?')) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      await deleteCredential('infomaniak');
      toast.success('Infomaniak account disconnected');
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
              type="button"
              onClick={() => setShowForm(true)}
              aria-label="Update Infomaniak credentials"
              className="py-1 px-3 text-sm bg-transparent border-none cursor-pointer text-accent"
            >
              Update
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={loading}
              aria-label="Disconnect Infomaniak account"
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
          htmlFor="infomaniak-secret-key"
          className="block text-sm font-medium text-fg-primary mb-1"
        >
          Application Credential Secret
        </label>
        <Input
          id="infomaniak-secret-key"
          type="password"
          value={applicationCredentialSecret}
          onChange={(e) => {
            setApplicationCredentialSecret(e.target.value);
            setValidationMessage(null);
            setError(null);
          }}
          placeholder="Enter your Infomaniak application credential secret"
          required
        />
      </div>

      <div>
        <label
          htmlFor="infomaniak-project-id"
          className="block text-sm font-medium text-fg-primary mb-1"
        >
          Application Credential ID
        </label>
        <Input
          id="infomaniak-project-id"
          type="text"
          value={applicationCredentialId}
          onChange={(e) => {
            setApplicationCredentialId(e.target.value);
            setValidationMessage(null);
            setError(null);
          }}
          placeholder="Enter your Infomaniak application credential ID"
          required
        />
        <p className="mt-1 text-xs text-fg-muted">
          Create an application credential in the{' '}
          <a
            href="https://docs.infomaniak.cloud/identity/applications_credentials/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent"
          >
            Infomaniak guide
          </a>{' '}
          <span>Assign both reader and member roles in dc4-a. The secret is shown only once.</span>
        </p>
      </div>

      {validationMessage && <Alert variant="success">{validationMessage}</Alert>}
      {error && <Alert variant="error">{error}</Alert>}

      <div className="flex gap-3">
        <Button
          type="submit"
          disabled={loading || !applicationCredentialSecret || !applicationCredentialId}
          loading={loading}
        >
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
