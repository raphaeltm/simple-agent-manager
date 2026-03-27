import { type FC } from 'react';
import { Body } from '@simple-agent-manager/ui';
import type { AnalyticsRetentionResponse } from '../../lib/api';

interface Props {
  data: AnalyticsRetentionResponse | null;
}

/** Map a retention rate (0-100) to a background color class for the heat map. */
function retentionColor(rate: number): string {
  if (rate >= 80) return 'bg-green-600 text-white';
  if (rate >= 60) return 'bg-green-500 text-white';
  if (rate >= 40) return 'bg-green-400 text-white';
  if (rate >= 20) return 'bg-green-300 text-green-900';
  if (rate > 0) return 'bg-green-200 text-green-900';
  return 'bg-surface-secondary text-fg-muted';
}

/** Format a cohort week label (e.g., "2026-03-17" -> "Mar 17"). */
function formatWeekLabel(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export const RetentionCohorts: FC<Props> = ({ data }) => {
  if (!data?.retention?.length) {
    return <Body className="text-fg-muted">No retention data available yet.</Body>;
  }

  // Find the max number of week offsets across all cohorts
  const maxWeekOffset = Math.max(
    ...data.retention.map((c) => Math.max(...c.weeks.map((w) => w.week), 0)),
    0,
  );

  // Limit displayed columns for readability
  const displayWeeks = Math.min(maxWeekOffset, data.weeks ?? 12);

  return (
    <div className="overflow-x-auto">
      <table className="text-xs">
        <thead>
          <tr>
            <th className="py-1.5 pr-3 text-left font-medium text-fg-muted whitespace-nowrap">Cohort</th>
            <th className="py-1.5 px-1 text-center font-medium text-fg-muted">Size</th>
            {Array.from({ length: displayWeeks + 1 }, (_, i) => (
              <th key={i} className="py-1.5 px-1 text-center font-medium text-fg-muted whitespace-nowrap">
                {i === 0 ? 'W0' : `W${i}`}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.retention.map((cohort) => {
            const weekMap = new Map(cohort.weeks.map((w) => [w.week, w]));

            return (
              <tr key={cohort.cohortWeek}>
                <td className="py-1 pr-3 font-mono text-fg-secondary whitespace-nowrap">
                  {formatWeekLabel(cohort.cohortWeek)}
                </td>
                <td className="py-1 px-1 text-center tabular-nums text-fg-secondary">
                  {cohort.cohortSize}
                </td>
                {Array.from({ length: displayWeeks + 1 }, (_, i) => {
                  const weekData = weekMap.get(i);
                  const rate = weekData?.rate ?? 0;

                  return (
                    <td
                      key={i}
                      className={`py-1 px-1 text-center tabular-nums rounded-sm min-w-[36px] ${retentionColor(rate)}`}
                      title={`Week ${i}: ${weekData?.users ?? 0} users (${rate}%)`}
                    >
                      {weekData ? `${rate}%` : ''}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
