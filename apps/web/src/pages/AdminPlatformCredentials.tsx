import type {
  CreatePlatformCredentialRequest,
  PlatformCredentialResponse,
  PlatformCredentialType,
} from '@simple-agent-manager/shared';
import { Body, Button, Card, Spinner } from '@simple-agent-manager/ui';
import { Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  createPlatformCredential,
  deletePlatformCredential,
  listPlatformCredentials,
  updatePlatformCredential,
} from '../lib/api';

const CREDENTIAL_TYPE_LABELS: Record<PlatformCredentialType, string> = {
  'cloud-provider': 'Cloud Provider',
  'agent-api-key': 'Agent API Key',
};

const PROVIDER_LABELS: Record<string, string> = {
  hetzner: 'Hetzner',
  scaleway: 'Scaleway',
  gcp: 'GCP',
};

const AGENT_TYPE_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code (Anthropic)',
  'openai-codex': 'OpenAI Codex',
};

export function AdminPlatformCredentials() {
  const [credentials, setCredentials] = useState<PlatformCredentialResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const hasLoadedRef = useRef(false);

  const fetchCredentials = useCallback(async () => {
    try {
      setError(null);
      const res = await listPlatformCredentials();
      setCredentials(res.credentials);
      hasLoadedRef.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load platform credentials');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCredentials();
  }, [fetchCredentials]);

  const handleToggle = async (id: string, currentEnabled: boolean) => {
    setActionLoading(id);
    try {
      await updatePlatformCredential(id, { isEnabled: !currentEnabled });
      await fetchCredentials();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update credential');
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (deleteConfirm !== id) {
      setDeleteConfirm(id);
      return;
    }
    setActionLoading(id);
    setDeleteConfirm(null);
    try {
      await deletePlatformCredential(id);
      await fetchCredentials();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete credential');
    } finally {
      setActionLoading(null);
    }
  };

  const handleCreated = async () => {
    setShowForm(false);
    await fetchCredentials();
  };

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Body>
          Platform credentials are shared fallback keys. When a user doesn&apos;t have their own
          credentials configured, these are used instead.
        </Body>
        <Button variant="primary" size="sm" onClick={() => setShowForm(!showForm)}>
          <Plus size={16} />
          Add Credential
        </Button>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-400">
          {error}
        </div>
      )}

      {showForm && <AddCredentialForm onCreated={handleCreated} onCancel={() => setShowForm(false)} />}

      {credentials.length === 0 ? (
        <Card>
          <div className="py-8 text-center">
            <Body className="text-[var(--sam-text-secondary)]">
              No platform credentials configured. Add one to enable fallback credentials for users.
            </Body>
          </div>
        </Card>
      ) : (
        <div className="space-y-2">
          {credentials.map((cred) => (
            <Card key={cred.id}>
              <div className="flex items-center justify-between gap-4 p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{cred.label}</span>
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-xs ${
                        cred.isEnabled
                          ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                          : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'
                      }`}
                    >
                      {cred.isEnabled ? 'Enabled' : 'Disabled'}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--sam-text-secondary)]">
                    <span>{CREDENTIAL_TYPE_LABELS[cred.credentialType]}</span>
                    {cred.provider && <span>{PROVIDER_LABELS[cred.provider] || cred.provider}</span>}
                    {cred.agentType && (
                      <span>{AGENT_TYPE_LABELS[cred.agentType] || cred.agentType}</span>
                    )}
                    <span>{cred.credentialKind}</span>
                    <span>Added {new Date(cred.createdAt).toLocaleDateString()}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleToggle(cred.id, cred.isEnabled)}
                    disabled={actionLoading === cred.id}
                  >
                    {cred.isEnabled ? 'Disable' : 'Enable'}
                  </Button>
                  <Button
                    variant={deleteConfirm === cred.id ? 'danger' : 'secondary'}
                    size="sm"
                    onClick={() => handleDelete(cred.id)}
                    disabled={actionLoading === cred.id}
                  >
                    {deleteConfirm === cred.id ? 'Confirm' : <Trash2 size={14} />}
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function AddCredentialForm({
  onCreated,
  onCancel,
}: {
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [credentialType, setCredentialType] = useState<PlatformCredentialType>('cloud-provider');
  const [provider, setProvider] = useState('hetzner');
  const [agentType, setAgentType] = useState('claude-code');
  const [label, setLabel] = useState('');
  const [credential, setCredential] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);

    const data: CreatePlatformCredentialRequest = {
      credentialType,
      label,
      credential,
    };
    if (credentialType === 'cloud-provider') {
      data.provider = provider as CreatePlatformCredentialRequest['provider'];
    } else {
      data.agentType = agentType;
    }

    try {
      await createPlatformCredential(data);
      onCreated();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to create credential');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <form onSubmit={handleSubmit} className="space-y-4 p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium">Type</label>
            <select
              value={credentialType}
              onChange={(e) => setCredentialType(e.target.value as PlatformCredentialType)}
              className="w-full rounded-md border border-[var(--sam-border)] bg-[var(--sam-bg-primary)] px-3 py-2 text-sm"
            >
              <option value="cloud-provider">Cloud Provider</option>
              <option value="agent-api-key">Agent API Key</option>
            </select>
          </div>

          {credentialType === 'cloud-provider' ? (
            <div>
              <label className="mb-1 block text-sm font-medium">Provider</label>
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                className="w-full rounded-md border border-[var(--sam-border)] bg-[var(--sam-bg-primary)] px-3 py-2 text-sm"
              >
                <option value="hetzner">Hetzner</option>
                <option value="scaleway">Scaleway</option>
                <option value="gcp">GCP</option>
              </select>
            </div>
          ) : (
            <div>
              <label className="mb-1 block text-sm font-medium">Agent Type</label>
              <select
                value={agentType}
                onChange={(e) => setAgentType(e.target.value)}
                className="w-full rounded-md border border-[var(--sam-border)] bg-[var(--sam-bg-primary)] px-3 py-2 text-sm"
              >
                <option value="claude-code">Claude Code (Anthropic)</option>
                <option value="openai-codex">OpenAI Codex</option>
              </select>
            </div>
          )}
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">Label</label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g., Team Hetzner, Shared Anthropic Key"
            className="w-full rounded-md border border-[var(--sam-border)] bg-[var(--sam-bg-primary)] px-3 py-2 text-sm"
            required
            maxLength={100}
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">
            {credentialType === 'cloud-provider' ? 'API Token' : 'API Key'}
          </label>
          <input
            type="password"
            value={credential}
            onChange={(e) => setCredential(e.target.value)}
            placeholder={
              credentialType === 'cloud-provider'
                ? 'Paste your provider API token...'
                : 'Paste your agent API key...'
            }
            className="w-full rounded-md border border-[var(--sam-border)] bg-[var(--sam-bg-primary)] px-3 py-2 text-sm font-mono"
            required
          />
        </div>

        {formError && (
          <div className="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-400">
            {formError}
          </div>
        )}

        <div className="flex gap-2">
          <Button type="submit" variant="primary" size="sm" disabled={submitting}>
            {submitting ? 'Creating...' : 'Create Credential'}
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
