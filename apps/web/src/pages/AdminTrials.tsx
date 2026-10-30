import { Body, Button, Card, Spinner } from '@simple-agent-manager/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Power, RefreshCw } from 'lucide-react';
import { useState } from 'react';

import { useQueryScope } from '../hooks/useQueryScope';
import {
  type AdminTrialsConfigResponse,
  fetchAdminTrialsConfig,
  updateAdminTrialsConfig,
} from '../lib/api';

function formatCacheTtl(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toLocaleString(undefined, { maximumFractionDigits: 1 })} sec`;
  const minutes = seconds / 60;
  return `${minutes.toLocaleString(undefined, { maximumFractionDigits: 1 })} min`;
}

function StatusBadge({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={
        enabled
          ? 'inline-flex items-center gap-1.5 rounded-full bg-success-tint px-2.5 py-1 text-xs font-semibold text-success-fg'
          : 'inline-flex items-center gap-1.5 rounded-full bg-warning-tint px-2.5 py-1 text-xs font-semibold text-warning-fg'
      }
    >
      {enabled ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
      {enabled ? 'Accepting trials' : 'Trials paused'}
    </span>
  );
}

export function AdminTrials() {
  const scope = useQueryScope();
  const client = useQueryClient();
  const queryKey = ['auth', scope, 'admin', 'AdminTrials', null] as const;
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => fetchAdminTrialsConfig(signal),
    enabled: Boolean(scope),
  });
  const config = query.data ?? null;
  const setConfig = (next: AdminTrialsConfigResponse) => client.setQueryData(queryKey, next);
  const loading = query.isPending;
  const [saving, setSaving] = useState(false);
  const [actionError, setError] = useState<string | null>(null);
  const error = actionError ?? query.error?.message;

  const loadConfig = async () => {
    setError(null);
    const result = await query.refetch();
    if (result.error) setError(result.error.message);
  };

  const handleToggleTrials = async () => {
    if (!config) return;

    setSaving(true);
    setError(null);
    try {
      await client.cancelQueries({ queryKey: queryKey, exact: true });
      const result = await updateAdminTrialsConfig(!config.enabled);
      setConfig(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update trial settings');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }

  if (!config) {
    return (
      <div role="alert" className="rounded-md bg-danger-tint p-3 text-sm text-danger-fg">
        {error || 'Failed to load trial settings'}
      </div>
    );
  }

  const nextAction = config.enabled ? 'Pause trials' : 'Resume trials';

  return (
    <div className="space-y-6">
      <Body>
        Control whether new anonymous trial workspaces can be created. Pausing trials stops new
        trial creation but does not delete existing projects, nodes, workspaces, or claimed
        accounts.
      </Body>

      {error && (
        <div role="alert" className="rounded-md bg-danger-tint p-3 text-sm text-danger-fg">
          {error}
        </div>
      )}

      <Card>
        <div className="space-y-5 p-4 sm:p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="m-0 text-base font-semibold text-fg-primary">Trial onboarding</h2>
                <StatusBadge enabled={config.enabled} />
              </div>
              <p className="m-0 max-w-2xl text-sm text-fg-muted">
                The public /try flow reads this switch before provisioning platform resources.
              </p>
            </div>

            <Button
              type="button"
              variant={config.enabled ? 'danger' : 'primary'}
              onClick={handleToggleTrials}
              loading={saving}
              aria-pressed={config.enabled}
              className="w-full sm:w-auto"
            >
              <Power size={16} />
              {nextAction}
            </Button>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-md border border-border-default bg-surface-secondary p-3">
              <div className="text-xs font-medium uppercase text-fg-muted">Current state</div>
              <div className="mt-1 text-sm font-semibold text-fg-primary">
                {config.enabled ? 'Enabled' : 'Disabled'}
              </div>
            </div>
            <div className="rounded-md border border-border-default bg-surface-secondary p-3">
              <div className="text-xs font-medium uppercase text-fg-muted">KV key</div>
              <code className="mt-1 block break-all text-sm text-fg-primary">{config.kvKey}</code>
            </div>
            <div className="rounded-md border border-border-default bg-surface-secondary p-3">
              <div className="text-xs font-medium uppercase text-fg-muted">Cache TTL</div>
              <div className="mt-1 text-sm font-semibold text-fg-primary">
                {formatCacheTtl(config.cacheTtlMs)}
              </div>
            </div>
          </div>
        </div>
      </Card>

      <div className="flex justify-end">
        <Button type="button" variant="secondary" onClick={loadConfig} disabled={saving}>
          <RefreshCw size={16} />
          Refresh
        </Button>
      </div>
    </div>
  );
}
