import { Button, StatusBadge } from '@simple-agent-manager/ui';
import { EyeOff, KeyRound, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useToast } from '../../hooks/useToast';
import {
  deleteDeploymentEnvironmentConfigVar,
  type DeploymentEnvironmentConfigResponse,
  getDeploymentEnvironmentConfig,
  upsertDeploymentEnvironmentConfigVar,
} from '../../lib/api';
import { formatDateTimeCompact } from './deployment-card-format';

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface Props {
  projectId: string;
  environmentId: string;
  open: boolean;
}

export function DeploymentEnvironmentConfigPanel({ projectId, environmentId, open }: Props) {
  const toast = useToast();
  const [config, setConfig] = useState<DeploymentEnvironmentConfigResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [isSecret, setIsSecret] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setConfig(await getDeploymentEnvironmentConfig(projectId, environmentId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load configuration');
    } finally {
      setLoading(false);
    }
  }, [environmentId, projectId]);

  useEffect(() => {
    if (open) void loadConfig();
  }, [loadConfig, open]);

  const rows = useMemo(() => config?.envVars ?? [], [config?.envVars]);
  const duplicate = useMemo(
    () => rows.some((row) => row.key === key.trim()),
    [key, rows]
  );

  const save = async () => {
    const trimmedKey = key.trim();
    if (!trimmedKey || !ENV_KEY_RE.test(trimmedKey)) {
      setFormError('Key must match [A-Za-z_][A-Za-z0-9_]*');
      return;
    }
    if (isSecret && value.length === 0) {
      setFormError('Secret value cannot be empty.');
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const next = await upsertDeploymentEnvironmentConfigVar(projectId, environmentId, {
        key: trimmedKey,
        value,
        isSecret,
      });
      setConfig(next);
      setKey('');
      setValue('');
      setIsSecret(false);
      toast.success(duplicate ? 'Configuration updated' : 'Configuration added');
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save configuration');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (envKey: string, secret: boolean) => {
    if (secret && !window.confirm(`Delete secret ${envKey}?`)) return;
    setSaving(true);
    try {
      setConfig(await deleteDeploymentEnvironmentConfigVar(projectId, environmentId, envKey));
      toast.success(`Removed ${envKey}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete configuration');
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <section
      id={`deployment-config-${environmentId}`}
      className="rounded-md border border-border-default bg-inset px-3 py-3 grid gap-3"
    >
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 text-fg-primary font-semibold text-sm">
          <KeyRound size={15} />
          Configuration
        </div>
        {config && (
          <div className="text-xs text-fg-muted">
            Updated {formatDateTimeCompact(config.updatedAt)}
          </div>
        )}
      </div>

      {loading && <div className="text-xs text-fg-muted">Loading configuration...</div>}
      {error && <div className="text-xs text-danger break-words">{error}</div>}

      {!loading && !error && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto_auto] gap-2 items-end">
            <label className="grid gap-1 text-xs text-fg-muted min-w-0">
              Key
              <input
                value={key}
                onChange={(event) => setKey(event.currentTarget.value)}
                className="block w-full py-1.5 px-2.5 min-h-9 border border-border-default rounded-sm bg-surface text-fg-primary text-[0.8125rem] font-[inherit] box-border"
                placeholder="DATABASE_URL"
              />
            </label>
            <label className="grid gap-1 text-xs text-fg-muted min-w-0">
              Value
              <input
                value={value}
                onChange={(event) => setValue(event.currentTarget.value)}
                className="block w-full py-1.5 px-2.5 min-h-9 border border-border-default rounded-sm bg-surface text-fg-primary text-[0.8125rem] font-[inherit] box-border"
                placeholder={isSecret ? 'Hidden after save' : 'Value'}
                type={isSecret ? 'password' : 'text'}
              />
            </label>
            <label className="inline-flex items-center gap-2 min-h-9 text-xs text-fg-muted">
              <input
                type="checkbox"
                checked={isSecret}
                onChange={(event) => setIsSecret(event.currentTarget.checked)}
              />
              Secret
            </label>
            <Button size="sm" variant="secondary" onClick={() => void save()} loading={saving}>
              {duplicate ? 'Update' : 'Add'}
            </Button>
          </div>
          {formError && <div className="text-xs text-danger break-words">{formError}</div>}

          {rows.length === 0 ? (
            <div className="text-xs text-fg-muted py-1">No configuration set.</div>
          ) : (
            <div className="grid gap-1">
              {rows.map((row) => (
                <div
                  key={row.key}
                  className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 items-center rounded-sm border border-border-default bg-surface px-2 py-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-xs text-fg-primary break-all">{row.key}</span>
                      <StatusBadge
                        status={row.isSecret ? 'warning' : 'connected'}
                        label={row.isSecret ? 'Secret' : 'Variable'}
                      />
                    </div>
                    <div className="text-xs text-fg-muted min-w-0 break-words">
                      {row.isSecret ? (
                        <span className="inline-flex items-center gap-1">
                          <EyeOff size={12} />
                          Hidden after save
                        </span>
                      ) : (
                        row.value
                      )}
                      <span className="ml-2">Updated {formatDateTimeCompact(row.updatedAt)}</span>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void remove(row.key, row.isSecret)}
                    disabled={saving}
                    aria-label={`Delete ${row.key}`}
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
