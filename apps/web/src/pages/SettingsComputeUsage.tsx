import type { ComputeUsageResponse } from '@simple-agent-manager/shared';
import { Body, Card, CardTitle, SectionHeading, Spinner } from '@simple-agent-manager/ui';
import { Clock, Cpu, Server } from 'lucide-react';
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
        <Body className="text-[var(--sam-text-error)]">{error}</Body>
      </Card>
    );
  }

  if (!data) return null;

  const period = data.currentPeriod;
  const periodStart = new Date(period.start).toLocaleDateString();
  const periodEnd = new Date(period.end).toLocaleDateString();

  return (
    <div className="space-y-4">
      <div>
        <SectionHeading>Compute Usage</SectionHeading>
        <Body className="text-[var(--sam-text-secondary)] text-sm">
          Current billing period: {periodStart} &ndash; {periodEnd}
        </Body>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="p-3 text-center">
          <Cpu className="w-5 h-5 mx-auto mb-1 text-[var(--sam-text-secondary)]" />
          <Body className="font-semibold text-lg tabular-nums">{formatVcpuHours(period.totalVcpuHours)}</Body>
          <Body className="text-xs text-[var(--sam-text-secondary)]">Total vCPU-hrs</Body>
        </Card>
        <Card className="p-3 text-center">
          <Server className="w-5 h-5 mx-auto mb-1 text-[var(--sam-text-secondary)]" />
          <Body className="font-semibold text-lg tabular-nums">{formatVcpuHours(period.platformVcpuHours)}</Body>
          <Body className="text-xs text-[var(--sam-text-secondary)]">Platform</Body>
        </Card>
        <Card className="p-3 text-center">
          <Body className="font-semibold text-lg tabular-nums">{formatVcpuHours(period.userVcpuHours)}</Body>
          <Body className="text-xs text-[var(--sam-text-secondary)]">Your Keys (BYOC)</Body>
        </Card>
        <Card className="p-3 text-center">
          <Body className="font-semibold text-lg tabular-nums">{period.activeWorkspaces}</Body>
          <Body className="text-xs text-[var(--sam-text-secondary)]">Active Now</Body>
        </Card>
      </div>

      {data.activeSessions.length > 0 && (
        <Card className="p-4">
          <CardTitle className="mb-3">Active Workspaces</CardTitle>
          <div className="space-y-2">
            {data.activeSessions.map((session) => (
              <div
                key={session.workspaceId}
                className="flex items-center justify-between py-2 border-b border-[var(--sam-border-primary)] last:border-0"
              >
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0" />
                  <Body className="font-mono text-xs truncate max-w-[180px]">
                    {session.workspaceId}
                  </Body>
                </div>
                <div className="flex items-center gap-4 text-sm text-[var(--sam-text-secondary)]">
                  <Body>{session.serverType} ({session.vcpuCount} vCPU)</Body>
                  <Body className="capitalize">{session.credentialSource}</Body>
                  <div className="flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    <Body className="text-xs tabular-nums">{formatDuration(session.startedAt)}</Body>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {data.activeSessions.length === 0 && (
        <Card className="p-6 text-center">
          <Body className="text-[var(--sam-text-secondary)]">No active workspaces right now.</Body>
        </Card>
      )}
    </div>
  );
}
