import { Alert, Button, EmptyState, Input, SkeletonCard } from '@simple-agent-manager/ui';
import { Plus, RefreshCw, Rocket } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';

import { ConfirmDialog } from '../components/ConfirmDialog';
import {
  DeploymentEnvironmentCard,
  type DeploymentLogState,
  type DeploymentMetricsState,
} from '../components/deployments/DeploymentEnvironmentCard';
import { useAgentProfiles } from '../hooks/useAgentProfiles';
import { useToast } from '../hooks/useToast';
import {
  createDeploymentEnvironment,
  deleteDeploymentEnvironment,
  type DeleteDeploymentEnvironmentResponse,
  type DeploymentEnvironment,
  getDeploymentEnvironmentLogs,
  getDeploymentEnvironmentMetrics,
  listDeploymentEnvironmentContainers,
  listDeploymentEnvironments,
  updateDeploymentEnvironmentPolicy,
} from '../lib/api';
import { useProjectContext } from './ProjectContext';

const DEPLOYMENT_ENVIRONMENT_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function formatCleanupSummary(result: DeleteDeploymentEnvironmentResponse): string {
  const parts: string[] = [];
  if (result.dnsRecordsDeleted > 0)
    parts.push(
      `${result.dnsRecordsDeleted} DNS record${result.dnsRecordsDeleted === 1 ? '' : 's'} deleted`
    );
  if (result.volumesDeleted > 0)
    parts.push(`${result.volumesDeleted} volume${result.volumesDeleted === 1 ? '' : 's'} deleted`);
  if (result.volumesDetached > 0 && result.volumesDetached !== result.volumesDeleted) {
    parts.push(
      `${result.volumesDetached} volume${result.volumesDetached === 1 ? '' : 's'} detached`
    );
  }
  if (result.nodeDeleted) parts.push('node destroyed');
  if (result.nodeId && !result.nodeDeleted) parts.push('node preserved (was not destroyed)');
  return parts.length > 0 ? parts.join(', ') : 'Environment removed';
}

