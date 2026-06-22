import { StatusBadge } from '@simple-agent-manager/ui';
import { AlertTriangle } from 'lucide-react';

import type { DeploymentEnvironment } from '../../lib/api';
import { formatDateTimeCompact, safePercent } from './deployment-card-format';

export function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function serviceRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
  );
}

export function observedServicesHealthy(value: unknown): boolean {
  const recs = serviceRecords(value);
  if (recs.length === 0) return false;
  return recs.every((svc) => {
    if (svc.status !== 'running') return false;
    const h = svc.health as string | undefined;
    return !h || h === 'healthy' || h === 'none';
  });
}

export function releaseBadgeStatus(status: string): string {
  if (status === 'created') return 'pending';
  if (status === 'applying') return 'in_progress';
  if (status === 'applied') return 'completed';
  return status;
}

export function environmentBadgeStatus(status: string): string {
  return status === 'active' ? 'connected' : status;
}

export function profileName(profileId: string, profiles: AgentProfile[]): string {
  return profiles.find((profile) => profile.id === profileId)?.name ?? profileId;
}

export function shortId(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.length > 12 ? `${value.slice(0, 8)}...` : value;
}

// ─── Service State ─────────────────────────────────────────────────────────

export type ServiceState = 'serving' | 'degraded' | 'not-serving' | 'unknown';

export function deriveServiceState(env: DeploymentEnvironment): ServiceState {
  const ds = objectRecord(env.observedDeployment.deployStatus);
  const node = (ds?.nodeHealth as string | undefined) ?? env.node?.healthStatus;

  if (env.observedDeployment.errorMessage) return 'not-serving';

  // No deployStatus yet — infer from observed deployment metadata
  if (!ds) {
    const obsStatus = env.observedDeployment.status as string | undefined;
    if (obsStatus === 'failed' || obsStatus === 'failed-initial' || obsStatus === 'reverted')
      return 'not-serving';
    if (
      obsStatus === 'applied' &&
      env.latestRelease?.status === 'applied' &&
      observedServicesHealthy(env.observedDeployment.services) &&
      (node === 'healthy' || node === 'connected')
    )
      return 'serving';
    return 'unknown';
  }

  const app = ds.appHealth as string | undefined;
  const route = ds.routeCertState as string | undefined;
  const appOk =
    app === 'healthy' || (!app && observedServicesHealthy(env.observedDeployment.services));
  const nodeOk = node === 'healthy' || node === 'connected';
  const routeOk = route === 'issued' || route === undefined;

  if (appOk && nodeOk && routeOk) return 'serving';
  if (
    app === 'unhealthy' ||
    route === 'pending' ||
    route === 'error' ||
    node === 'stale' ||
    node === 'unhealthy'
  )
    return 'degraded';
  if (appOk) return 'serving';
  return 'unknown';
}

export function serviceStateLabel(state: ServiceState): string {
  if (state === 'serving') return 'Serving';
  if (state === 'degraded') return 'Degraded';
  if (state === 'not-serving') return 'Not serving';
  return 'Unknown';
}

export function serviceStateBadge(state: ServiceState): string {
  if (state === 'serving') return 'completed';
  if (state === 'degraded') return 'warning';
  if (state === 'not-serving') return 'error';
  return 'stale';
}

export function deriveBlocker(env: DeploymentEnvironment): string | null {
  const ds = objectRecord(env.observedDeployment.deployStatus);
  if (env.observedDeployment.errorMessage) return env.observedDeployment.errorMessage;
  if (!ds) return null;
  if (ds.routeCertState === 'pending')
    return 'Route certificate pending. Check node logs for caddy/acme entries.';
  if (ds.routeCertState === 'error')
    return 'Route certificate error. Check Caddy logs for ACME failures.';
  if (ds.appHealth === 'unhealthy')
    return 'App container unhealthy. Check deployment logs for container errors.';
  const nodeHealth = (ds.nodeHealth as string | undefined) ?? env.node?.healthStatus;
  if (nodeHealth === 'stale')
    return 'Node stale. Control plane has not received a recent heartbeat.';
  if (nodeHealth === 'unhealthy') return 'Node unhealthy. Check node system resources.';
  if (ds.providerManageability === 'unmanageable')
    return 'Provider reports node unmanageable. Destructive actions may not complete.';
  if (ds.diskPressure === 'high' || ds.diskPressure === 'critical')
    return 'Disk pressure detected. Consider freeing space or resizing volumes.';
  if (ds.configDrift === 'drifted')
    return 'Configuration drift detected. Re-apply the latest release.';
  return null;
}

