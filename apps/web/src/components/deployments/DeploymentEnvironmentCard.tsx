import type { AgentProfile, NodeLogEntry } from '@simple-agent-manager/shared';
import { Alert, Button, StatusBadge } from '@simple-agent-manager/ui';
import {
  ExternalLink,
  RefreshCw,
  ScrollText,
  Server,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { Link } from 'react-router';

import type { DeploymentEnvironment } from '../../lib/api';

export type DeploymentLogState = {
  entries: NodeLogEntry[];
  loading: boolean;
  error: string | null;
  unavailableReason?: string;
};

function formatDateTime(value: string | null | undefined): string {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function formatReason(reason: string | undefined): string {
  if (!reason) return 'Logs unavailable';
  return reason.replace(/_/g, ' ');
}

function releaseBadgeStatus(status: string): string {
  if (status === 'created') return 'pending';
  if (status === 'applying') return 'in_progress';
  if (status === 'applied') return 'completed';
  return status;
}

function environmentBadgeStatus(status: string): string {
  return status === 'active' ? 'connected' : status;
}

function profileName(profileId: string, profiles: AgentProfile[]): string {
  return profiles.find((profile) => profile.id === profileId)?.name ?? profileId;
}

function StatusDimensions({ env }: { env: DeploymentEnvironment }) {
  const deployStatus = objectRecord(env.observedDeployment.deployStatus);
  const disk = objectRecord(env.observedDeployment.diskTelemetry);
  const rootDisk = objectRecord(disk?.rootDisk);

  const rawItems: Array<[string, unknown]> = [
    ['App', deployStatus?.appHealth],
    ['Node', deployStatus?.nodeHealth ?? env.node?.healthStatus],
    ['Provider', deployStatus?.providerManageability],
    ['Routes', deployStatus?.routeCertState],
    ['Disk', deployStatus?.diskPressure],
    ['Config', deployStatus?.configDrift],
  ];
  const items: Array<[string, string]> = rawItems.flatMap(([label, value]) =>
    typeof value === 'string' && value.length > 0 ? [[label, value]] : [],
  );

  if (items.length === 0 && !rootDisk) {
    return <p className="m-0 text-xs text-fg-muted">No observed deployment health yet.</p>;
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
      {items.map(([label, value]) => (
        <div key={label} className="rounded-sm border border-border-default bg-inset px-2 py-1.5">
          <div className="text-[0.6875rem] uppercase text-fg-muted font-semibold">{label}</div>
          <div className="text-sm text-fg-primary truncate">{String(value)}</div>
        </div>
      ))}
      {rootDisk?.usedPercent !== undefined && (
        <div className="rounded-sm border border-border-default bg-inset px-2 py-1.5">
          <div className="text-[0.6875rem] uppercase text-fg-muted font-semibold">Root Disk</div>
          <div className="text-sm text-fg-primary">
            {Number(rootDisk.usedPercent).toFixed(1)}%
          </div>
        </div>
      )}
    </div>
  );
}

function LogsPreview({ state }: { state: DeploymentLogState | undefined }) {
  if (!state) return null;
  if (state.loading) {
    return <div className="text-xs text-fg-muted">Loading logs...</div>;
  }
  if (state.error) {
    return <Alert variant="error">{state.error}</Alert>;
  }
  if (state.entries.length === 0) {
    return (
      <div className="rounded-sm border border-border-default bg-inset px-3 py-2 text-xs text-fg-muted">
        {formatReason(state.unavailableReason)}
      </div>
    );
  }

  return (
    <div className="max-h-64 overflow-y-auto rounded-md border border-border-default bg-inset font-mono text-xs">
      {state.entries.slice(0, 8).map((entry, index) => (
        <div key={`${entry.timestamp}-${index}`} className="grid gap-1 px-2 py-1 border-b border-border-default last:border-b-0">
          <div className="flex items-center gap-2 text-fg-muted">
            <span>{formatDateTime(entry.timestamp)}</span>
            <span className="uppercase font-semibold">{entry.level}</span>
            <span>{entry.source}</span>
          </div>
          <div className="text-fg-primary break-words">{entry.message}</div>
        </div>
      ))}
    </div>
  );
}

interface DeploymentEnvironmentCardProps {
  env: DeploymentEnvironment;
  profiles: AgentProfile[];
  policySaving: string | null;
  logState: DeploymentLogState | undefined;
  logsOpen: boolean;
  onPolicyEnabledChange: (env: DeploymentEnvironment, enabled: boolean) => void;
  onProfileToggle: (env: DeploymentEnvironment, profileId: string) => void;
  onRefreshLogs: (env: DeploymentEnvironment) => void;
  onDelete: (env: DeploymentEnvironment) => void;
}

export function DeploymentEnvironmentCard({
  env,
  profiles,
  policySaving,
  logState,
  logsOpen,
  onPolicyEnabledChange,
  onProfileToggle,
  onRefreshLogs,
  onDelete,
}: DeploymentEnvironmentCardProps) {
  const observed = env.observedDeployment;
  const allowedProfiles = env.agentPolicy.allowedDeployProfileIds;
  const policyBusy = policySaving === env.id;

  return (
    <article className="glass-surface rounded-lg p-4 grid gap-4">
      <header className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="sam-type-section-heading m-0 text-fg-primary">{env.name}</h2>
            <StatusBadge status={environmentBadgeStatus(env.status)} label={env.status} />
            {env.latestRelease && (
              <StatusBadge
                status={releaseBadgeStatus(env.latestRelease.status)}
                label={`v${env.latestRelease.version} ${env.latestRelease.status}`}
              />
            )}
          </div>
          <p className="m-0 mt-1 text-xs text-fg-muted">
            Updated {formatDateTime(env.updatedAt)} / Observed {formatDateTime(observed.observedAt)}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => onRefreshLogs(env)}>
            <ScrollText size={14} />
            {logsOpen ? 'Refresh Logs' : 'Logs'}
          </Button>
          <Button size="sm" variant="danger" onClick={() => onDelete(env)}>
            <Trash2 size={14} />
            Destroy
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(280px,360px)] gap-4">
        <section className="grid gap-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="rounded-md border border-border-default bg-inset px-3 py-2">
              <div className="text-[0.6875rem] uppercase text-fg-muted font-semibold">Applied Seq</div>
              <div className="text-lg text-fg-primary tabular-nums">{observed.appliedSeq ?? '-'}</div>
            </div>
            <div className="rounded-md border border-border-default bg-inset px-3 py-2">
              <div className="text-[0.6875rem] uppercase text-fg-muted font-semibold">Observed Status</div>
              <div className="text-sm text-fg-primary">{observed.status ?? 'Unknown'}</div>
            </div>
            <div className="rounded-md border border-border-default bg-inset px-3 py-2">
              <div className="text-[0.6875rem] uppercase text-fg-muted font-semibold">Routes</div>
              <div className="text-sm text-fg-primary tabular-nums">{env.routeHostnames.length}</div>
            </div>
          </div>

          <StatusDimensions env={env} />

          {observed.errorMessage && (
            <div className="rounded-md border border-danger bg-danger-tint px-3 py-2 text-sm text-danger">
              {observed.errorMessage}
            </div>
          )}

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
                    className="inline-flex items-center gap-1 min-w-0 text-sm text-accent no-underline hover:underline"
                  >
                    <span className="truncate">{hostname}</span>
                    <ExternalLink size={13} className="shrink-0" />
                  </a>
                ))}
              </div>
            </div>
          )}
        </section>

        <aside className="grid gap-3 content-start">
          <section className="rounded-md border border-border-default bg-inset px-3 py-3 grid gap-2">
            <div className="flex items-center gap-2 text-fg-primary font-semibold text-sm">
              <Server size={15} />
              Deployment Node
            </div>
            {env.node ? (
              <div className="grid gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <Link to={`/nodes/${env.node.id}`} className="text-accent text-sm no-underline hover:underline">
                    {env.node.name}
                  </Link>
                  <StatusBadge status={env.node.status} />
                  <StatusBadge status={env.node.healthStatus || 'stale'} />
                </div>
                <div className="text-xs text-fg-muted break-words">
                  {env.node.cloudProvider ?? 'Unknown provider'} / {env.node.vmSize} / {env.node.vmLocation}
                </div>
              </div>
            ) : (
              <p className="m-0 text-xs text-fg-muted">No deployment node has been provisioned yet.</p>
            )}
          </section>

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
                  onChange={(event) => onPolicyEnabledChange(env, event.currentTarget.checked)}
                />
                Enabled
              </label>
            </div>

            <div className="text-xs text-fg-muted">
              {env.agentPolicy.agentDeployEnabled
                ? `Enabled ${formatDateTime(env.agentPolicy.agentDeployEnabledAt)}`
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
                        onChange={() => onProfileToggle(env, profile.id)}
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
        </aside>
      </div>

      {logsOpen && (
        <section className="grid gap-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="m-0 text-sm font-semibold text-fg-primary">Deployment Logs</h3>
            <button
              type="button"
              onClick={() => onRefreshLogs(env)}
              className="inline-flex items-center gap-1 rounded-sm border border-border-default bg-transparent px-2 py-1 text-xs text-fg-muted cursor-pointer hover:text-fg-primary"
            >
              <RefreshCw size={12} />
              Refresh
            </button>
          </div>
          <LogsPreview state={logState} />
        </section>
      )}
    </article>
  );
}
