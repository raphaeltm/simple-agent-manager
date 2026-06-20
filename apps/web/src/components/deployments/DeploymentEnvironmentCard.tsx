import type {
  AgentProfile,
  NodeContainerLogTarget,
  NodeLogEntry,
  NodeSystemInfo,
} from '@simple-agent-manager/shared';
import { Alert, Button, StatusBadge } from '@simple-agent-manager/ui';
import {
  AlertTriangle,
  Clipboard,
  ExternalLink,
  RefreshCw,
  ScrollText,
  Search,
  Server,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';

import type { DeploymentEnvironment } from '../../lib/api';

export type DeploymentLogState = {
  entries: NodeLogEntry[];
  loading: boolean;
  error: string | null;
  unavailableReason?: string;
  containers?: NodeContainerLogTarget[];
};

export type DeploymentMetricsState = {
  systemInfo: NodeSystemInfo | null;
  fallbackMetrics?: {
    cpuLoadAvg1?: number;
    memoryPercent?: number;
    diskPercent?: number;
  } | null;
  loading: boolean;
  error: string | null;
  unavailableReason?: string;
};

// ─── Formatting helpers ────────────────────────────────────────────────────

function formatDateTimeCompact(value: string | null | undefined): string {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const mon = date.toLocaleString('en', { month: 'short', timeZone: 'UTC' });
  const day = date.getUTCDate();
  const h = String(date.getUTCHours()).padStart(2, '0');
  const m = String(date.getUTCMinutes()).padStart(2, '0');
  return `${mon} ${day} ${h}:${m} UTC`;
}

function formatLogTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const h = String(date.getUTCHours()).padStart(2, '0');
  const m = String(date.getUTCMinutes()).padStart(2, '0');
  const s = String(date.getUTCSeconds()).padStart(2, '0');
  return `${h}:${m}:${s} UTC`;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function serviceRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
  );
}

function observedServicesHealthy(value: unknown): boolean {
  const recs = serviceRecords(value);
  if (recs.length === 0) return false;
  return recs.every((svc) => {
    if (svc.status !== 'running') return false;
    const h = svc.health as string | undefined;
    return !h || h === 'healthy' || h === 'none';
  });
}

function safePercent(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'string' && value.trim() === '') return '-';

  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  return `${n.toFixed(1)}%`;
}

