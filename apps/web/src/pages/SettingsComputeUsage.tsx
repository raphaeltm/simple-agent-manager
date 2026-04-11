import type { ComputeUsageResponse } from '@simple-agent-manager/shared';
import { Body, Card, CardTitle, SectionHeading, Spinner } from '@simple-agent-manager/ui';
import { Clock, Cpu, Key, Server } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { fetchComputeUsage } from '../lib/api';

function formatVcpuHours(hours: number): string {
  if (hours < 0.01) return '< 0.01';
  return hours.toFixed(2);
}

function formatDuration(startedAt: string): string {
  const start = new Date(startedAt);
  const now = new Date();
  const hours = (now.getTime() - start.getTime()) / (1000 * 60 * 60);
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  return `${hours.toFixed(1)}h`;
}

export function SettingsComputeUsage() {
  const [data, setData] = useState<ComputeUsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadUsage = useCallback(async () => {
    try {
      setError(null);
      const res = await fetchComputeUsage();
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load usage data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadUsage();
  }, [loadUsage]);

  if (loading) {
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  }

  if (error) {
    return (
      <Card className="p-4">
        <p className="sam-type-body text-danger-fg m-0">{error}</p>
      </Card>
    );
  }

  if (!data) return null;

  const period = data.currentPeriod;
  const periodStart = new Date(period.start).toLocaleDateString();
  const periodEnd = new Date(period.end).toLocaleDateString();

  return (
    <div className="space-y-4 min-w-0 overflow-hidden">
      <div>
        <SectionHeading>Compute Usage</SectionHeading>
        <Body className="text-fg-muted text-sm">
          Current billing period: {periodStart} &ndash; {periodEnd}
        </Body>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="p-3 text-center">
          <Cpu className="w-5 h-5 mx-auto mb-1 text-fg-muted" aria-hidden="true" />
          <p className="sam-type-body font-semibold text-lg tabular-nums m-0">{formatVcpuHours(period.totalVcpuHours)}</p>
          <p className="sam-type-caption text-fg-muted m-0">Total vCPU-hrs</p>
        </Card>
        <Card className="p-3 text-center">
          <Server className="w-5 h-5 mx-auto mb-1 text-fg-muted" aria-hidden="true" />
          <p className="sam-type-body font-semibold text-lg tabular-nums m-0">{formatVcpuHours(period.platformVcpuHours)}</p>
          <p className="sam-type-caption text-fg-muted m-0">Platform</p>
        </Card>
        <Card className="p-3 text-center">
          <Key className="w-5 h-5 mx-auto mb-1 text-fg-muted" aria-hidden="true" />
          <p className="sam-type-body font-semibold text-lg tabular-nums m-0">{formatVcpuHours(period.userVcpuHours)}</p>
          <p className="sam-type-caption text-fg-muted m-0">Your Keys (BYOC)</p>
        </Card>
        <Card className="p-3 text-center">
          <span className="block w-5 h-5 mx-auto mb-1" aria-hidden="true">
            <span className="w-2 h-2 rounded-full bg-success block mx-auto mt-1.5" />
          </span>
          <p className="sam-type-body font-semibold text-lg tabular-nums m-0">{period.activeWorkspaces}</p>
          <p className="sam-type-caption text-fg-muted m-0">Active Now</p>
        </Card>
      </div>

      {data.activeSessions.length > 0 ? (
        <Card className="p-4 overflow-hidden w-full min-w-0">
          <CardTitle className="mb-3">Active Workspaces</CardTitle>
          <div className="space-y-0">
            {data.activeSessions.map((session) => (
              <div
                key={session.workspaceId}
                className="flex flex-col gap-1 py-3 border-b border-border-default last:border-0 min-w-0 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="w-2 h-2 rounded-full bg-success flex-shrink-0" aria-label="Running" />
                  <span className="font-mono sam-type-caption text-fg-primary truncate min-w-0 flex-1">
                    {session.workspaceId}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-4 sm:pl-0">
                  <span className="sam-type-caption text-fg-muted">{session.serverType} ({session.vcpuCount} vCPU)</span>
                  <span className="sam-type-caption text-fg-muted capitalize">{session.credentialSource}</span>
                  <span className="flex items-center gap-1 sam-type-caption text-fg-muted">
                    <Clock className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
                    <span className="tabular-nums">{formatDuration(session.startedAt)}</span>
                  </span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : (
        <Card className="p-6 text-center">
          <Body className="text-fg-muted">No active workspaces right now.</Body>
        </Card>
      )}
    </div>
  );
}
