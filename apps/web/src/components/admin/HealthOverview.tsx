import { type FC } from 'react';
import { Card, Spinner, Button, Body } from '@simple-agent-manager/ui';
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
    style={{
      flex: '1 1 140px',
      padding: 'var(--sam-space-4)',
      borderRadius: 'var(--sam-radius-sm)',
      border: '1px solid var(--sam-color-border-default)',
      backgroundColor: warning ? 'rgba(239, 68, 68, 0.05)' : 'var(--sam-color-bg-surface)',
      textAlign: 'center',
    }}
  >
    <div
      style={{
        fontSize: '2rem',
        fontWeight: 700,
        fontVariantNumeric: 'tabular-nums',
        color: warning ? '#f87171' : 'var(--sam-color-fg-default)',
        lineHeight: 1.2,
      }}
    >
      {value}
    </div>
    <div
      style={{
        fontSize: 'var(--sam-type-caption-size)',
        color: 'var(--sam-color-fg-muted)',
        marginTop: 'var(--sam-space-1)',
      }}
    >
      {label}
    </div>
  </div>
);

const ERROR_WARNING_THRESHOLD = 10;

export const HealthOverview: FC = () => {
  const { health, loading, error, refresh } = useAdminHealth();

  if (error && !health) {
    return (
      <Card>
        <div
          style={{
            padding: 'var(--sam-space-4)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 'var(--sam-space-3)',
          }}
        >
          <Body style={{ color: '#f87171' }}>{error}</Body>
          <Button size="sm" variant="secondary" onClick={refresh}>
            Retry
          </Button>
        </div>
      </Card>
    );
  }

  if (loading && !health) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--sam-space-8)' }}>
        <Spinner size="lg" />
      </div>
    );
  }

  if (!health) return null;

  const lastUpdated = new Date(health.timestamp).toLocaleTimeString();

  return (
    <Card>
      <div style={{ padding: 'var(--sam-space-4)' }}>
        {/* Header */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 'var(--sam-space-4)',
          }}
        >
          <Body style={{ color: 'var(--sam-color-fg-muted)', fontSize: 'var(--sam-type-caption-size)' }}>
            Last updated: {lastUpdated}
          </Body>
          <Button size="sm" variant="ghost" onClick={refresh} disabled={loading}>
            Refresh
          </Button>
        </div>

        {/* Metric cards grid */}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--sam-space-3)',
          }}
        >
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