// ─── Operational Summary ───────────────────────────────────────────────────

export function OperationalSummary({ env }: { env: DeploymentEnvironment }) {
  const serviceState = deriveServiceState(env);
  const release = env.latestRelease;
  const blocker = deriveBlocker(env);

  return (
    <div className="rounded-md border border-border-default bg-inset px-3 py-2.5 grid gap-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <StatusBadge
          status={serviceStateBadge(serviceState)}
          label={serviceStateLabel(serviceState)}
        />
        {release && (
          <span className="text-sm text-fg-primary">
            Release v{release.version} <span className="text-fg-muted">{release.status}</span>
          </span>
        )}
        {!release && <span className="text-sm text-fg-muted">No release</span>}
      </div>
      {blocker && (
        <div className="flex items-start gap-1.5 text-xs text-warning">
          <AlertTriangle size={13} className="shrink-0 mt-0.5" />
          <span className="break-words min-w-0">{blocker}</span>
        </div>
      )}
      <div className="text-[0.6875rem] text-fg-muted">
        Observed {formatDateTimeCompact(env.observedDeployment.observedAt)}
      </div>
    </div>
  );
}

// ─── Release Attribution ───────────────────────────────────────────────────

export function ReleaseAttribution({ env }: { env: DeploymentEnvironment }) {
  const release = env.latestRelease;
  if (!release) return null;
  const submittedBy = release.submittedBy;
  const details = [
    submittedBy?.agentProfileId ? `profile ${shortId(submittedBy.agentProfileId)}` : null,
    submittedBy?.taskId ? `task ${shortId(submittedBy.taskId)}` : null,
    submittedBy?.workspaceId ? `workspace ${shortId(submittedBy.workspaceId)}` : null,
  ].filter(Boolean);

  return (
    <div className="text-xs text-fg-muted min-w-0">
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-fg-primary font-medium">Release v{release.version}</span>
        <StatusBadge status={releaseBadgeStatus(release.status)} label={release.status} />
        <span>
          submitted by{' '}
          <span className="text-fg-primary">
            {submittedBy?.userId || release.createdBy || 'unknown'}
          </span>
        </span>
        <span>{formatDateTimeCompact(release.createdAt)}</span>
      </div>
      {details.length > 0 && <div className="truncate">{details.join(' / ')}</div>}
    </div>
  );
}

// ─── Status Dimensions ─────────────────────────────────────────────────────

export function StatusDimensions({ env }: { env: DeploymentEnvironment }) {
  const deployStatus = objectRecord(env.observedDeployment.deployStatus);
  const disk = objectRecord(env.observedDeployment.diskTelemetry);
  const rootDisk = objectRecord(disk?.rootDisk);

  const appFallback =
    !deployStatus?.appHealth && observedServicesHealthy(env.observedDeployment.services)
      ? 'healthy'
      : undefined;
  const routesFallback =
    !deployStatus?.routeCertState &&
    env.routeHostnames.length > 0 &&
    env.latestRelease?.status === 'applied'
      ? 'published'
      : undefined;

  const rawItems: Array<[string, unknown]> = [
    ['App', deployStatus?.appHealth ?? appFallback],
    ['Node', deployStatus?.nodeHealth ?? env.node?.healthStatus],
    ['Provider', deployStatus?.providerManageability],
    ['Routes', deployStatus?.routeCertState ?? routesFallback],
    ['Disk', deployStatus?.diskPressure],
    ['Config', deployStatus?.configDrift],
  ];
  const items: Array<[string, string]> = rawItems.flatMap(([label, value]) =>
    typeof value === 'string' && value.length > 0 ? [[label, value]] : []
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
          <div className="text-sm text-fg-primary">{safePercent(rootDisk.usedPercent)}</div>
        </div>
      )}
    </div>
  );
}
