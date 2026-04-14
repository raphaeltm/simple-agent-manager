import type { AdminNodeUsageResponse, AdminUserNodeDetailedUsage, AdminUserNodeUsageSummary, NodeUsageRecord } from '@simple-agent-manager/shared';
import { Body, Card, CardTitle, SectionHeading, Spinner } from '@simple-agent-manager/ui';
import { ArrowLeft, Clock, Cpu, HardDrive, Server } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchAdminNodeUsage, fetchAdminUserNodeUsage } from '../lib/api';

function formatHours(hours: number): string {
  if (hours < 0.01) return '< 0.01';
  return hours.toFixed(2);
}

function formatDuration(startedAt: string, endedAt: string | null): string {
  const start = new Date(startedAt);
  const end = endedAt ? new Date(endedAt) : new Date();
  const totalMs = end.getTime() - start.getTime();
  const hours = totalMs / (1000 * 60 * 60);
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return `${days}d ${remainingHours.toFixed(0)}h`;
}

function NodeStatusBadge({ status }: { status: string }) {
  const isActive = !['destroyed', 'destroying', 'deleted', 'error'].includes(status);
  return (
    <span className={`inline-flex items-center gap-1.5 sam-type-caption ${isActive ? 'text-success-fg' : 'text-fg-muted'}`}>
      {isActive && (
        <span className="w-1.5 h-1.5 rounded-full bg-success flex-shrink-0" aria-hidden="true" />
      )}
      {status}
    </span>
  );
}

function UserRow({ user, onSelect }: { user: AdminUserNodeUsageSummary; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="w-full text-left px-4 py-3 hover:bg-surface-hover transition-colors border-b border-border-default flex items-start gap-3 sm:items-center sm:gap-4"
    >
      {user.avatarUrl ? (
        <img src={user.avatarUrl} alt="" className="w-8 h-8 rounded-full flex-shrink-0 mt-0.5 sm:mt-0" />
      ) : (
        <div className="w-8 h-8 rounded-full bg-surface flex items-center justify-center flex-shrink-0 mt-0.5 sm:mt-0 border border-border-default">
          <span className="text-fg-muted text-xs font-medium">
            {(user.name ?? user.email ?? '?')[0]?.toUpperCase()}
          </span>
        </div>
      )}

      <div className="flex-1 min-w-0">
        <p className="sam-type-body font-medium truncate m-0">{user.name ?? user.email ?? user.userId}</p>
        {user.name && user.email && (
          <p className="sam-type-caption text-fg-muted truncate m-0">{user.email}</p>
        )}
        {/* Stats inline on mobile */}
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 sm:hidden">
          <span className="sam-type-caption text-fg-primary tabular-nums font-medium">
            {formatHours(user.totalNodeHours)} node-hrs
          </span>
          <span className="sam-type-caption text-fg-muted tabular-nums">
            {formatHours(user.totalVcpuHours)} vCPU-hrs
          </span>
          {user.activeNodes > 0 && (
            <span className="sam-type-caption flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-success inline-block" aria-hidden="true" />
              <span className="text-fg-muted">{user.activeNodes} active</span>
            </span>
          )}
        </div>
      </div>

      {/* Stats on desktop */}
      <div className="hidden sm:flex items-center gap-6 flex-shrink-0 text-right">
        <div>
          <p className="sam-type-body font-medium tabular-nums m-0">{formatHours(user.totalNodeHours)}</p>
          <p className="sam-type-caption text-fg-muted m-0">node-hrs</p>
        </div>
        <div>
          <p className="sam-type-body tabular-nums m-0">{formatHours(user.totalVcpuHours)}</p>
          <p className="sam-type-caption text-fg-muted m-0">vCPU-hrs</p>
        </div>
        <div className="text-right">
          <p className="sam-type-caption text-fg-muted tabular-nums m-0">
            {formatHours(user.platformNodeHours)} platform
          </p>
        </div>
        {user.activeNodes > 0 && (
          <div className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-success" aria-hidden="true" />
            <span className="sam-type-caption text-fg-muted">{user.activeNodes}</span>
          </div>
        )}
      </div>
    </button>
  );
}

