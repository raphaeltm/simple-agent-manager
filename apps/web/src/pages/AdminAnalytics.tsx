import { type FC } from 'react';
import { Card, Spinner, Button, Body } from '@simple-agent-manager/ui';
import { useAdminAnalytics } from '../hooks/useAdminAnalytics';

// ---------------------------------------------------------------------------
// DAU Chart (simple bar-based visualization)
// ---------------------------------------------------------------------------

const DauChart: FC<{ data: Array<{ date: string; unique_users: number }> }> = ({ data }) => {
  if (!data.length) {
    return <Body className="text-fg-muted">No DAU data available yet.</Body>;
  }

  const maxUsers = Math.max(...data.map((d) => d.unique_users), 1);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-end gap-[2px] h-32">
        {data.map((d) => {
          const height = Math.max((d.unique_users / maxUsers) * 100, 2);
          return (
            <div
              key={d.date}
              className="flex-1 bg-accent-emphasis rounded-t-sm min-w-[4px] transition-all"
              style={{ height: `${height}%` }}
              title={`${d.date}: ${d.unique_users} users`}
            />
          );
        })}
      </div>
      <div className="flex justify-between text-xs text-fg-muted">
        <span>{data[0]?.date ?? ''}</span>
        <span>{data[data.length - 1]?.date ?? ''}</span>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Top Events Table
// ---------------------------------------------------------------------------

const EventsTable: FC<{ data: Array<{ event_name: string; count: number; unique_users: number; avg_response_ms: number }> }> = ({ data }) => {
  if (!data.length) {
    return <Body className="text-fg-muted">No event data available yet.</Body>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border-default text-left text-fg-muted">
            <th className="py-2 pr-4 font-medium">Event</th>
            <th className="py-2 pr-4 font-medium text-right">Count</th>
            <th className="py-2 pr-4 font-medium text-right">Users</th>
            <th className="py-2 font-medium text-right">Avg (ms)</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr key={row.event_name} className="border-b border-border-muted">
              <td className="py-2 pr-4 font-mono text-xs break-all">{row.event_name}</td>
              <td className="py-2 pr-4 text-right tabular-nums">{row.count.toLocaleString()}</td>
              <td className="py-2 pr-4 text-right tabular-nums">{row.unique_users.toLocaleString()}</td>
              <td className="py-2 text-right tabular-nums">{Math.round(row.avg_response_ms)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Conversion Funnel
// ---------------------------------------------------------------------------

const FUNNEL_STEPS = ['signup', 'login', 'project_created', 'workspace_created', 'task_submitted'];
const FUNNEL_LABELS: Record<string, string> = {
  signup: 'Signup',
  login: 'Login',
  project_created: 'Project Created',
  workspace_created: 'Workspace Created',
  task_submitted: 'Task Submitted',
};

const FunnelChart: FC<{ data: Array<{ event_name: string; unique_users: number }> }> = ({ data }) => {
  const dataMap = new Map(data.map((d) => [d.event_name, d.unique_users]));
  const steps = FUNNEL_STEPS.map((name) => ({
    name,
    label: FUNNEL_LABELS[name] ?? name,
    users: dataMap.get(name) ?? 0,
  }));

  const maxUsers = Math.max(...steps.map((s) => s.users), 1);

  if (steps.every((s) => s.users === 0)) {
    return <Body className="text-fg-muted">No funnel data available yet.</Body>;
  }

  return (
    <div className="flex flex-col gap-2">
      {steps.map((step, i) => {
        const widthPercent = Math.max((step.users / maxUsers) * 100, 5);
        const prevUsers = i > 0 ? (steps[i - 1]?.users ?? 0) : 0;
        const conversionRate = i > 0 && prevUsers > 0
          ? `${Math.round((step.users / prevUsers) * 100)}%`
          : '';

        return (
          <div key={step.name} className="flex items-center gap-3">
            <div className="w-36 text-sm text-fg-secondary truncate">{step.label}</div>
            <div className="flex-1 h-8 bg-surface-secondary rounded-sm overflow-hidden">
              <div
                className="h-full bg-accent-emphasis rounded-sm flex items-center px-2 text-xs text-white font-medium transition-all"
                style={{ width: `${widthPercent}%`, minWidth: 'fit-content' }}
              >
                {step.users.toLocaleString()}
              </div>
            </div>
            {conversionRate && (
              <div className="w-12 text-xs text-fg-muted text-right">{conversionRate}</div>
            )}
          </div>
        );
      })}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Period Selector
// ---------------------------------------------------------------------------

const PERIODS = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
];

const PeriodSelector: FC<{ value: string; onChange: (v: string) => void }> = ({ value, onChange }) => (
  <div className="flex gap-1">
    {PERIODS.map((p) => (
      <button
        key={p.value}
        onClick={() => onChange(p.value)}
        className={`px-3 py-1 text-xs rounded-sm border transition-colors ${
          value === p.value
            ? 'bg-accent-emphasis text-white border-accent-emphasis'
            : 'border-border-default text-fg-secondary hover:bg-surface-secondary'
        }`}
      >
        {p.label}
      </button>
    ))}
  </div>
);

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export function AdminAnalytics() {
  const {
    dau,
    events,
    funnel,
    loading,
    isRefreshing,
    error,
    eventPeriod,
    setEventPeriod,
    refresh,
  } = useAdminAnalytics();

  if (error && !dau && !events && !funnel) {
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

  if (loading && !dau) {
    return (
      <div className="flex justify-center p-8">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header with refresh indicator */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-fg-primary">Analytics</h2>
          {isRefreshing && <Spinner size="sm" />}
        </div>
        <Button size="sm" variant="secondary" onClick={refresh}>
          Refresh
        </Button>
      </div>

      {/* DAU Chart */}
      <Card>
        <div className="p-4">
          <h3 className="text-sm font-medium text-fg-secondary mb-3">
            Daily Active Users ({dau?.periodDays ?? 30}d)
          </h3>
          <DauChart data={dau?.dau ?? []} />
        </div>
      </Card>

      {/* Top Events */}
      <Card>
        <div className="p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-fg-secondary">Top Events</h3>
            <PeriodSelector value={eventPeriod} onChange={setEventPeriod} />
          </div>
          <EventsTable data={events?.events ?? []} />
        </div>
      </Card>

      {/* Conversion Funnel */}
      <Card>
        <div className="p-4">
          <h3 className="text-sm font-medium text-fg-secondary mb-3">
            Conversion Funnel ({funnel?.periodDays ?? 30}d)
          </h3>
          <FunnelChart data={funnel?.funnel ?? []} />
        </div>
      </Card>
    </div>
  );
}
