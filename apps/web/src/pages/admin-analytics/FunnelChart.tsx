import { Body } from '@simple-agent-manager/ui';
import { type FC } from 'react';

const FUNNEL_STEPS = ['signup', 'login', 'project_created', 'workspace_created', 'task_submitted'];
const FUNNEL_LABELS: Record<string, string> = {
  signup: 'Signup',
  login: 'Login',
  project_created: 'Project Created',
  workspace_created: 'Workspace Created',
  task_submitted: 'Task Submitted',
};

/** Color scale: progressively less saturated as drop-off increases. */
const STEP_COLORS = [
  'var(--sam-color-accent-primary, #16a34a)',
  'var(--sam-color-success, #22c55e)',
  'var(--sam-color-warning, #f59e0b)',
  '#f97316',
  'var(--sam-color-danger, #ef4444)',
];

export const FunnelChart: FC<{ data: Array<{ event_name: string; unique_users: number }> }> = ({ data }) => {
  const dataMap = new Map(data.map((d) => [d.event_name, d.unique_users]));
  const steps = FUNNEL_STEPS.map((name) => ({
    name,
    label: FUNNEL_LABELS[name] ?? name,
    users: dataMap.get(name) ?? 0,
  }));

  const maxUsers = Math.max(...steps.map((s) => s.users), 1);

  if (steps.every((s) => s.users === 0)) {
    return <Body className="text-fg-muted">No funnel data available yet. Data appears after user signups.</Body>;
  }

  return (
    <div className="flex flex-col gap-1">
      {steps.map((step, i) => {
        const widthPercent = Math.max((step.users / maxUsers) * 100, 8);
        const prevUsers = i > 0 ? (steps[i - 1]?.users ?? 0) : 0;
        const conversionRate = i > 0 && prevUsers > 0
          ? Math.round((step.users / prevUsers) * 100)
          : null;
        const firstStepUsers = steps[0]?.users ?? 0;
        const overallRate = firstStepUsers > 0
          ? Math.round((step.users / firstStepUsers) * 100)
          : 0;
        const color = STEP_COLORS[i] ?? STEP_COLORS[STEP_COLORS.length - 1];

        return (
          <div
            key={step.name}
            className="flex items-center gap-3 group"
            role="img"
            aria-label={`${step.label}: ${step.users.toLocaleString()} users${conversionRate !== null ? `, ${conversionRate}% from previous step` : ''}`}
          >
            <div className="w-32 sm:w-36 text-sm text-fg-secondary truncate">{step.label}</div>
            <div className="flex-1 flex items-center">
              {/* Narrowing funnel bar — centered for visual funnel effect */}
              <div className="w-full flex justify-center">
                <div
                  className="h-10 rounded-md transition-all relative flex items-center justify-end pr-3"
                  style={{
                    width: `${widthPercent}%`,
                    backgroundColor: color,
                    minWidth: '60px',
                  }}
                >
                  <span className="text-xs font-semibold text-white tabular-nums drop-shadow-sm">
                    {step.users.toLocaleString()}
                  </span>
                </div>
              </div>
            </div>
            <div className="w-20 text-right flex-shrink-0">
              {conversionRate !== null ? (
                <div className="flex flex-col items-end">
                  <span className="text-xs font-medium text-fg-secondary tabular-nums">{conversionRate}%</span>
                  <span className="text-[10px] text-fg-muted tabular-nums">{overallRate}% overall</span>
                </div>
              ) : (
                <span className="text-xs text-fg-muted">baseline</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};
