import { type FC } from 'react';
import { Body } from '@simple-agent-manager/ui';

const FUNNEL_STEPS = ['signup', 'login', 'project_created', 'workspace_created', 'task_submitted'];
const FUNNEL_LABELS: Record<string, string> = {
  signup: 'Signup',
  login: 'Login',
  project_created: 'Project Created',
  workspace_created: 'Workspace Created',
  task_submitted: 'Task Submitted',
};

export const FunnelChart: FC<{ data: Array<{ event_name: string; unique_users: number }> }> = ({ data }) => {
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
            <div
              className="flex-1 h-8 bg-surface-secondary rounded-sm overflow-hidden"
              role="img"
              aria-label={`${step.label}: ${step.users.toLocaleString()} users${conversionRate ? `, ${conversionRate} conversion from previous step` : ''}`}
            >
              <div
                className="h-full bg-accent-emphasis rounded-sm transition-all"
                style={{ width: `${widthPercent}%` }}
                aria-hidden="true"
              />
            </div>
            <div className="w-16 text-xs text-fg-secondary tabular-nums text-right flex-shrink-0">
              {step.users.toLocaleString()}
            </div>
            {conversionRate ? (
              <div className="w-12 text-xs text-fg-muted text-right">{conversionRate}</div>
            ) : (
              <div className="w-12" aria-hidden="true" />
            )}
          </div>
        );
      })}
    </div>
  );
};
