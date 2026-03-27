import { type FC } from 'react';
import { Body } from '@simple-agent-manager/ui';
import type { AnalyticsGeoResponse } from '../../lib/api';

interface Props {
  data: AnalyticsGeoResponse | null;
}

export const GeoDistribution: FC<Props> = ({ data }) => {
  if (!data?.geo?.length) {
    return <Body className="text-fg-muted">No geographic data available yet.</Body>;
  }

  const maxUsers = Math.max(...data.geo.map((g) => g.unique_users), 1);
  const totalUsers = data.geo.reduce((sum, g) => sum + g.unique_users, 0);

  return (
    <div className="flex flex-col gap-1">
      {data.geo.map((row) => {
        const widthPercent = Math.max((row.unique_users / maxUsers) * 100, 3);
        const sharePercent = totalUsers > 0
          ? Math.round((row.unique_users / totalUsers) * 100)
          : 0;

        return (
          <div key={row.country} className="flex items-center gap-3">
            <div className="w-12 text-sm font-mono text-fg-secondary">{row.country}</div>
            <div
              className="flex-1 h-6 bg-surface-secondary rounded-sm overflow-hidden"
              role="img"
              aria-label={`${row.country}: ${row.unique_users.toLocaleString()} users, ${sharePercent}% of total`}
            >
              <div
                className="h-full bg-accent-emphasis rounded-sm transition-all"
                style={{ width: `${widthPercent}%` }}
                aria-hidden="true"
              />
            </div>
            <div className="w-12 text-xs text-fg-secondary tabular-nums text-right flex-shrink-0">
              {row.unique_users.toLocaleString()}
            </div>
            <div className="w-20 text-xs text-fg-muted text-right tabular-nums">
              {row.event_count.toLocaleString()} events
            </div>
            <div className="w-10 text-xs text-fg-muted text-right tabular-nums">
              {sharePercent}%
            </div>
          </div>
        );
      })}
    </div>
  );
};
