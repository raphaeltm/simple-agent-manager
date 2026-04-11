import type { AdminComputeUsageResponse, AdminUserDetailedUsage, AdminUserUsageSummary } from '@simple-agent-manager/shared';
import { Body, Card, CardTitle, SectionHeading, Spinner } from '@simple-agent-manager/ui';
import { ArrowLeft, Clock, Cpu, Server } from 'lucide-react';
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
      className="w-full text-left px-4 py-3 hover:bg-[var(--sam-bg-secondary)] transition-colors border-b border-[var(--sam-border-primary)] flex items-center gap-4"
    >
      {user.avatarUrl ? (
        <img src={user.avatarUrl} alt="" className="w-8 h-8 rounded-full flex-shrink-0" />
      ) : (
        <div className="w-8 h-8 rounded-full bg-[var(--sam-bg-tertiary)] flex items-center justify-center flex-shrink-0">
          <Body className="text-[var(--sam-text-secondary)] text-xs">
            {(user.name ?? user.email ?? '?')[0]?.toUpperCase()}
          </Body>
        </div>
      )}

      <div className="flex-1 min-w-0">
        <Body className="font-medium truncate">{user.name ?? user.email ?? user.userId}</Body>
        {user.name && user.email && (
          <Body className="text-[var(--sam-text-secondary)] text-xs truncate">{user.email}</Body>
        )}
      </div>

      <div className="flex items-center gap-6 flex-shrink-0 text-right">
        <div>
          <Body className="font-medium tabular-nums">{formatVcpuHours(user.totalVcpuHours)}</Body>
          <Body className="text-[var(--sam-text-secondary)] text-xs">vCPU-hrs</Body>
        </div>
        <div>
          <Body className="text-[var(--sam-text-secondary)] tabular-nums text-sm">
            {formatVcpuHours(user.platformVcpuHours)} platform
          </Body>
          <Body className="text-[var(--sam-text-secondary)] tabular-nums text-sm">
            {formatVcpuHours(user.userVcpuHours)} BYOC
          </Body>
        </div>
        {user.activeWorkspaces > 0 && (
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-green-500" />
            <Body className="text-xs">{user.activeWorkspaces}</Body>
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
  if (error) return <Body className="text-[var(--sam-text-error)] py-4">{error}</Body>;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1 text-sm text-[var(--sam-text-secondary)] hover:text-[var(--sam-text-primary)] transition-colors"
      >
        <ArrowLeft className="w-4 h-4" /> Back to all users
      </button>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="p-3 text-center">
          <Cpu className="w-5 h-5 mx-auto mb-1 text-[var(--sam-text-secondary)]" />
          <Body className="font-semibold text-lg tabular-nums">{formatVcpuHours(data.currentPeriod.totalVcpuHours)}</Body>
          <Body className="text-xs text-[var(--sam-text-secondary)]">Total vCPU-hrs</Body>
        </Card>
        <Card className="p-3 text-center">
          <Server className="w-5 h-5 mx-auto mb-1 text-[var(--sam-text-secondary)]" />
          <Body className="font-semibold text-lg tabular-nums">{formatVcpuHours(data.currentPeriod.platformVcpuHours)}</Body>
          <Body className="text-xs text-[var(--sam-text-secondary)]">Platform</Body>
        </Card>
        <Card className="p-3 text-center">
          <Body className="font-semibold text-lg tabular-nums">{formatVcpuHours(data.currentPeriod.userVcpuHours)}</Body>
          <Body className="text-xs text-[var(--sam-text-secondary)]">BYOC</Body>
        </Card>
        <Card className="p-3 text-center">
          <Body className="font-semibold text-lg tabular-nums">{data.currentPeriod.activeWorkspaces}</Body>
          <Body className="text-xs text-[var(--sam-text-secondary)]">Active</Body>
        </Card>
      </div>

      {data.activeSessions.length > 0 && (
        <Card className="p-4">
          <CardTitle className="mb-2">Active Sessions</CardTitle>
          <div className="space-y-2">
            {data.activeSessions.map((s) => (
              <div key={s.workspaceId} className="flex items-center justify-between text-sm">
                <Body className="font-mono text-xs truncate max-w-[200px]">{s.workspaceId}</Body>
                <div className="flex items-center gap-3">
                  <Body className="text-[var(--sam-text-secondary)]">{s.serverType} ({s.vcpuCount} vCPU)</Body>
                  <Body className="text-[var(--sam-text-secondary)]">{s.credentialSource}</Body>
                  <div className="flex items-center gap-1 text-[var(--sam-text-secondary)]">
                    <Clock className="w-3 h-3" />
                    <Body className="text-xs">{formatDuration(s.startedAt, null)}</Body>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card className="p-4">
        <CardTitle className="mb-2">Recent Records</CardTitle>
        {data.recentRecords.length === 0 ? (
          <Body className="text-[var(--sam-text-secondary)]">No usage records.</Body>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[var(--sam-text-secondary)] border-b border-[var(--sam-border-primary)]">
                  <th className="py-2 pr-3 font-medium">Workspace</th>
                  <th className="py-2 pr-3 font-medium">Size</th>
                  <th className="py-2 pr-3 font-medium">vCPU</th>
                  <th className="py-2 pr-3 font-medium">Source</th>
                  <th className="py-2 pr-3 font-medium">Duration</th>
                  <th className="py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.recentRecords.map((r) => (
                  <tr key={r.id} className="border-b border-[var(--sam-border-primary)]">
                    <td className="py-2 pr-3 font-mono text-xs truncate max-w-[150px]">{r.workspaceId.slice(0, 12)}...</td>
                    <td className="py-2 pr-3">{r.serverType}</td>
                    <td className="py-2 pr-3 tabular-nums">{r.vcpuCount}</td>
                    <td className="py-2 pr-3">{r.credentialSource}</td>
                    <td className="py-2 pr-3 tabular-nums">{formatDuration(r.startedAt, r.endedAt)}</td>
                    <td className="py-2">
                      {r.endedAt ? (
                        <span className="text-[var(--sam-text-secondary)]">Ended</span>
                      ) : (
                        <span className="flex items-center gap-1">
                          <span className="w-2 h-2 rounded-full bg-green-500" />
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
    return <Body className="text-[var(--sam-text-error)] py-4">{error}</Body>;
  }

  if (!data) return null;

  const periodStart = new Date(data.period.start).toLocaleDateString();
  const periodEnd = new Date(data.period.end).toLocaleDateString();

  return (
    <div className="space-y-4">
      <div>
        <SectionHeading>Compute Usage</SectionHeading>
        <Body className="text-[var(--sam-text-secondary)] text-sm">
          Period: {periodStart} &ndash; {periodEnd}
        </Body>
      </div>

      {data.users.length === 0 ? (
        <Card className="p-6 text-center">
          <Cpu className="w-8 h-8 mx-auto mb-2 text-[var(--sam-text-tertiary)]" />
          <Body className="text-[var(--sam-text-secondary)]">No compute usage this period.</Body>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--sam-border-primary)] flex items-center justify-between text-sm text-[var(--sam-text-secondary)]">
            <span>User</span>
            <span>Usage</span>
          </div>
          {data.users.map((user) => (
            <UserRow key={user.userId} user={user} onSelect={() => setSelectedUser(user.userId)} />
          ))}
        </Card>
      )}
    </div>
  );
}
