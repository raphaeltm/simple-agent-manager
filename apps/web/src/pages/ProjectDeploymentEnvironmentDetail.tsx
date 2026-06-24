import type { AgentProfile } from '@simple-agent-manager/shared';
import { Alert, Button, SkeletonCard, StatusBadge } from '@simple-agent-manager/ui';
import { ArrowLeft, ExternalLink, ScrollText, Server, ShieldCheck, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';

import { ConfirmDialog } from '../components/ConfirmDialog';
import { formatDateTimeCompact } from '../components/deployments/deployment-card-format';
import {
  environmentBadgeStatus,
  OperationalSummary,
  profileName,
  ReleaseAttribution,
  StatusDimensions,
} from '../components/deployments/deployment-status';
import { DeploymentCustomDomainsPanel } from '../components/deployments/DeploymentCustomDomainsPanel';
import { DeploymentEnvironmentConfigPanel } from '../components/deployments/DeploymentEnvironmentConfigPanel';
import { type DeploymentLogState, LogsPanel } from '../components/deployments/DeploymentLogsPanel';
import {
  DeploymentMetricsPanel,
  type DeploymentMetricsState,
} from '../components/deployments/DeploymentMetricsPanel';
import { useAgentProfiles } from '../hooks/useAgentProfiles';
import { useToast } from '../hooks/useToast';
import {
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

type TabKey = 'overview' | 'domains' | 'logs' | 'config' | 'policy' | 'node';

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'domains', label: 'Domains' },
  { key: 'logs', label: 'Logs' },
  { key: 'config', label: 'Configuration' },
  { key: 'policy', label: 'Policy' },
  { key: 'node', label: 'Node & Metrics' },
];

function isTabKey(value: string | null): value is TabKey {
  return value !== null && TABS.some((t) => t.key === value);
}

function formatCleanupSummary(result: DeleteDeploymentEnvironmentResponse): string {
  const parts: string[] = [];
  if (result.dnsRecordsDeleted > 0)
    parts.push(
      `${result.dnsRecordsDeleted} DNS record${result.dnsRecordsDeleted === 1 ? '' : 's'} deleted`
    );
  if (result.volumesDeleted > 0)
    parts.push(`${result.volumesDeleted} volume${result.volumesDeleted === 1 ? '' : 's'} deleted`);
  if (result.nodeDeleted) parts.push('node destroyed');
  if (result.nodeId && !result.nodeDeleted) parts.push('node preserved');
  return parts.length > 0 ? parts.join(', ') : 'Environment removed';
}