export function ProjectDeployments() {
  const { projectId } = useProjectContext();
  const toast = useToast();
  const { profiles, loading: profilesLoading } = useAgentProfiles(projectId);

  const [environments, setEnvironments] = useState<DeploymentEnvironment[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newNameError, setNewNameError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [policySaving, setPolicySaving] = useState<string | null>(null);
  const [logsOpenEnvId, setLogsOpenEnvId] = useState<string | null>(null);
  const [configOpenEnvId, setConfigOpenEnvId] = useState<string | null>(null);
  const [logsByEnv, setLogsByEnv] = useState<Record<string, DeploymentLogState>>({});
  const [metricsByEnv, setMetricsByEnv] = useState<Record<string, DeploymentMetricsState>>({});
  const [deleteTarget, setDeleteTarget] = useState<DeploymentEnvironment | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [cleanupNotice, setCleanupNotice] = useState<{
    summary: string;
    warnings: string[];
  } | null>(null);

  const sortedEnvironments = useMemo(
    () => [...environments].sort((a, b) => a.name.localeCompare(b.name)),
    [environments]
  );
  const deleteTargetNodeEnvironments = useMemo(() => {
    if (!deleteTarget?.nodeId) return [];
    return environments
      .filter((env) => env.nodeId === deleteTarget.nodeId)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [deleteTarget?.nodeId, environments]);

  const loadEnvironments = useCallback(
    async (isRefresh = false) => {
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
    },
    [projectId]
  );

  useEffect(() => {
    void loadEnvironments();
  }, [loadEnvironments]);

  const refreshMetrics = useCallback(
    async (env: DeploymentEnvironment) => {
      if (env.node?.status !== 'running') {
        setMetricsByEnv((prev) => ({
          ...prev,
          [env.id]: {
            systemInfo: null,
            fallbackMetrics: null,
            loading: false,
            error: null,
            unavailableReason: env.node ? 'node_not_running' : 'no_deployment_node',
          },
        }));
        return;
      }

      setMetricsByEnv((prev) => ({
        ...prev,
        [env.id]: {
          systemInfo: prev[env.id]?.systemInfo ?? null,
          fallbackMetrics: prev[env.id]?.fallbackMetrics ?? null,
          loading: true,
          error: null,
        },
      }));

      try {
        const result = await getDeploymentEnvironmentMetrics(projectId, env.id);
        setMetricsByEnv((prev) => ({
          ...prev,
          [env.id]: {
            systemInfo: result.systemInfo,
            fallbackMetrics: result.fallbackMetrics ?? null,
            loading: false,
            error: null,
            unavailableReason: result.unavailableReason,
          },
        }));
      } catch (err) {
        setMetricsByEnv((prev) => ({
          ...prev,
          [env.id]: {
            systemInfo: prev[env.id]?.systemInfo ?? null,
            fallbackMetrics: prev[env.id]?.fallbackMetrics ?? null,
            loading: false,
            error: err instanceof Error ? err.message : 'Failed to load deployment metrics',
          },
        }));
      }
    },
    [projectId]
  );

  useEffect(() => {
    const running = sortedEnvironments.filter((env) => env.node?.status === 'running');
    if (running.length === 0) return;

    running.forEach((env) => void refreshMetrics(env));
    const interval = window.setInterval(() => {
      running.forEach((env) => void refreshMetrics(env));
    }, 15000);

    return () => window.clearInterval(interval);
  }, [sortedEnvironments, refreshMetrics]);

  const replaceEnvironment = useCallback((updated: DeploymentEnvironment) => {
    setEnvironments((prev) => prev.map((env) => (env.id === updated.id ? updated : env)));
  }, []);

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed) {
      setNewNameError('Enter an environment name.');
      return;
    }
    if (!DEPLOYMENT_ENVIRONMENT_NAME_RE.test(trimmed)) {
      setNewNameError(
        'Use lowercase letters, numbers, and hyphens. Start and end with a letter or number.'
      );
      return;
    }
    setCreating(true);
    try {
      setNewNameError(null);
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

  const handleRefreshLogs = async (
    env: DeploymentEnvironment,
    opts?: { source?: string; level?: string; search?: string; container?: string }
  ) => {
    setLogsOpenEnvId(env.id);
    setLogsByEnv((prev) => ({
      ...prev,
      [env.id]: { entries: prev[env.id]?.entries ?? [], loading: true, error: null },
    }));
    try {
      const containersPromise = listDeploymentEnvironmentContainers(projectId, env.id).catch(
        () => ({ containers: [] })
      );
      const result = await getDeploymentEnvironmentLogs(projectId, env.id, {
        limit: 80,
        source: opts?.source as never,
        level: opts?.level as never,
        container: opts?.container,
        search: opts?.search,
      });
      const containerResult = await containersPromise;
      setLogsByEnv((prev) => ({
        ...prev,
        [env.id]: {
          entries: result.entries ?? [],
          containers: containerResult.containers ?? [],
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

      const summary = formatCleanupSummary(result);
      toast.success(`Environment destroyed: ${summary}`);

      if (result.warnings.length > 0) {
        setCleanupNotice({ summary, warnings: result.warnings });
      }
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
        <Button
          variant="secondary"
          onClick={() => void loadEnvironments(true)}
          disabled={refreshing}
        >
          <RefreshCw size={15} />
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </Button>
      </section>

      <form
        onSubmit={(event) => void handleCreate(event)}
        className="glass-surface rounded-lg p-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
      >
        <label htmlFor="deployment-env-name" className="grid gap-1">
          <span className="text-sm font-medium text-fg-primary">New Environment</span>
          <Input
            id="deployment-env-name"
            value={newName}
            onChange={(event) => {
              setNewName(event.currentTarget.value.toLowerCase());
              setNewNameError(null);
            }}
            placeholder="staging"
            pattern="[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?"
            aria-invalid={Boolean(newNameError)}
            aria-describedby={
              newNameError ? 'deployment-env-name-error' : 'deployment-env-name-help'
            }
          />
          {newNameError ? (
            <span id="deployment-env-name-error" className="text-xs text-danger">
              {newNameError}
            </span>
          ) : (
            <span id="deployment-env-name-help" className="text-xs text-fg-muted">
              Lowercase letters, numbers, and hyphens.
            </span>
          )}
        </label>
        <Button type="submit" loading={creating} disabled={creating || !newName.trim()}>
          <Plus size={15} />
          Create
        </Button>
      </form>

      {error && (
        <Alert variant="error" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      {cleanupNotice && (
        <Alert variant="warning" onDismiss={() => setCleanupNotice(null)}>
          <div className="grid gap-1">
            <strong>Cleanup completed: {cleanupNotice.summary}</strong>
            {cleanupNotice.warnings.map((w, i) => (
              <div key={i} className="text-sm">
                {w}
              </div>
            ))}
          </div>
        </Alert>
      )}

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
              projectId={projectId}
              env={env}
              profiles={profiles}
              policySaving={policySaving}
              logState={logsByEnv[env.id]}
              metricsState={metricsByEnv[env.id]}
              logsOpen={logsOpenEnvId === env.id}
              configOpen={configOpenEnvId === env.id}
              onConfigToggle={(target) =>
                setConfigOpenEnvId((current) => (current === target.id ? null : target.id))
              }
              onPolicyEnabledChange={(target, enabled) =>
                void handlePolicyEnabledChange(target, enabled)
              }
              onProfileToggle={(target, profileId) => void handleProfileToggle(target, profileId)}
              onRefreshLogs={(target, opts) => void handleRefreshLogs(target, opts)}
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
              This destroys the <strong>{deleteTarget?.name}</strong> deployment environment:
            </p>
            <ul className="m-0 pl-4 grid gap-1 text-sm">
              <li>Removes all app-route DNS records</li>
              <li>Detaches and deletes attached deployment volumes</li>
              {deleteTarget?.nodeId ? (
                deleteTargetNodeEnvironments.length > 1 ? (
                  <li>
                    Keeps the shared deployment node running for{' '}
                    {deleteTargetNodeEnvironments.length - 1} other environment
                    {deleteTargetNodeEnvironments.length === 2 ? '' : 's'}
                  </li>
                ) : (
                  <li>Destroys the deployment node because this is the last environment on it</li>
                )
              ) : (
                <li>No deployment node is currently attached</li>
              )}
            </ul>
            {deleteTarget && deleteTarget.routeHostnames.length > 0 && (
              <div className="grid gap-1 rounded-sm border border-border-default bg-inset px-2 py-2 text-sm">
                <div className="font-medium">Routes removed</div>
                {deleteTarget.routeHostnames.slice(0, 3).map((hostname) => (
                  <a
                    key={hostname}
                    href={`https://${hostname}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent no-underline hover:underline break-all"
                  >
                    {hostname}
                  </a>
                ))}
                {deleteTarget.routeHostnames.length > 3 && (
                  <span className="text-fg-muted">
                    +{deleteTarget.routeHostnames.length - 3} more
                  </span>
                )}
              </div>
            )}
            <p className="m-0 font-semibold">This cannot be undone.</p>
          </div>
        }
      />
    </div>
  );
}
