import { Body } from '@simple-agent-manager/ui';
import { type FC, useMemo,useState } from 'react';

type SortKey = 'event_name' | 'count' | 'unique_users' | 'avg_response_ms';
type SortDir = 'asc' | 'desc';

interface EventRow {
  event_name: string;
  count: number;
  unique_users: number;
  avg_response_ms: number;
}

function SortIcon({ active, direction }: { active: boolean; direction: SortDir }) {
  return (
    <span className={`inline-block ml-1 ${active ? 'text-fg-primary' : 'text-fg-muted opacity-40'}`} aria-hidden="true">
      {active && direction === 'asc' ? '\u25B2' : '\u25BC'}
    </span>
  );
}

export const EventsTable: FC<{ data: EventRow[] }> = ({ data }) => {
  const [sortKey, setSortKey] = useState<SortKey>('count');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const sorted = useMemo(() => {
    const copy = [...data];
    copy.sort((a, b) => {
      const aVal = a[sortKey];
      const bVal = b[sortKey];
      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortDir === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }
      const diff = (aVal as number) - (bVal as number);
      return sortDir === 'asc' ? diff : -diff;
    });
    return copy;
  }, [data, sortKey, sortDir]);

  if (!data.length) {
    return <Body className="text-fg-muted">No event data available yet.</Body>;
  }

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'event_name' ? 'asc' : 'desc');
    }
  }

  const columns: Array<{ key: SortKey; label: string; align: 'left' | 'right' }> = [
    { key: 'event_name', label: 'Event', align: 'left' },
    { key: 'count', label: 'Count', align: 'right' },
    { key: 'unique_users', label: 'Users', align: 'right' },
    { key: 'avg_response_ms', label: 'Avg (ms)', align: 'right' },
  ];

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border-default text-left text-fg-muted">
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                tabIndex={0}
                role="columnheader"
                className={`py-2 pr-4 font-medium cursor-pointer select-none hover:text-fg-primary transition-colors ${col.align === 'right' ? 'text-right' : ''}`}
                onClick={() => handleSort(col.key)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleSort(col.key);
                  }
                }}
                aria-sort={sortKey === col.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
              >
                {col.label}
                <SortIcon active={sortKey === col.key} direction={sortDir} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={row.event_name} className="border-b border-border-muted hover:bg-surface-secondary transition-colors">
              <td className="py-2 pr-4 font-mono text-xs truncate max-w-[200px]" title={row.event_name}>{row.event_name}</td>
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