function UserDetail({ userId, onBack }: { userId: string; onBack: () => void }) {
  const [data, setData] = useState<AdminUserNodeDetailedUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetchAdminUserNodeUsage(userId)
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, [userId]);

  if (loading) return <div className="flex justify-center py-12"><Spinner /></div>;
  if (error) return <p className="sam-type-body text-danger-fg py-4 m-0">{error}</p>;
  if (!data) return null;

  return (
    <div className="space-y-4 min-w-0 overflow-hidden">
      <button
        type="button"
        onClick={onBack}
        aria-label="Back to all users"
        className="flex items-center gap-1.5 sam-type-secondary text-fg-muted hover:text-fg-primary transition-colors min-h-[44px] sm:min-h-0"
      >
        <ArrowLeft className="w-4 h-4" aria-hidden="true" />
        <span>Back to all users</span>
      </button>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="p-3 text-center">
          <Server className="w-5 h-5 mx-auto mb-1 text-fg-muted" aria-hidden="true" />
          <p className="sam-type-body font-semibold text-lg tabular-nums m-0">{formatHours(data.totalNodeHours)}</p>
          <p className="sam-type-caption text-fg-muted m-0">Node-hrs</p>
        </Card>
        <Card className="p-3 text-center">
          <Cpu className="w-5 h-5 mx-auto mb-1 text-fg-muted" aria-hidden="true" />
          <p className="sam-type-body font-semibold text-lg tabular-nums m-0">{formatHours(data.totalVcpuHours)}</p>
          <p className="sam-type-caption text-fg-muted m-0">vCPU-hrs</p>
        </Card>
        <Card className="p-3 text-center">
          <HardDrive className="w-5 h-5 mx-auto mb-1 text-fg-muted" aria-hidden="true" />
          <p className="sam-type-body font-semibold text-lg tabular-nums m-0">{formatHours(data.platformNodeHours)}</p>
          <p className="sam-type-caption text-fg-muted m-0">Platform</p>
        </Card>
        <Card className="p-3 text-center">
          <span className="block w-5 h-5 mx-auto mb-1" aria-hidden="true">
            <span className="w-2 h-2 rounded-full bg-success block mx-auto mt-1.5" />
          </span>
          <p className="sam-type-body font-semibold text-lg tabular-nums m-0">{data.activeNodes}</p>
          <p className="sam-type-caption text-fg-muted m-0">Active Nodes</p>
        </Card>
      </div>

      <Card className="p-4">
        <CardTitle className="mb-3">Nodes</CardTitle>
        {data.nodes.length === 0 ? (
          <p className="sam-type-body text-fg-muted m-0">No nodes this period.</p>
        ) : (
          <div className="overflow-x-auto -mx-4 px-4">
            <table className="w-full text-sm min-w-[580px]">
              <thead>
                <tr className="text-left text-fg-muted border-b border-border-default">
                  <th className="py-2 pr-3 font-medium sam-type-caption">Node</th>
                  <th className="py-2 pr-3 font-medium sam-type-caption">Size</th>
                  <th className="py-2 pr-3 font-medium sam-type-caption">vCPUs</th>
                  <th className="py-2 pr-3 font-medium sam-type-caption">Location</th>
                  <th className="py-2 pr-3 font-medium sam-type-caption">Source</th>
                  <th className="py-2 pr-3 font-medium sam-type-caption">Workspaces</th>
                  <th className="py-2 pr-3 font-medium sam-type-caption">Uptime</th>
                  <th className="py-2 font-medium sam-type-caption">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.nodes.map((n: NodeUsageRecord) => (
                  <tr key={n.nodeId} className="border-b border-border-default last:border-0">
                    <td className="py-2 pr-3">
                      <div className="font-mono sam-type-caption text-fg-primary truncate max-w-[140px]" title={n.nodeId}>
                        {n.name}
                      </div>
                      <div className="font-mono sam-type-caption text-fg-muted truncate max-w-[140px]" title={n.nodeId}>
                        {n.nodeId.slice(0, 12)}&hellip;
                      </div>
                    </td>
                    <td className="py-2 pr-3 sam-type-caption">{n.vmSize}</td>
                    <td className="py-2 pr-3 tabular-nums sam-type-caption">{n.vcpuCount}</td>
                    <td className="py-2 pr-3 sam-type-caption">{n.vmLocation}</td>
                    <td className="py-2 pr-3 sam-type-caption capitalize">{n.credentialSource}</td>
                    <td className="py-2 pr-3 tabular-nums sam-type-caption">{n.workspaceCount}</td>
                    <td className="py-2 pr-3 sam-type-caption">
                      <span className="flex items-center gap-1 tabular-nums">
                        <Clock className="w-3 h-3 text-fg-muted" aria-hidden="true" />
                        {formatDuration(n.createdAt, n.endedAt)}
                      </span>
                    </td>
                    <td className="py-2">
                      <NodeStatusBadge status={n.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

export function AdminComputeUsage() {
  const [data, setData] = useState<AdminNodeUsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const hasLoadedRef = useRef(false);

  const loadData = useCallback(async () => {
    try {
      setError(null);
      const res = await fetchAdminNodeUsage();
      setData(res);
      hasLoadedRef.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load usage data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  if (selectedUser) {
    return <UserDetail userId={selectedUser} onBack={() => setSelectedUser(null)} />;
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }

  if (error) {
    return <p className="sam-type-body text-danger-fg py-4 m-0">{error}</p>;
  }

  if (!data) return null;

  const periodStart = new Date(data.period.start).toLocaleDateString();
  const periodEnd = new Date(data.period.end).toLocaleDateString();

  return (
    <div className="space-y-4 min-w-0 overflow-hidden">
      <div>
        <SectionHeading>Node Usage</SectionHeading>
        <Body className="text-fg-muted text-sm">
          Period: {periodStart} &ndash; {periodEnd}
        </Body>
      </div>

      {data.users.length === 0 ? (
        <Card className="p-6 text-center">
          <Server className="w-8 h-8 mx-auto mb-2 text-fg-muted" aria-hidden="true" />
          <Body className="text-fg-muted">No node usage this period.</Body>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="px-4 py-3 border-b border-border-default flex items-center justify-between sam-type-caption text-fg-muted">
            <span>User</span>
            <span className="hidden sm:block">Usage</span>
          </div>
          {data.users.map((user) => (
            <UserRow key={user.userId} user={user} onSelect={() => setSelectedUser(user.userId)} />
          ))}
        </Card>
      )}
    </div>
  );
}
