import type { CredentialResponse } from '@simple-agent-manager/shared';
import { Alert, Button, Input } from '@simple-agent-manager/ui';
import type { ReactNode } from 'react';
import { useRef, useState } from 'react';

import { useToast } from '../hooks/useToast';
import { createCredential, deleteCredential, validateCredential } from '../lib/api';

/** Providers whose credential is a single raw API token (Hetzner, Vultr, DigitalOcean). */
export type SingleTokenProvider = 'hetzner' | 'vultr' | 'digitalocean';

interface SingleTokenCredentialFormProps {
  provider: SingleTokenProvider;
  credential?: CredentialResponse | null;
  onUpdate: () => void;
  /** Display name used in toasts/confirmations, e.g. "Hetzner" / "Vultr". */
  title: string;
  /** Credential noun used in save/disconnect copy, e.g. "token" / "API key". */
  noun: string;
  /** Input label, e.g. "Hetzner API Token" / "Vultr API Key". */
  tokenLabel: string;
  /** Input id/htmlFor, e.g. "hetzner-token" / "vultr-token". */
  tokenId: string;
  placeholder: string;
  /** Provider-specific help content rendered under the input. */
  help: ReactNode;
}

/**
 * Shared add/update/delete form for single-API-token cloud providers.
 * Hetzner, Vultr, and DigitalOcean are thin wrappers over this component (see
 * HetznerTokenForm, VultrCredentialForm, DigitalOceanCredentialForm) so the
 * validate/save/delete flow lives in exactly one place.
 */
export function SingleTokenCredentialForm({
  provider,
  credential,
  onUpdate,
  title,
  noun,
  tokenLabel,
  tokenId,
  placeholder,
  help,
}: SingleTokenCredentialFormProps) {
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
      const result = await validateCredential({ provider, token: requestToken });
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
      const result = await createCredential({ provider, token });
      if (result.validation?.valid === false) {
        const message = `Saved, but ${result.validation.error ?? result.validation.message}`;
        setError(message);
        toast.warning(`${title} ${noun} saved with a validation warning`);
        onUpdate();
        return;
      }
      setValidationMessage(result.validation?.message ?? `${title} credential validated.`);
      toast.success(`${title} ${noun} saved`);
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
    if (!confirm(`Are you sure you want to disconnect your ${title} account?`)) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      await deleteCredential(provider);
      toast.success(`${title} account disconnected`);
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
        <label htmlFor={tokenId} className="block text-sm font-medium text-fg-primary mb-1">
          {tokenLabel}
        </label>
        <Input
          id={tokenId}
          type="password"
          value={token}
          onChange={(e) => {
            setToken(e.target.value);
            setValidatedToken(null);
            setValidationMessage(null);
            setError(null);
          }}
          placeholder={placeholder}
          required
        />
        <p className="mt-1 text-xs text-fg-muted">{help}</p>
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
