import { Alert, Button, EmptyState, Input, SkeletonCard } from '@simple-agent-manager/ui';
import { Plus, RefreshCw, Rocket } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';

import { ConfirmDialog } from '../components/ConfirmDialog';
import {
  DeploymentEnvironmentCard,
  type DeploymentLogState,
} from '../components/deployments/DeploymentEnvironmentCard';
import { useAgentProfiles } from '../hooks/useAgentProfiles';
import { useToast } from '../hooks/useToast';
import {
  createDeploymentEnvironment,
  deleteDeploymentEnvironment,
  getDeploymentEnvironmentLogs,
  listDeploymentEnvironments,
  type DeploymentEnvironment,
  updateDeploymentEnvironmentPolicy,
} from '../lib/api';
import { useProjectContext } from './ProjectContext';

export function ProjectDeployments() {
  const { projectId } = useProjectContext();
  const toast = useToast();
  const { profiles, loading: profilesLoading } = useAgentProfiles(projectId);

  const [environments, setEnvironments] = useState<DeploymentEnvironment[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [policySaving, setPolicySaving] = useState<string | null>(null);
  const [logsOpenEnvId, setLogsOpenEnvId] = useState<string | null>(null);
  const [logsByEnv, setLogsByEnv] = useState<Record<string, DeploymentLogState>>({});
  const [deleteTarget, setDeleteTarget] = useState<DeploymentEnvironment | null>(null);
  const [deleting, setDeleting] = useState(false);

  const sortedEnvironments = useMemo(
    () => [...environments].sort((a, b) => a.name.localeCompare(b.name)),
    [environments],
  );

  const loadEnvironments = useCallback(async (isRefresh = false) => {
    if (isRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    try {
      setError(null);
      const result = await listDeploymentEnvironments(projectId);
      setEnvironments(result.environments);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load deployment environments');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadEnvironments();
  }, [loadEnvironments]);

  const replaceEnvironment = useCallback((updated: DeploymentEnvironment) => {
    setEnvironments((prev) => prev.map((env) => (env.id === updated.id ? updated : env)));
  }, []);

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed) return;
    setCreating(true);
    try {
      const created = await createDeploymentEnvironment(projectId, trimmed);
      setEnvironments((prev) => [...prev, created]);
      setNewName('');
      toast.success('Deployment environment created');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create environment');
    } finally {
      setCreating(false);
    }
  };

  const handlePolicyEnabledChange = async (env: DeploymentEnvironment, enabled: boolean) => {
    setPolicySaving(env.id);
    try {
      const updated = await updateDeploymentEnvironmentPolicy(projectId, env.id, {
        agentDeployEnabled: enabled,
      });
      replaceEnvironment(updated);
      toast.success(enabled ? 'Agent deployment enabled' : 'Agent deployment disabled');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update deployment policy');
    } finally {
      setPolicySaving(null);
    }
  };

  const handleProfileToggle = async (env: DeploymentEnvironment, profileId: string) => {
    const current = env.agentPolicy.allowedDeployProfileIds;
    const next = current.includes(profileId)
      ? current.filter((id) => id !== profileId)
      : [...current, profileId];

    setPolicySaving(env.id);
    try {
      const updated = await updateDeploymentEnvironmentPolicy(projectId, env.id, {
        allowedDeployProfileIds: next,
      });
      replaceEnvironment(updated);
      toast.success('Allowed profiles updated');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update allowed profiles');
    } finally {
      setPolicySaving(null);
    }
  };

  const handleRefreshLogs = async (env: DeploymentEnvironment) => {
    setLogsOpenEnvId(env.id);
    setLogsByEnv((prev) => ({
      ...prev,
      [env.id]: { entries: prev[env.id]?.entries ?? [], loading: true, error: null },
    }));
    try {
      const result = await getDeploymentEnvironmentLogs(projectId, env.id, { limit: 80 });
      setLogsByEnv((prev) => ({
        ...prev,
        [env.id]: {
          entries: result.entries ?? [],
          loading: false,
          error: null,
          unavailableReason: result.unavailableReason,
        },
      }));
    } catch (err) {
      setLogsByEnv((prev) => ({
        ...prev,
        [env.id]: {
          entries: [],
          loading: false,
          error: err instanceof Error ? err.message : 'Failed to load deployment logs',
        },
      }));
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const result = await deleteDeploymentEnvironment(projectId, deleteTarget.id);
      setEnvironments((prev) => prev.filter((env) => env.id !== deleteTarget.id));
      setDeleteTarget(null);
      toast.success(
        result.nodeDeleted
          ? 'Deployment environment and node destroyed'
          : 'Deployment environment destroyed',
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to destroy environment');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="grid gap-4">
      <section className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-3">
        <div>
          <h1 className="sam-type-page-title m-0 text-fg-primary">Deployments</h1>
          <p className="sam-type-secondary m-0 mt-1 text-fg-muted">
            Manage app environments, deployment nodes, agent policy, logs, and teardown.
          </p>
        </div>
        <Button variant="secondary" onClick={() => void loadEnvironments(true)} disabled={refreshing}>
          <RefreshCw size={15} />
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </Button>
      </section>

      <form onSubmit={(event) => void handleCreate(event)} className="glass-surface rounded-lg p-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <label className="grid gap-1">
          <span className="text-sm font-medium text-fg-primary">New Environment</span>
          <Input
            value={newName}
            onChange={(event) => setNewName(event.currentTarget.value.toLowerCase())}
            placeholder="staging"
            pattern="[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?"
            aria-describedby="deployment-env-name-help"
          />
          <span id="deployment-env-name-help" className="text-xs text-fg-muted">
            Lowercase letters, numbers, and hyphens.
          </span>
        </label>
        <Button type="submit" loading={creating} disabled={creating || !newName.trim()}>
          <Plus size={15} />
          Create
        </Button>
      </form>

      {error && <Alert variant="error" onDismiss={() => setError(null)}>{error}</Alert>}

      {loading ? (
        <div className="grid gap-4">
          <SkeletonCard lines={5} />
          <SkeletonCard lines={5} />
        </div>
      ) : sortedEnvironments.length === 0 ? (
        <EmptyState
          icon={<Rocket size={44} />}
          heading="No deployment environments"
          description="Create an environment before agents can build or deploy an app for this project."
          action={{ label: 'Create staging', onClick: () => setNewName('staging') }}
        />
      ) : (
        <div className="grid gap-4">
          {profilesLoading && (
            <div className="rounded-md border border-border-default bg-inset px-3 py-2 text-xs text-fg-muted">
              Loading agent profiles...
            </div>
          )}
          {sortedEnvironments.map((env) => (
            <DeploymentEnvironmentCard
              key={env.id}
              env={env}
              profiles={profiles}
              policySaving={policySaving}
              logState={logsByEnv[env.id]}
              logsOpen={logsOpenEnvId === env.id}
              onPolicyEnabledChange={(target, enabled) => void handlePolicyEnabledChange(target, enabled)}
              onProfileToggle={(target, profileId) => void handleProfileToggle(target, profileId)}
              onRefreshLogs={(target) => void handleRefreshLogs(target)}
              onDelete={setDeleteTarget}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        isOpen={Boolean(deleteTarget)}
        onClose={() => {
          if (!deleting) setDeleteTarget(null);
        }}
        onConfirm={() => void handleDeleteConfirm()}
        title="Destroy deployment environment?"
        variant="danger"
        confirmLabel="Destroy"
        loading={deleting}
        message={
          <div className="grid gap-2">
            <p className="m-0">
              This deletes <strong>{deleteTarget?.name}</strong>, removes its app-route DNS records, deletes attached deployment volumes, and destroys the deployment node when one exists.
            </p>
            <p className="m-0">This cannot be undone.</p>
          </div>
        }
      />
    </div>
  );
}
