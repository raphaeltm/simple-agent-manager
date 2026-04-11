import type { AdminComputeUsageResponse, AdminUserDetailedUsage, AdminUserUsageSummary } from '@simple-agent-manager/shared';
import { Body, Card, CardTitle, SectionHeading, Spinner } from '@simple-agent-manager/ui';
import { ArrowLeft, Clock, Cpu, Key, Server } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchAdminComputeUsage, fetchAdminUserComputeUsage } from '../lib/api';

function formatVcpuHours(hours: number): string {
  if (hours < 0.01) return '< 0.01';
  return hours.toFixed(2);
}

function formatDuration(startedAt: string, endedAt: string | null): string {
  const start = new Date(startedAt);
  const end = endedAt ? new Date(endedAt) : new Date();
  const hours = (end.getTime() - start.getTime()) / (1000 * 60 * 60);
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  return `${hours.toFixed(1)}h`;
}

function UserRow({ user, onSelect }: { user: AdminUserUsageSummary; onSelect: () => void }) {
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
        {/* Stats shown inline on mobile below the name */}
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 sm:hidden">
          <span className="sam-type-caption text-fg-primary tabular-nums font-medium">
            {formatVcpuHours(user.totalVcpuHours)} vCPU-hrs
          </span>
          {user.activeWorkspaces > 0 && (
            <span className="sam-type-caption flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-success inline-block" aria-hidden="true" />
              <span className="text-fg-muted">{user.activeWorkspaces} active</span>
            </span>
          )}
        </div>
      </div>

      {/* Stats shown to the right on sm+ only */}
      <div className="hidden sm:flex items-center gap-6 flex-shrink-0 text-right">
        <div>
          <p className="sam-type-body font-medium tabular-nums m-0">{formatVcpuHours(user.totalVcpuHours)}</p>
          <p className="sam-type-caption text-fg-muted m-0">vCPU-hrs</p>
        </div>
        <div className="text-right">
          <p className="sam-type-caption text-fg-muted tabular-nums m-0">
            {formatVcpuHours(user.platformVcpuHours)} platform
          </p>
          <p className="sam-type-caption text-fg-muted tabular-nums m-0">
            {formatVcpuHours(user.userVcpuHours)} BYOC
          </p>
        </div>
        {user.activeWorkspaces > 0 && (
          <div className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-success" aria-hidden="true" />
            <span className="sam-type-caption text-fg-muted">{user.activeWorkspaces}</span>
          </div>
        )}
      </div>
    </button>
  );
}

