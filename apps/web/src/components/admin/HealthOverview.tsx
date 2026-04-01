import { Body,Button, Card, Spinner } from '@simple-agent-manager/ui';
import { type FC } from 'react';

import { useAdminHealth } from '../../hooks/useAdminHealth';

interface MetricCardProps {
  label: string;
  value: number;
  metricKey: string;
  warning?: boolean;
}

const MetricCard: FC<MetricCardProps> = ({ label, value, metricKey, warning }) => (
  <div
    data-metric={metricKey}
    className={`flex-[1_1_140px] p-4 rounded-sm border border-border-default text-center ${
      warning ? 'bg-danger-tint' : 'bg-surface'
    }`}
  >
    <div
      className={`text-[2rem] font-bold leading-tight ${
        warning ? 'text-danger-fg' : 'text-fg-primary'
      }`}
      style={{ fontVariantNumeric: 'tabular-nums' }}
    >
      {value}
    </div>
    <div className="text-xs text-fg-muted mt-1">
      {label}
    </div>
  </div>
);

const ERROR_WARNING_THRESHOLD = 10;

export const HealthOverview: FC = () => {
  const { health, loading, isRefreshing, error, refresh } = useAdminHealth();

  if (error && !health) {
    return (
      <Card>
        <div className="p-4 flex flex-col items-center gap-3">
          <Body className="text-danger-fg">{error}</Body>
          <Button size="sm" variant="secondary" onClick={refresh}>
            Retry
          </Button>
        </div>
      </Card>
    );
  }

  if (loading && !health) {
    return (
      <div className="flex justify-center p-8">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!health) return null;

  const lastUpdated = new Date(health.timestamp).toLocaleTimeString();

  return (
    <Card>
      <div className="p-4">
        {/* Header */}
        <div className="flex justify-between items-center mb-4">
          <Body className="text-fg-muted text-xs">
            Last updated: {lastUpdated}
          </Body>
          <div className="flex items-center gap-2">
            {isRefreshing && <Spinner size="sm" />}
            <Button size="sm" variant="ghost" onClick={refresh} disabled={loading || isRefreshing}>
              Refresh
            </Button>
          </div>
        </div>

        {/* Metric cards grid */}
        <div className="flex flex-wrap gap-3">
          <MetricCard
            label="Active Nodes"
            value={health.activeNodes}
            metricKey="activeNodes"
          />
          <MetricCard
            label="Active Workspaces"
            value={health.activeWorkspaces}
            metricKey="activeWorkspaces"
          />
          <MetricCard
            label="In-Progress Tasks"
            value={health.inProgressTasks}
            metricKey="inProgressTasks"
          />
          <MetricCard
            label="Errors (24h)"
            value={health.errorCount24h}
            metricKey="errorCount24h"
            warning={health.errorCount24h >= ERROR_WARNING_THRESHOLD}
          />
        </div>
      </div>
    </Card>
  );
};
