import { Button, Input, Spinner } from '@simple-agent-manager/ui';
import { useCallback, useEffect, useState } from 'react';

import { useToast } from '../hooks/useToast';
import {
  deleteDeploymentSecret,
  type DeploymentSecretEntry,
  listDeploymentSecrets,
  setDeploymentSecret,
} from '../lib/api';
import { ConfirmDialog } from './ConfirmDialog';

interface EnvironmentSecretsSectionProps {
  projectId: string;
  environmentId: string;
}

export function EnvironmentSecretsSection({
  projectId,
  environmentId,
}: EnvironmentSecretsSectionProps) {
  const toast = useToast();
  const [secrets, setSecrets] = useState<DeploymentSecretEntry[]>([]);
  const [loading, setLoading] = useState(true);

  // Add/overwrite form
  const [newName, setNewName] = useState('');
  const [newValue, setNewValue] = useState('');
  const [saving, setSaving] = useState(false);

  // Delete confirmation
  const [deletingName, setDeletingName] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const [loadError, setLoadError] = useState<string | null>(null);

  const loadSecrets = useCallback(async () => {
    try {
      setLoadError(null);
      const resp = await listDeploymentSecrets(projectId, environmentId);
      setSecrets(resp.secrets);
    } catch {
      setLoadError('Failed to load secrets');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- toast removed per stale-while-revalidate rule
  }, [projectId, environmentId]);

  useEffect(() => {
    loadSecrets().catch(() => {
      // Error already handled in loadSecrets via toast
    });
  }, [loadSecrets]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = newName.trim();
    if (!trimmedName || !newValue) return;

    setSaving(true);
    try {
      const result = await setDeploymentSecret(projectId, environmentId, trimmedName, newValue);
      toast.success(result.created ? `Secret "${trimmedName}" created` : `Secret "${trimmedName}" updated`);
      setNewName('');
      setNewValue('');
      await loadSecrets();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save secret');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deletingName) return;
    setDeleteLoading(true);
    try {
      await deleteDeploymentSecret(projectId, environmentId, deletingName);
      toast.success(`Secret "${deletingName}" deleted`);
      setDeletingName(null);
      await loadSecrets();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete secret');
    } finally {
      setDeleteLoading(false);
    }
  };

  if (loading && secrets.length === 0 && !loadError) {
    return (
      <div className="flex items-center gap-2" role="status">
        <Spinner size="sm" />
        <span className="text-sm text-fg-muted">Loading secrets...</span>
      </div>
    );
  }

  if (loadError && secrets.length === 0) {
    return (
      <div className="grid gap-3">
        <div className="text-xs text-danger">{loadError}</div>
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      <div>
        <h3 className="sam-type-card-title m-0 text-fg-primary">Environment Secrets</h3>
        <p className="m-0 mt-1 text-xs text-fg-muted">
          Secrets are encrypted at rest. Values are never displayed — only names are shown.
        </p>
      </div>

      {/* Existing secrets list */}
      {secrets.length > 0 ? (
        <div className="grid gap-1">
          {secrets.map((s) => (
            <div
              key={s.name}
              className="flex items-center justify-between border border-border-default rounded-sm px-3 py-2 bg-inset"
            >
              <div className="min-w-0">
                <span className="text-sm font-mono text-fg-primary break-all">{s.name}</span>
                <span className="text-xs text-fg-muted ml-2">
                  updated {new Date(s.updatedAt).toLocaleDateString()}
                </span>
              </div>
              <Button
                variant="danger"
                size="sm"
                onClick={() => setDeletingName(s.name)}
              >
                Delete
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-fg-muted m-0">No secrets configured for this environment.</p>
      )}

      {/* Add/overwrite form */}
      <form onSubmit={(e) => void handleSave(e)} className="grid gap-2">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div>
            <label htmlFor="secret-name" className="block text-xs font-medium text-fg-muted mb-1">
              Name
            </label>
            <Input
              id="secret-name"
              placeholder="MY_SECRET"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              pattern="^[a-zA-Z0-9_-]{1,128}$"
              title="Alphanumeric, hyphens, underscores, 1-128 chars"
            />
          </div>
          <div>
            <label htmlFor="secret-value" className="block text-xs font-medium text-fg-muted mb-1">
              Value
            </label>
            <Input
              id="secret-value"
              type="password"
              placeholder="••••••••"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
            />
          </div>
        </div>
        <div>
          <Button
            type="submit"
            size="sm"
            loading={saving}
            disabled={saving || !newName.trim() || !newValue}
          >
            {secrets.some((s) => s.name === newName.trim()) ? 'Update Secret' : 'Add Secret'}
          </Button>
        </div>
      </form>

      {/* Delete confirmation */}
      <ConfirmDialog
        isOpen={deletingName !== null}
        onClose={() => setDeletingName(null)}
        onConfirm={() => void handleDelete()}
        title={`Delete secret "${deletingName}"?`}
        message="This secret will be permanently removed. Any releases referencing it will fail to render until a new value is set."
        confirmLabel="Delete Secret"
        variant="danger"
        loading={deleteLoading}
      />
    </div>
  );
}