function UserDetail({ userId, onBack }: { userId: string; onBack: () => void }) {
  const [data, setData] = useState<AdminUserDetailedUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetchAdminUserComputeUsage(userId)
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
          <Cpu className="w-5 h-5 mx-auto mb-1 text-fg-muted" aria-hidden="true" />
          <p className="sam-type-body font-semibold text-lg tabular-nums m-0">{formatVcpuHours(data.currentPeriod.totalVcpuHours)}</p>
          <p className="sam-type-caption text-fg-muted m-0">Total vCPU-hrs</p>
        </Card>
        <Card className="p-3 text-center">
          <Server className="w-5 h-5 mx-auto mb-1 text-fg-muted" aria-hidden="true" />
          <p className="sam-type-body font-semibold text-lg tabular-nums m-0">{formatVcpuHours(data.currentPeriod.platformVcpuHours)}</p>
          <p className="sam-type-caption text-fg-muted m-0">Platform</p>
        </Card>
        <Card className="p-3 text-center">
          <Key className="w-5 h-5 mx-auto mb-1 text-fg-muted" aria-hidden="true" />
          <p className="sam-type-body font-semibold text-lg tabular-nums m-0">{formatVcpuHours(data.currentPeriod.userVcpuHours)}</p>
          <p className="sam-type-caption text-fg-muted m-0">BYOC</p>
        </Card>
        <Card className="p-3 text-center">
          <span className="block w-5 h-5 mx-auto mb-1" aria-hidden="true">
            <span className="w-2 h-2 rounded-full bg-success block mx-auto mt-1.5" />
          </span>
          <p className="sam-type-body font-semibold text-lg tabular-nums m-0">{data.currentPeriod.activeWorkspaces}</p>
          <p className="sam-type-caption text-fg-muted m-0">Active</p>
        </Card>
      </div>

      {data.activeSessions.length > 0 && (
        <Card className="p-4 overflow-hidden w-full min-w-0">
          <CardTitle className="mb-3">Active Sessions</CardTitle>
          <div className="space-y-3">
            {data.activeSessions.map((s) => (
              <div key={s.workspaceId} className="flex flex-col gap-1 min-w-0 sm:flex-row sm:items-center sm:justify-between sm:gap-3 border-b border-border-default pb-3 last:border-0 last:pb-0">
                <span className="font-mono sam-type-caption text-fg-primary truncate min-w-0 sm:w-auto sm:max-w-[50%] sm:flex-shrink-0">{s.workspaceId}</span>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="sam-type-caption text-fg-muted">{s.serverType} ({s.vcpuCount} vCPU)</span>
                  <span className="sam-type-caption text-fg-muted capitalize">{s.credentialSource}</span>
                  <span className="flex items-center gap-1 sam-type-caption text-fg-muted">
                    <Clock className="w-3 h-3" aria-hidden="true" />
                    <span className="tabular-nums">{formatDuration(s.startedAt, null)}</span>
                  </span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card className="p-4">
        <CardTitle className="mb-3">Recent Records</CardTitle>
        {data.recentRecords.length === 0 ? (
          <p className="sam-type-body text-fg-muted m-0">No usage records.</p>
        ) : (
          <div className="overflow-x-auto -mx-4 px-4">
            <table className="w-full text-sm min-w-[480px]">
              <thead>
                <tr className="text-left text-fg-muted border-b border-border-default">
                  <th className="py-2 pr-3 font-medium sam-type-caption">Workspace</th>
                  <th className="py-2 pr-3 font-medium sam-type-caption">Size</th>
                  <th className="py-2 pr-3 font-medium sam-type-caption">vCPU</th>
                  <th className="py-2 pr-3 font-medium sam-type-caption">Source</th>
                  <th className="py-2 pr-3 font-medium sam-type-caption">Duration</th>
                  <th className="py-2 font-medium sam-type-caption">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.recentRecords.map((r) => (
                  <tr key={r.id} className="border-b border-border-default last:border-0">
                    <td className="py-2 pr-3 font-mono sam-type-caption text-fg-primary">{r.workspaceId.slice(0, 12)}&hellip;</td>
                    <td className="py-2 pr-3 sam-type-caption">{r.serverType}</td>
                    <td className="py-2 pr-3 tabular-nums sam-type-caption">{r.vcpuCount}</td>
                    <td className="py-2 pr-3 sam-type-caption capitalize">{r.credentialSource}</td>
                    <td className="py-2 pr-3 tabular-nums sam-type-caption">{formatDuration(r.startedAt, r.endedAt)}</td>
                    <td className="py-2">
                      {r.endedAt ? (
                        <span className="sam-type-caption text-fg-muted">Ended</span>
                      ) : (
                        <span className="flex items-center gap-1.5 sam-type-caption">
                          <span className="w-1.5 h-1.5 rounded-full bg-success flex-shrink-0" aria-hidden="true" />
                          Running
                        </span>
                      )}
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
  const [data, setData] = useState<AdminComputeUsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const hasLoadedRef = useRef(false);

  const loadData = useCallback(async () => {
    try {
      setError(null);
      const res = await fetchAdminComputeUsage();
      setData(res);
      hasLoadedRef.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load compute usage');
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
        <SectionHeading>Compute Usage</SectionHeading>
        <Body className="text-fg-muted text-sm">
          Period: {periodStart} &ndash; {periodEnd}
        </Body>
      </div>

      {data.users.length === 0 ? (
        <Card className="p-6 text-center">
          <Cpu className="w-8 h-8 mx-auto mb-2 text-fg-muted" aria-hidden="true" />
          <Body className="text-fg-muted">No compute usage this period.</Body>
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
