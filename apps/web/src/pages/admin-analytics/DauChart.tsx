import { type FC } from 'react';
import { Body } from '@simple-agent-manager/ui';

export const DauChart: FC<{ data: Array<{ date: string; unique_users: number }> }> = ({ data }) => {
  if (!data.length) {
    return <Body className="text-fg-muted">No DAU data available yet.</Body>;
  }

  const maxUsers = Math.max(...data.map((d) => d.unique_users), 1);

  const peakDay = data.reduce<{ date: string; unique_users: number } | undefined>(
    (best, d) => (best === undefined || d.unique_users > best.unique_users ? d : best),
    undefined,
  );

  return (
    <div className="flex flex-col gap-1">
      <div
        className="flex items-end gap-[2px] h-32"
        role="img"
        aria-label={`Daily active users bar chart from ${data[0]?.date ?? ''} to ${data[data.length - 1]?.date ?? ''}. Peak: ${peakDay ? peakDay.unique_users.toLocaleString() : '0'} users on ${peakDay?.date ?? ''}.`}
      >
        {data.map((d) => {
          const height = Math.max((d.unique_users / maxUsers) * 100, 2);
          return (
            <div
              key={d.date}
              className="flex-1 bg-accent-emphasis rounded-t-sm min-w-[4px] transition-all"
              style={{ height: `${height}%` }}
              aria-hidden="true"
            />
          );
        })}
      </div>
      <div className="flex justify-between text-xs text-fg-muted" aria-hidden="true">
        <span>{data[0]?.date ?? ''}</span>
        <span>{data[data.length - 1]?.date ?? ''}</span>
      </div>
    </div>
  );
};
