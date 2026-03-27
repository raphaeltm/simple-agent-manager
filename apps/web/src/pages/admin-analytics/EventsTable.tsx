import { type FC } from 'react';
import { Body } from '@simple-agent-manager/ui';

export const EventsTable: FC<{
  data: Array<{ event_name: string; count: number; unique_users: number; avg_response_ms: number }>;
}> = ({ data }) => {
  if (!data.length) {
    return <Body className="text-fg-muted">No event data available yet.</Body>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border-default text-left text-fg-muted">
            <th scope="col" className="py-2 pr-4 font-medium">Event</th>
            <th scope="col" className="py-2 pr-4 font-medium text-right">Count</th>
            <th scope="col" className="py-2 pr-4 font-medium text-right">Users</th>
            <th scope="col" className="py-2 font-medium text-right">Avg (ms)</th>
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
