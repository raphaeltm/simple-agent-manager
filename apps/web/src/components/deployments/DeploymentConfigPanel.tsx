import { Button, EmptyState, Input, Spinner } from '@simple-agent-manager/ui';
import { KeyRound } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { useToast } from '../../hooks/useToast';
import {
  deleteDeploymentSecret,
  type DeploymentSecretEntry,
  listDeploymentSecrets,
  setDeploymentSecret,
} from '../../lib/api';
import { ConfirmDialog } from '../ConfirmDialog';
import { formatDateTimeCompact } from './deployment-card-format';

// Compose env keys must be valid shell identifiers for ${VAR} interpolation.
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface DeploymentConfigPanelProps {
  projectId: string;
  environmentId: string;
}

export function DeploymentConfigPanel({ projectId, environmentId }: DeploymentConfigPanelProps) {
  const toast = useToast();
  const [secrets, setSecrets] = useState<DeploymentSecretEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [newName, setNewName] = useState('');
  const [newValue, setNewValue] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [deletingName, setDeletingName] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const loadSecrets = useCallback(async () => {
    setError(null);
    try {
      const resp = await listDeploymentSecrets(projectId, environmentId);
      setSecrets(resp.secrets ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load configuration');
    } finally {
      setLoading(false);
    }
  }, [projectId, environmentId]);

  useEffect(() => {
    void loadSecrets();
  }, [loadSecrets]);

  const isUpdate = secrets.some((s) => s.name === newName.trim());

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = newName.trim();
    if (!trimmedName || !newValue) return;
    if (!ENV_KEY_RE.test(trimmedName)) {
      setNameError('Use letters, numbers, and underscores. Must not start with a number.');
      return;
    }
    setNameError(null);
    setSaving(true);
    try {
      const result = await setDeploymentSecret(projectId, environmentId, trimmedName, newValue);
      toast.success(
        result.created ? `Secret "${trimmedName}" created` : `Secret "${trimmedName}" updated`
      );
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

  return (
    <div className="grid gap-4">
      <div>
        <h3 className="sam-type-card-title m-0 text-fg-primary">Secrets</h3>
        <p className="m-0 mt-1 text-xs text-fg-muted">
          Secrets are encrypted at rest and injected into your Compose services at deploy time.
          Values are never displayed — only names are shown.
        </p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2" role="status">
          <Spinner size="sm" />
          <span className="text-sm text-fg-muted">Loading configuration…</span>
        </div>
      ) : error ? (
        <div className="grid gap-2">
          <p className="m-0 text-sm text-danger">{error}</p>
          <div>
            <Button size="sm" variant="secondary" onClick={() => void loadSecrets()}>
              Retry
            </Button>
          </div>
        </div>
      ) : (
        <>
          {secrets.length > 0 ? (
            <div className="grid gap-1">
              {secrets.map((s) => (
                <div
                  key={s.name}
                  className="flex items-center justify-between gap-3 border border-border-default rounded-sm px-3 py-2 bg-inset min-w-0"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-mono text-fg-primary break-all">{s.name}</div>
                    <div className="text-xs text-fg-muted">
                      updated {formatDateTimeCompact(s.updatedAt)}
                    </div>
                  </div>
                  <Button variant="danger" size="sm" onClick={() => setDeletingName(s.name)}>
                    Delete
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<KeyRound size={44} />}
              heading="No secrets configured"
              description="Add a secret to inject it into this environment's Compose services."
            />
          )}

          <form onSubmit={(e) => void handleSave(e)} className="grid gap-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <label
                  htmlFor="config-secret-name"
                  className="block text-xs font-medium text-fg-muted mb-1"
                >
                  Name
                </label>
                <Input
                  id="config-secret-name"
                  placeholder="DATABASE_URL"
                  value={newName}
                  onChange={(e) => {
                    setNewName(e.target.value);
                    if (nameError) setNameError(null);
                  }}
                />
              </div>
              <div>
                <label
                  htmlFor="config-secret-value"
                  className="block text-xs font-medium text-fg-muted mb-1"
                >
                  Value
                </label>
                <Input
                  id="config-secret-value"
                  type="password"
                  placeholder="••••••••"
                  value={newValue}
                  onChange={(e) => setNewValue(e.target.value)}
                />
              </div>
            </div>
            {nameError && <p className="m-0 text-xs text-danger">{nameError}</p>}
            <div>
              <Button
                type="submit"
                size="sm"
                loading={saving}
                disabled={saving || !newName.trim() || !newValue}
              >
                {isUpdate ? 'Update Secret' : 'Add Secret'}
              </Button>
            </div>
          </form>
        </>
      )}

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
