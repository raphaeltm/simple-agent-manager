import { type FC } from 'react';
import { Body } from '@simple-agent-manager/ui';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Cell,
} from 'recharts';
import type { AnalyticsFeatureAdoptionResponse } from '../../lib/api';

const EVENT_LABELS: Record<string, string> = {
  project_created: 'Create Project',
  project_deleted: 'Delete Project',
  workspace_created: 'Create Workspace',
  workspace_started: 'Start Workspace',
  workspace_stopped: 'Stop Workspace',
  task_submitted: 'Submit Task',
  task_completed: 'Task Completed',
  task_failed: 'Task Failed',
  node_created: 'Create Node',
  node_deleted: 'Delete Node',
  credential_saved: 'Save Credential',
  session_created: 'Create Session',
  settings_changed: 'Change Settings',
};

/** Categorical colors for bars. */
const BAR_COLORS = [
  'var(--sam-color-accent-primary, #16a34a)',
  'var(--sam-color-success, #22c55e)',
  '#60a5fa',
  '#a78bfa',
  'var(--sam-color-warning, #f59e0b)',
  '#f97316',
  '#ec4899',
  '#14b8a6',
  '#8b5cf6',
  '#06b6d4',
  '#84cc16',
  '#f43f5e',
  '#6366f1',
];

interface Props {
  data: AnalyticsFeatureAdoptionResponse | null;
}

/** Custom tooltip for feature adoption chart. */
function AdoptionTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: { label: string; count: number; unique_users: number } }> }) {
  if (!active || !payload?.length) return null;
  const d = payload[0]!.payload;
  return (
    <div className="rounded-md border border-border-default bg-surface-primary px-3 py-2 shadow-lg text-sm">
      <div className="text-fg-primary font-medium">{d.label}</div>
      <div className="text-fg-secondary tabular-nums">{d.count.toLocaleString()} events</div>
      <div className="text-fg-muted tabular-nums text-xs">{d.unique_users.toLocaleString()} unique users</div>
    </div>
  );
}

export const FeatureAdoptionChart: FC<Props> = ({ data }) => {
  if (!data?.totals?.length) {
    return <Body className="text-fg-muted">No feature adoption data available yet.</Body>;
  }

  const chartData = data.totals.map((item) => ({
    label: EVENT_LABELS[item.event_name] ?? item.event_name,
    event_name: item.event_name,
    count: item.count,
    unique_users: item.unique_users,
  }));

  const chartHeight = Math.max(200, chartData.length * 36);

  return (
    <div className="w-full" style={{ height: chartHeight }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData} layout="vertical" margin={{ top: 0, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--sam-color-border-default, #29423b)" strokeOpacity={0.3} horizontal={false} />
          <XAxis
            type="number"
            tick={{ fontSize: 11, fill: 'var(--sam-color-fg-muted, #9fb7ae)' }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            dataKey="label"
            type="category"
            width={120}
            tick={{ fontSize: 12, fill: 'var(--sam-color-fg-secondary, #c5d6cf)' }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip content={<AdoptionTooltip />} cursor={{ fill: 'var(--sam-color-bg-surface-hover, #1a2e29)', opacity: 0.5 }} />
          <Bar dataKey="count" radius={[0, 4, 4, 0]} maxBarSize={28}>
            {chartData.map((_, i) => (
              <Cell key={i} fill={BAR_COLORS[i % BAR_COLORS.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
};
