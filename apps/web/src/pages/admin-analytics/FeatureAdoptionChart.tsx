import { type FC } from 'react';
import { Body } from '@simple-agent-manager/ui';
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

interface Props {
  data: AnalyticsFeatureAdoptionResponse | null;
}

export const FeatureAdoptionChart: FC<Props> = ({ data }) => {
  if (!data?.totals?.length) {
    return <Body className="text-fg-muted">No feature adoption data available yet.</Body>;
  }

  const maxCount = Math.max(...data.totals.map((t) => t.count), 1);

  // Build sparkline data: group trend by event_name
  const trendByEvent = new Map<string, Array<{ date: string; count: number }>>();
  for (const row of data.trend ?? []) {
    if (!trendByEvent.has(row.event_name)) {
      trendByEvent.set(row.event_name, []);
    }
    trendByEvent.get(row.event_name)!.push({ date: row.date, count: row.count });
  }

  return (
    <div className="flex flex-col gap-2">
      {data.totals.map((item) => {
        const widthPercent = Math.max((item.count / maxCount) * 100, 3);
        const label = EVENT_LABELS[item.event_name] ?? item.event_name;
        const sparkData = trendByEvent.get(item.event_name) ?? [];

        return (
          <div key={item.event_name} className="flex items-center gap-3">
            <div className="w-36 text-sm text-fg-secondary truncate" title={item.event_name}>
              {label}
            </div>
            <div className="flex-1 flex items-center gap-2">
              {/* Bar track — count is shown outside the bar to avoid overflow on small values */}
              <div
                className="flex-1 h-7 bg-surface-secondary rounded-sm overflow-hidden"
                role="img"
                aria-label={`${label}: ${item.count.toLocaleString()} total events`}
              >
                <div
                  className="h-full bg-accent-emphasis rounded-sm transition-all"
                  style={{ width: `${widthPercent}%` }}
                  aria-hidden="true"
                />
              </div>
              <div className="w-12 text-xs text-fg-secondary tabular-nums text-right flex-shrink-0">
                {item.count.toLocaleString()}
              </div>
              {sparkData.length > 1 && <Sparkline data={sparkData} label={label} />}
            </div>
            <div className="w-16 text-xs text-fg-muted text-right tabular-nums">
              {item.unique_users.toLocaleString()} users
            </div>
          </div>
        );
      })}
    </div>
  );
};

const Sparkline: FC<{ data: Array<{ date: string; count: number }>; label: string }> = ({ data, label }) => {
  const max = Math.max(...data.map((d) => d.count), 1);
  const width = 60;
  const height = 20;
  const points = data.map((d, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - (d.count / max) * height;
    return `${x},${y}`;
  }).join(' ');

  // Build a human-readable trend summary for screen readers
  const first = data[0]?.count ?? 0;
  const last = data[data.length - 1]?.count ?? 0;
  const trend = last > first ? 'trending up' : last < first ? 'trending down' : 'flat';

  return (
    <svg
      width={width}
      height={height}
      className="flex-shrink-0"
      role="img"
      aria-label={`${label} trend over time: ${trend}`}
    >
      <title>{`${label} trend: ${trend} (from ${first} to ${last})`}</title>
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="text-accent-emphasis"
        aria-hidden="true"
      />
    </svg>
  );
};
