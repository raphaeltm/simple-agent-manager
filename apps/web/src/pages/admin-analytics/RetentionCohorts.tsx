import { Body } from '@simple-agent-manager/ui';
import { type FC } from 'react';

import type { AnalyticsRetentionResponse } from '../../lib/api';

interface Props {
  data: AnalyticsRetentionResponse | null;
}

/** Map a retention rate (0-100) to inline styles using design system CSS variables. */
function retentionStyle(rate: number): React.CSSProperties {
  if (rate >= 80) return { backgroundColor: 'var(--sam-color-accent-primary, #16a34a)', color: '#fff' };
  if (rate >= 60) return { backgroundColor: 'var(--sam-color-success, #22c55e)', color: '#fff' };
  if (rate >= 40) return { backgroundColor: 'rgba(34, 197, 94, 0.5)', color: '#fff' };
  if (rate >= 20) return { backgroundColor: 'rgba(34, 197, 94, 0.25)', color: 'var(--sam-color-fg-primary, #e6f2ee)' };
  if (rate > 0) return { backgroundColor: 'rgba(34, 197, 94, 0.1)', color: 'var(--sam-color-fg-muted, #9fb7ae)' };
  return { backgroundColor: 'var(--sam-color-bg-inset, #0e1a17)', color: 'var(--sam-color-fg-muted, #9fb7ae)' };
}

/** Map a retention rate to a human-readable tier label for non-color cues. */
function retentionTier(rate: number): string {
  if (rate >= 80) return 'excellent';
  if (rate >= 60) return 'good';
  if (rate >= 40) return 'fair';
  if (rate >= 20) return 'poor';
  if (rate > 0) return 'very poor';
  return 'no data';
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
    <div className="overflow-x-auto" role="region" aria-label="Weekly retention cohort heat map — scroll horizontally to see all weeks">
      <table className="text-xs border-separate border-spacing-[2px]" aria-label="Weekly retention cohorts">
        <caption className="sr-only">
          Weekly retention cohorts. Each row is a cohort starting on the given date. Each column
          shows the percentage of that cohort still active in that week. W0 is the starting week.
        </caption>
        <thead>
          <tr>
            <th scope="col" className="py-1.5 pr-3 text-left font-medium text-fg-muted whitespace-nowrap sticky left-0 z-10" style={{ backgroundColor: 'var(--sam-color-bg-surface, #13201d)' }}>Cohort</th>
            <th scope="col" className="py-1.5 px-1 text-center font-medium text-fg-muted">Size</th>
            {Array.from({ length: displayWeeks + 1 }, (_, i) => (
              <th key={i} scope="col" className="py-1.5 px-1 text-center font-medium text-fg-muted whitespace-nowrap">
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
                <th scope="row" className="py-1 pr-3 font-mono text-fg-secondary whitespace-nowrap font-normal sticky left-0 z-10" style={{ backgroundColor: 'var(--sam-color-bg-surface, #13201d)' }}>
                  {formatWeekLabel(cohort.cohortWeek)}
                </th>
                <td className="py-1 px-1 text-center tabular-nums text-fg-secondary">
                  {cohort.cohortSize}
                </td>
                {Array.from({ length: displayWeeks + 1 }, (_, i) => {
                  const weekData = weekMap.get(i);
                  const rate = weekData?.rate ?? 0;
                  const tier = weekData ? retentionTier(rate) : 'no data';

                  return (
                    <td
                      key={i}
                      className="py-1 px-1 text-center tabular-nums rounded-sm min-w-[36px]"
                      style={retentionStyle(rate)}
                      aria-label={`Week ${i}: ${weekData?.users ?? 0} users, ${rate}%, ${tier}`}
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