function formatBytes(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '-';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let next = value;
  let idx = 0;
  while (next >= 1024 && idx < units.length - 1) {
    next /= 1024;
    idx += 1;
  }
  return `${next.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function formatReason(reason: string | undefined): string {
  if (!reason) return 'Logs unavailable. The node may not be provisioned or reachable yet.';
  const humanized = reason.replace(/_/g, ' ');
  if (reason === 'no_node')
    return 'No deployment node provisioned yet. Logs will appear after the node boots.';
  if (reason === 'node_stale')
    return 'Node has not reported recently. Logs may be unavailable until the node reconnects.';
  if (reason === 'node_stopped') return 'Node is stopped. Start the node to view live logs.';
  return humanized.charAt(0).toUpperCase() + humanized.slice(1) + '.';
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

function shortId(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.length > 12 ? `${value.slice(0, 8)}...` : value;
}

// ─── Operational Summary ───────────────────────────────────────────────────

type ServiceState = 'serving' | 'degraded' | 'not-serving' | 'unknown';

function deriveServiceState(env: DeploymentEnvironment): ServiceState {
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

function serviceStateLabel(state: ServiceState): string {
  if (state === 'serving') return 'Serving';
  if (state === 'degraded') return 'Degraded';
  if (state === 'not-serving') return 'Not serving';
  return 'Unknown';
}

function serviceStateBadge(state: ServiceState): string {
  if (state === 'serving') return 'completed';
  if (state === 'degraded') return 'warning';
  if (state === 'not-serving') return 'error';
  return 'stale';
}

function deriveBlocker(env: DeploymentEnvironment): string | null {
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

function OperationalSummary({ env }: { env: DeploymentEnvironment }) {
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

function ReleaseAttribution({ env }: { env: DeploymentEnvironment }) {
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
          by{' '}
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

function StatusDimensions({ env }: { env: DeploymentEnvironment }) {
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

// ─── Logs Panel ────────────────────────────────────────────────────────────

const LOG_SOURCES = ['all', 'deployment-agent', 'app'] as const;
const LOG_LEVELS = ['all', 'error', 'warn', 'info', 'debug'] as const;

interface LogsPanelProps {
  state: DeploymentLogState | undefined;
  onRefresh: () => void;
  onRefreshFiltered: (opts: {
    source?: string;
    level?: string;
    search?: string;
    container?: string;
  }) => void;
}

function LogsPanel({ state, onRefresh, onRefreshFiltered }: LogsPanelProps) {
  const [source, setSource] = useState<string>('all');
  const [level, setLevel] = useState<string>('all');
  const [container, setContainer] = useState('');
  const [search, setSearch] = useState('');

  const applyFilters = (nextSource?: string, nextLevel?: string, nextContainer?: string) => {
    const s = nextSource ?? source;
    const l = nextLevel ?? level;
    const c = nextContainer ?? container;
    const apiSource = s === 'app' ? 'docker' : s === 'deployment-agent' ? 'agent' : s;
    onRefreshFiltered({
      source: apiSource === 'all' ? undefined : apiSource,
      level: l === 'all' ? undefined : l,
      container: c || undefined,
      search: search.trim() || undefined,
    });
  };

  const handleCopyLogs = () => {
    if (!state?.entries.length) return;
    const text = state.entries
      .map((e) => `${e.timestamp} [${e.level}] [${e.source}] ${e.message}`)
      .join('\n');
    void navigator.clipboard.writeText(text);
  };

  return (
    <section className="grid gap-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="m-0 text-sm font-semibold text-fg-primary">Deployment Logs</h3>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleCopyLogs}
            disabled={!state?.entries.length}
            title="Copy recent logs to clipboard"
            className="inline-flex items-center gap-1 rounded-sm border border-border-default bg-transparent px-2 py-1 text-xs text-fg-muted cursor-pointer hover:text-fg-primary disabled:opacity-40 disabled:cursor-default"
          >
            <Clipboard size={12} />
            Copy
          </button>
          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex items-center gap-1 rounded-sm border border-border-default bg-transparent px-2 py-1 text-xs text-fg-muted cursor-pointer hover:text-fg-primary"
          >
            <RefreshCw size={12} />
            Refresh
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1.5">
          <label
            className="text-[0.6875rem] uppercase text-fg-muted font-semibold"
            htmlFor="log-source"
          >
            Source
          </label>
          <select
            id="log-source"
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              applyFilters(e.target.value, undefined);
            }}
            className="rounded-sm border border-border-default bg-inset text-fg-primary text-xs px-1.5 py-0.5"
          >
            {LOG_SOURCES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-1.5">
          <label
            className="text-[0.6875rem] uppercase text-fg-muted font-semibold"
            htmlFor="log-level"
          >
            Level
          </label>
          <select
            id="log-level"
            value={level}
            onChange={(e) => {
              setLevel(e.target.value);
              applyFilters(undefined, e.target.value);
            }}
            className="rounded-sm border border-border-default bg-inset text-fg-primary text-xs px-1.5 py-0.5"
          >
            {LOG_LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </div>
        {(source === 'app' || source === 'all') && (
          <div className="flex items-center gap-1.5">
            <label
              className="text-[0.6875rem] uppercase text-fg-muted font-semibold"
              htmlFor="log-container"
            >
              Container
            </label>
            <select
              id="log-container"
              value={container}
              onChange={(e) => {
                setContainer(e.target.value);
                applyFilters(undefined, undefined, e.target.value);
              }}
              className="rounded-sm border border-border-default bg-inset text-fg-primary text-xs px-1.5 py-0.5 max-w-[180px]"
            >
              <option value="">All containers</option>
              {(state?.containers ?? []).map((target) => (
                <option key={target.name} value={target.name}>
                  {target.name}
                </option>
              ))}
              {container &&
                !(state?.containers ?? []).some((target) => target.name === container) && (
                  <option value={container}>{container}</option>
                )}
            </select>
          </div>
        )}
        <div className="flex items-center gap-1.5 flex-1 min-w-[120px]">
          <Search size={12} className="text-fg-muted shrink-0" />
          <input
            type="text"
            placeholder="Search logs..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyFilters();
            }}
            className="w-full rounded-sm border border-border-default bg-inset text-fg-primary text-xs px-1.5 py-0.5 outline-none focus:border-accent"
          />
        </div>
      </div>

      <LogEntries state={state} />
    </section>
  );
}

function LogEntries({ state }: { state: DeploymentLogState | undefined }) {
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
    <div className="grid gap-1">
      <div className="text-[0.6875rem] text-fg-muted">
        Showing {state.entries.length} fetched log entr{state.entries.length === 1 ? 'y' : 'ies'}
      </div>
      <div className="max-h-72 overflow-y-auto rounded-md border border-border-default bg-inset font-mono text-xs">
        {state.entries.map((entry, index) => (
          <div
            key={`${entry.timestamp}-${index}`}
            className="grid gap-0.5 px-2 py-1 border-b border-border-default last:border-b-0"
          >
            <div className="flex items-center gap-2 text-fg-muted flex-wrap">
              <span className="tabular-nums">{formatLogTimestamp(entry.timestamp)}</span>
              <span className="uppercase font-semibold">{entry.level}</span>
              <span className="truncate max-w-[120px]">{entry.source}</span>
            </div>
            <div className="text-fg-primary break-words overflow-hidden">{entry.message}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Metrics Panel ─────────────────────────────────────────────────────────

function DeploymentMetricsPanel({ state }: { state: DeploymentMetricsState | undefined }) {
  if (!state) return null;

  const info = state.systemInfo;
  const fallback = state.fallbackMetrics;
  const containers = info?.docker?.containerList ?? [];

  return (
    <section className="rounded-md border border-border-default bg-inset px-3 py-3 grid gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-fg-primary font-semibold text-sm">
          <RefreshCw size={15} />
          Metrics
        </div>
        {state.loading && <span className="text-xs text-fg-muted">Refreshing...</span>}
      </div>

      {state.error && <Alert variant="error">{state.error}</Alert>}

      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-sm border border-border-default px-2 py-1.5">
          <div className="text-[0.6875rem] uppercase text-fg-muted font-semibold">CPU</div>
          <div className="text-sm text-fg-primary truncate">
            {info ? info.cpu.loadAvg1.toFixed(2) : (fallback?.cpuLoadAvg1?.toFixed(2) ?? '-')}
          </div>
        </div>
        <div className="rounded-sm border border-border-default px-2 py-1.5">
          <div className="text-[0.6875rem] uppercase text-fg-muted font-semibold">Memory</div>
          <div className="text-sm text-fg-primary truncate">
            {info ? safePercent(info.memory.usedPercent) : safePercent(fallback?.memoryPercent)}
          </div>
        </div>
        <div className="rounded-sm border border-border-default px-2 py-1.5">
          <div className="text-[0.6875rem] uppercase text-fg-muted font-semibold">Disk</div>
          <div className="text-sm text-fg-primary truncate">
            {info ? safePercent(info.disk.usedPercent) : safePercent(fallback?.diskPercent)}
          </div>
        </div>
      </div>

      {!info && state.unavailableReason && (
        <div className="text-xs text-fg-muted">
          Live metrics unavailable: {state.unavailableReason.replace(/_/g, ' ')}.
        </div>
      )}

      <div className="grid gap-2">
        <div className="text-xs font-semibold uppercase text-fg-muted">Containers</div>
        {containers.length === 0 ? (
          <div className="text-xs text-fg-muted">No live container metrics available.</div>
        ) : (
          <div className="overflow-x-auto rounded-sm border border-border-default">
            <table className="w-full text-xs border-collapse">
              <thead className="text-fg-muted">
                <tr className="border-b border-border-default">
                  <th className="text-left font-semibold px-2 py-1">Name</th>
                  <th className="text-right font-semibold px-2 py-1">CPU</th>
                  <th className="text-right font-semibold px-2 py-1">Memory</th>
                  <th className="text-left font-semibold px-2 py-1">State</th>
                </tr>
              </thead>
              <tbody>
                {containers.map((container) => (
                  <tr
                    key={container.id || container.name}
                    className="border-b border-border-default last:border-b-0"
                  >
                    <td className="px-2 py-1 text-fg-primary max-w-[140px] truncate">
                      {container.name}
                    </td>
                    <td className="px-2 py-1 text-right text-fg-primary tabular-nums">
                      {safePercent(container.cpuPercent)}
                    </td>
                    <td className="px-2 py-1 text-right text-fg-primary tabular-nums">
                      {container.memUsage ? container.memUsage : safePercent(container.memPercent)}
                    </td>
                    <td className="px-2 py-1 text-fg-muted">{container.state}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {info && (
        <div className="text-[0.6875rem] text-fg-muted">
          Node memory {formatBytes(info.memory.usedBytes)} / {formatBytes(info.memory.totalBytes)}
        </div>
      )}
    </section>
  );
}

// ─── Main Card ─────────────────────────────────────────────────────────────

interface DeploymentEnvironmentCardProps {
  env: DeploymentEnvironment;
  profiles: AgentProfile[];
  policySaving: string | null;
  logState: DeploymentLogState | undefined;
  metricsState: DeploymentMetricsState | undefined;
  logsOpen: boolean;
  onPolicyEnabledChange: (env: DeploymentEnvironment, enabled: boolean) => void;
  onProfileToggle: (env: DeploymentEnvironment, profileId: string) => void;
  onRefreshLogs: (
    env: DeploymentEnvironment,
    opts?: { source?: string; level?: string; search?: string; container?: string }
  ) => void;
  onDelete: (env: DeploymentEnvironment) => void;
}

export function DeploymentEnvironmentCard({
  env,
  profiles,
  policySaving,
  logState,
  metricsState,
  logsOpen,
  onPolicyEnabledChange,
  onProfileToggle,
  onRefreshLogs,
  onDelete,
}: DeploymentEnvironmentCardProps) {
  const allowedProfiles = env.agentPolicy.allowedDeployProfileIds;
  const policyBusy = policySaving === env.id;

  return (
    <article className="glass-surface rounded-lg p-4 grid gap-4">
      <header className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="sam-type-section-heading m-0 text-fg-primary truncate max-w-[200px] sm:max-w-none">
              {env.name}
            </h2>
            <StatusBadge status={environmentBadgeStatus(env.status)} label={env.status} />
          </div>
          <ReleaseAttribution env={env} />
        </div>

        <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap sm:shrink-0">
          <Button size="sm" variant="secondary" onClick={() => onRefreshLogs(env)}>
            <ScrollText size={14} />
            {logsOpen ? 'Refresh Logs' : 'Logs'}
          </Button>
          <Button size="sm" variant="danger" onClick={() => onDelete(env)}>
            <Trash2 size={14} />
            Destroy Env
          </Button>
        </div>
      </header>

      <OperationalSummary env={env} />

      <DeploymentMetricsPanel state={metricsState} />

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(280px,360px)] gap-4">
        <section className="grid gap-3 content-start">
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
                  <Link
                    to={`/nodes/${env.node.id}`}
                    className="text-accent text-sm no-underline hover:underline truncate max-w-[180px]"
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
              <p className="m-0 text-xs text-fg-muted">
                No deployment node has been provisioned yet.
              </p>
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
                    <label
                      key={profile.id}
                      className="flex items-center gap-2 text-sm text-fg-primary"
                    >
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
        <LogsPanel
          state={logState}
          onRefresh={() => onRefreshLogs(env)}
          onRefreshFiltered={(opts) => onRefreshLogs(env, opts)}
        />
      )}
    </article>
  );
}