export function ProjectDeploymentEnvironmentDetail() {
  const { projectId } = useProjectContext();
  const { envId } = useParams<{ envId: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const { profiles } = useAgentProfiles(projectId);
  const [searchParams, setSearchParams] = useSearchParams();

  const tabParam = searchParams.get('tab');
  const activeTab: TabKey = isTabKey(tabParam) ? tabParam : 'overview';
  const setActiveTab = (tab: TabKey) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', tab);
      return next;
    });
  };

  const [env, setEnv] = useState<DeploymentEnvironment | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [siblingCount, setSiblingCount] = useState(0);

  const [policySaving, setPolicySaving] = useState(false);
  const [logState, setLogState] = useState<DeploymentLogState | undefined>();
  const [metricsState, setMetricsState] = useState<DeploymentMetricsState | undefined>();
  const [logsRequested, setLogsRequested] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const loadEnvironment = useCallback(async () => {
    if (!envId) return;
    try {
      setError(null);
      const result = await listDeploymentEnvironments(projectId);
      const found = result.environments.find((e) => e.id === envId) ?? null;
      setEnv(found);
      if (found?.nodeId) {
        setSiblingCount(result.environments.filter((e) => e.nodeId === found.nodeId).length);
      } else {
        setSiblingCount(0);
      }
      if (!found) setError('This deployment environment no longer exists.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load deployment environment');
    } finally {
      setLoading(false);
    }
  }, [projectId, envId]);

  useEffect(() => {
    void loadEnvironment();
  }, [loadEnvironment]);

  const refreshMetrics = useCallback(async () => {
    if (!env) return;
    if (env.node?.status !== 'running') {
      setMetricsState({
        systemInfo: null,
        fallbackMetrics: null,
        loading: false,
        error: null,
        unavailableReason: env.node ? 'node_not_running' : 'no_deployment_node',
      });
      return;
    }
    setMetricsState((prev) => ({
      systemInfo: prev?.systemInfo ?? null,
      fallbackMetrics: prev?.fallbackMetrics ?? null,
      loading: true,
      error: null,
    }));
    try {
      const result = await getDeploymentEnvironmentMetrics(projectId, env.id);
      setMetricsState({
        systemInfo: result.systemInfo,
        fallbackMetrics: result.fallbackMetrics ?? null,
        loading: false,
        error: null,
        unavailableReason: result.unavailableReason,
      });
    } catch (err) {
      setMetricsState((prev) => ({
        systemInfo: prev?.systemInfo ?? null,
        fallbackMetrics: prev?.fallbackMetrics ?? null,
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to load deployment metrics',
      }));
    }
  }, [projectId, env]);

  useEffect(() => {
    if (env?.node?.status !== 'running') return;
    void refreshMetrics();
    const interval = window.setInterval(() => void refreshMetrics(), 15000);
    return () => window.clearInterval(interval);
  }, [env?.node?.status, refreshMetrics]);

  const refreshLogs = useCallback(
    async (opts?: { source?: string; level?: string; search?: string; container?: string }) => {
      if (!env) return;
      setLogsRequested(true);
      setLogState((prev) => ({ entries: prev?.entries ?? [], loading: true, error: null }));
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
        setLogState({
          entries: result.entries ?? [],
          containers: containerResult.containers ?? [],
          loading: false,
          error: null,
          unavailableReason: result.unavailableReason,
        });
      } catch (err) {
        setLogState({
          entries: [],
          loading: false,
          error: err instanceof Error ? err.message : 'Failed to load deployment logs',
        });
      }
    },
    [projectId, env]
  );

  // Auto-load logs the first time the Logs tab is opened.
  useEffect(() => {
    if (activeTab === 'logs' && env && !logsRequested) {
      void refreshLogs();
    }
  }, [activeTab, env, logsRequested, refreshLogs]);

  const handlePolicyEnabledChange = async (enabled: boolean) => {
    if (!env) return;
    setPolicySaving(true);
    try {
      const updated = await updateDeploymentEnvironmentPolicy(projectId, env.id, {
        agentDeployEnabled: enabled,
      });
      setEnv(updated);
      toast.success(enabled ? 'Agent deployment enabled' : 'Agent deployment disabled');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update deployment policy');
    } finally {
      setPolicySaving(false);
    }
  };

  const handleProfileToggle = async (profileId: string) => {
    if (!env) return;
    const current = env.agentPolicy.allowedDeployProfileIds;
    const next = current.includes(profileId)
      ? current.filter((id) => id !== profileId)
      : [...current, profileId];
    setPolicySaving(true);
    try {
      const updated = await updateDeploymentEnvironmentPolicy(projectId, env.id, {
        allowedDeployProfileIds: next,
      });
      setEnv(updated);
      toast.success('Allowed profiles updated');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update allowed profiles');
    } finally {
      setPolicySaving(false);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!env) return;
    setDeleting(true);
    try {
      const result = await deleteDeploymentEnvironment(projectId, env.id);
      toast.success(`Environment destroyed: ${formatCleanupSummary(result)}`);
      void navigate('..');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to destroy environment');
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div className="grid gap-4">
        <Link
          to=".."
          className="inline-flex items-center gap-1 text-sm text-fg-muted no-underline hover:text-fg-primary w-fit"
        >
          <ArrowLeft size={15} />
          Deployments
        </Link>
        <SkeletonCard lines={6} />
      </div>
    );
  }

  if (!env) {
    return (
      <div className="grid gap-4">
        <Link
          to=".."
          className="inline-flex items-center gap-1 text-sm text-fg-muted no-underline hover:text-fg-primary w-fit"
        >
          <ArrowLeft size={15} />
          Deployments
        </Link>
        <Alert variant="error">{error ?? 'Deployment environment not found.'}</Alert>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <Link
        to=".."
        className="inline-flex items-center gap-1 text-sm text-fg-muted no-underline hover:text-fg-primary w-fit"
      >
        <ArrowLeft size={15} />
        Deployments
      </Link>

      <header className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div className="min-w-0 grid gap-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="sam-type-page-title m-0 text-fg-primary break-words">{env.name}</h1>
            <StatusBadge status={environmentBadgeStatus(env.status)} label={env.status} />
          </div>
          <ReleaseAttribution env={env} />
        </div>
        <Button
          size="sm"
          variant="danger"
          onClick={() => setDeleteOpen(true)}
          className="sm:shrink-0"
        >
          <Trash2 size={14} />
          Destroy Env
        </Button>
      </header>

      {error && (
        <Alert variant="error" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      <nav
        className="flex gap-1 overflow-x-auto border-b border-border-default -mb-px"
        aria-label="Environment sections"
      >
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            aria-current={activeTab === tab.key ? 'page' : undefined}
            className={`whitespace-nowrap px-3 py-2 text-sm border-b-2 transition-colors ${
              activeTab === tab.key
                ? 'border-accent text-fg-primary font-medium'
                : 'border-transparent text-fg-muted hover:text-fg-primary'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {activeTab === 'overview' && (
        <section className="grid gap-4">
          <OperationalSummary env={env} />
          <StatusDimensions env={env} />
          {env.routeHostnames.length > 0 && (
            <div className="grid gap-2">
              <div className="text-xs font-semibold uppercase text-fg-muted">Public Routes</div>
              <div className="grid gap-1">
                {env.routeHostnames.map((hostname) => (
                  <a
                    key={hostname}
                    href={`https://${hostname}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 min-w-0 text-sm text-accent no-underline hover:underline w-fit"
                  >
                    <span className="truncate">{hostname}</span>
                    <ExternalLink size={13} className="shrink-0" />
                  </a>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {activeTab === 'logs' && (
        <section className="grid gap-2">
          <div className="flex items-center gap-2 text-fg-primary font-semibold text-sm">
            <ScrollText size={15} />
            Deployment Logs
          </div>
          <LogsPanel
            state={logState}
            onRefresh={() => void refreshLogs()}
            onRefreshFiltered={(opts) => void refreshLogs(opts)}
          />
        </section>
      )}

      {activeTab === 'domains' && (
        <DeploymentCustomDomainsPanel projectId={projectId} environmentId={env.id} />
      )}

      {activeTab === 'config' && (
        <DeploymentEnvironmentConfigPanel projectId={projectId} environmentId={env.id} open />
      )}

      {activeTab === 'policy' && (
        <AgentPolicySection
          env={env}
          profiles={profiles}
          policyBusy={policySaving}
          onPolicyEnabledChange={(enabled) => void handlePolicyEnabledChange(enabled)}
          onProfileToggle={(profileId) => void handleProfileToggle(profileId)}
        />
      )}

      {activeTab === 'node' && (
        <section className="grid gap-4">
          <NodeSection env={env} />
          <DeploymentMetricsPanel state={metricsState} />
        </section>
      )}

      <ConfirmDialog
        isOpen={deleteOpen}
        onClose={() => {
          if (!deleting) setDeleteOpen(false);
        }}
        onConfirm={() => void handleDeleteConfirm()}
        title="Destroy deployment environment?"
        variant="danger"
        confirmLabel="Destroy"
        loading={deleting}
        message={
          <div className="grid gap-2">
            <p className="m-0">
              This destroys the <strong>{env.name}</strong> deployment environment:
            </p>
            <ul className="m-0 pl-4 grid gap-1 text-sm">
              <li>Removes all app-route DNS records</li>
              <li>Detaches and deletes attached deployment volumes</li>
              {env.nodeId ? (
                siblingCount > 1 ? (
                  <li>
                    Keeps the shared deployment node running for {siblingCount - 1} other
                    environment{siblingCount === 2 ? '' : 's'}
                  </li>
                ) : (
                  <li>Destroys the deployment node because this is the last environment on it</li>
                )
              ) : (
                <li>No deployment node is currently attached</li>
              )}
            </ul>
            <p className="m-0 font-semibold">This cannot be undone.</p>
          </div>
        }
      />
    </div>
  );
}

function NodeSection({ env }: { env: DeploymentEnvironment }) {
  return (
    <section className="rounded-md border border-border-default bg-inset px-3 py-3 grid gap-2">
      <div className="flex items-center gap-2 text-fg-primary font-semibold text-sm">
        <Server size={15} />
        Deployment Node
      </div>
      {env.node ? (
        <div className="grid gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <Link
              to={`/nodes/${env.node.id}`}
              className="text-accent text-sm no-underline hover:underline truncate max-w-[220px]"
            >
              {env.node.name}
            </Link>
            <StatusBadge status={env.node.status} />
            <StatusBadge status={env.node.healthStatus || 'stale'} />
          </div>
          <div className="text-xs text-fg-muted break-words">
            {env.node.cloudProvider ?? 'Unknown provider'} / {env.node.vmSize} /{' '}
            {env.node.vmLocation}
          </div>
        </div>
      ) : (
        <p className="m-0 text-xs text-fg-muted">No deployment node has been provisioned yet.</p>
      )}
    </section>
  );
}

function AgentPolicySection({
  env,
  profiles,
  policyBusy,
  onPolicyEnabledChange,
  onProfileToggle,
}: {
  env: DeploymentEnvironment;
  profiles: AgentProfile[];
  policyBusy: boolean;
  onPolicyEnabledChange: (enabled: boolean) => void;
  onProfileToggle: (profileId: string) => void;
}) {
  const allowedProfiles = env.agentPolicy.allowedDeployProfileIds;
  return (
    <section className="rounded-md border border-border-default bg-inset px-3 py-3 grid gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-fg-primary font-semibold text-sm">
          <ShieldCheck size={15} />
          Agent Policy
        </div>
        <label className="inline-flex items-center gap-2 text-xs text-fg-muted">
          <input
            type="checkbox"
            checked={env.agentPolicy.agentDeployEnabled}
            disabled={policyBusy}
            onChange={(event) => onPolicyEnabledChange(event.currentTarget.checked)}
          />
          Enabled
        </label>
      </div>

      <div className="text-xs text-fg-muted">
        {env.agentPolicy.agentDeployEnabled
          ? `Enabled ${formatDateTimeCompact(env.agentPolicy.agentDeployEnabledAt)}`
          : 'Disabled until a user enables this environment.'}
      </div>

      <div className="grid gap-2">
        <div className="text-xs font-semibold uppercase text-fg-muted">Allowed Profiles</div>
        {profiles.length === 0 ? (
          <p className="m-0 text-xs text-fg-muted">No project profiles to restrict yet.</p>
        ) : (
          <div className="grid gap-1">
            {profiles.map((profile) => (
              <label key={profile.id} className="flex items-center gap-2 text-sm text-fg-primary">
                <input
                  type="checkbox"
                  disabled={policyBusy}
                  checked={allowedProfiles.includes(profile.id)}
                  onChange={() => onProfileToggle(profile.id)}
                />
                <span className="truncate">{profile.name}</span>
              </label>
            ))}
          </div>
        )}
        <div className="text-xs text-fg-muted">
          {allowedProfiles.length === 0
            ? 'Any project agent profile may deploy after the gate is enabled.'
            : allowedProfiles.map((id) => profileName(id, profiles)).join(', ')}
        </div>
      </div>
    </section>
  );
}
