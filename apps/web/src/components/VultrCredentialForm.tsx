import type { CredentialResponse } from '@simple-agent-manager/shared';
import { Alert,Button, Input } from '@simple-agent-manager/ui';
import { useRef,useState } from 'react';

import { useToast } from '../hooks/useToast';
import { createCredential, deleteCredential, validateCredential } from '../lib/api';

interface VultrCredentialFormProps {
  credential?: CredentialResponse | null;
  onUpdate: () => void;
}

/**
 * Form for adding/updating/deleting a Vultr API key (single-token, like Hetzner).
 */
export function VultrCredentialForm({ credential, onUpdate }: VultrCredentialFormProps) {
  const toast = useToast();
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validatedToken, setValidatedToken] = useState<string | null>(null);
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const trimmedToken = token.trim();
  const latestToken = useRef(trimmedToken);
  latestToken.current = trimmedToken;
  const isValidated = validatedToken === trimmedToken;
  let submitLabel = 'Connect';
  if (credential) submitLabel = 'Update Token';
  if (loading) submitLabel = 'Testing...';

  const handleValidate = async () => {
    if (!trimmedToken) return;
    setValidating(true);
    setValidationMessage(null);
    setError(null);
    const requestToken = trimmedToken;
    try {
      const result = await validateCredential({ provider: 'vultr', token: requestToken });
      if (latestToken.current !== requestToken) return;
      setValidatedToken(requestToken);
      setValidationMessage(result.message);
    } catch (err) {
      if (latestToken.current !== requestToken) return;
      setValidatedToken(null);
      setError(err instanceof Error ? err.message : 'Failed to validate token');
    } finally {
      setValidating(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const result = await createCredential({ provider: 'vultr', token });
      if (result.validation?.valid === false) {
        const message = `Saved, but ${result.validation.error ?? result.validation.message}`;
        setError(message);
        toast.warning('Vultr API key saved with a validation warning');
        onUpdate();
        return;
      }
      setValidationMessage(result.validation?.message ?? 'Vultr credential validated.');
      toast.success('Vultr API key saved');
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
    if (!confirm('Are you sure you want to disconnect your Vultr account?')) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      await deleteCredential('vultr');
      toast.success('Vultr account disconnected');
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
        <label htmlFor="vultr-token" className="block text-sm font-medium text-fg-primary mb-1">
          Vultr API Key
        </label>
        <Input
          id="vultr-token"
          type="password"
          value={token}
          onChange={(e) => {
            setToken(e.target.value);
            setValidatedToken(null);
            setValidationMessage(null);
            setError(null);
          }}
          placeholder="Enter your Vultr Personal Access Token"
          required
        />
        <p className="mt-1 text-xs text-fg-muted">
          Get your API key from{' '}
          <a
            href="https://my.vultr.com/settings/#settingsapi"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent"
          >
            Vultr Account &gt; API
          </a>
          . Set Access Control to <strong>Allow All IPv4/IPv6</strong> — SAM calls Vultr from
          Cloudflare with no fixed IP, so a restricted allowlist will block provisioning.
        </p>
      </div>

      {validationMessage && <Alert variant="success">{validationMessage}</Alert>}
      {error && <Alert variant="error">{error}</Alert>}

      <div className="grid grid-cols-1 gap-2 sm:flex sm:gap-3">
        <Button type="button" variant="secondary" disabled={validating || loading || !token.trim()} loading={validating} onClick={handleValidate}>
          {isValidated ? 'Tested' : 'Test connection'}
        </Button>
        <Button type="submit" disabled={loading || validating || !token.trim()} loading={loading}>
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
