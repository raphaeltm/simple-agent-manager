import type { TriggerExecutionResponse, TriggerResponse } from '@simple-agent-manager/shared';
import { Calendar, CheckCircle, XCircle } from 'lucide-react';
import type { FC } from 'react';

function formatDateFull(dateStr: string): string {
  return new Date(dateStr).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

function formatDuration(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt || !completedAt) return '—';
  const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (durationMs < 1000) return '<1s';
  const seconds = Math.floor(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return secs > 0 ? `${minutes}m ${secs}s` : `${minutes}m`;
}

function successRateColor(rate: number): string {
  if (rate >= 80) return 'var(--sam-color-success)';
  if (rate >= 50) return 'var(--sam-color-warning)';
  return 'var(--sam-color-danger)';
}

const CARD_CLASS = 'border border-border-default rounded-lg p-4';
const LABEL_CLASS = 'text-xs font-medium text-fg-muted uppercase tracking-wider m-0 mb-1';

interface TriggerSummaryCardsProps {
  trigger: TriggerResponse;
  /** Most recent finished execution, or null when the trigger has never run. */
  lastRun: TriggerExecutionResponse | null;
  /** Percentage of finished executions that completed, or null when there are none. */
  successRate: number | null;
}

/**
 * The Next Run / Last Run / Success Rate row on the trigger detail page.
 * Extracted so ProjectTriggerDetail stays under the file-size ceiling in
 * .claude/rules/18-file-size-limits.md.
 */
export const TriggerSummaryCards: FC<TriggerSummaryCardsProps> = ({
  trigger,
  lastRun,
  successRate,
}) => (
  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-8">
    <div className={CARD_CLASS}>
      <p className={LABEL_CLASS}>{trigger.sourceType === 'cron' ? 'Next Run' : 'Source'}</p>
      <p className="text-sm text-fg-primary m-0 flex items-center gap-1.5">
        <Calendar size={14} aria-hidden="true" />
        {trigger.sourceType === 'cron'
          ? trigger.nextFireAt
            ? formatDateFull(trigger.nextFireAt)
            : 'Not scheduled'
          : trigger.sourceType === 'webhook'
            ? 'Incoming webhook'
            : 'GitHub event'}
      </p>
    </div>

    <div className={CARD_CLASS}>
      <p className={LABEL_CLASS}>Last Run</p>
      {lastRun ? (
        <div className="flex items-center gap-1.5 text-sm">
          {lastRun.status === 'completed' ? (
            <CheckCircle size={14} className="text-success" aria-hidden="true" />
          ) : (
            <XCircle size={14} className="text-danger" aria-hidden="true" />
          )}
          <span className="text-fg-primary">{formatDateFull(lastRun.scheduledAt)}</span>
          <span className="text-fg-muted">
            ({formatDuration(lastRun.startedAt, lastRun.completedAt)})
          </span>
        </div>
      ) : (
        <p className="text-sm text-fg-muted m-0">Never run</p>
      )}
    </div>

    <div className={CARD_CLASS}>
      <p className={LABEL_CLASS}>Success Rate</p>
      {successRate !== null ? (
        <div>
          <p className="text-sm text-fg-primary m-0 mb-1">{successRate}%</p>
          <div className="h-1.5 bg-surface-hover rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{
                width: `${successRate}%`,
                backgroundColor: successRateColor(successRate),
              }}
            />
          </div>
        </div>
      ) : (
        <p className="text-sm text-fg-muted m-0">No data</p>
      )}
    </div>
  </div>
);
