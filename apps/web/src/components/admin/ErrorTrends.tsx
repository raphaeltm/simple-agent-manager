import type { ErrorTrendBucket,ErrorTrendResponse } from '@simple-agent-manager/shared';
import { Body,Button, Card, Spinner } from '@simple-agent-manager/ui';
import { type FC, useCallback,useEffect, useState } from 'react';

import { fetchAdminErrorTrends } from '../../lib/api';

const RANGES = ['1h', '24h', '7d', '30d'] as const;
type Range = (typeof RANGES)[number];

const SOURCE_COLORS: Record<string, string> = {
  client: '#3b82f6',    // blue
  'vm-agent': '#f97316', // orange
  api: '#ef4444',        // red
};

const SOURCE_LABELS: Record<string, string> = {
  client: 'Client',
  'vm-agent': 'VM Agent',
  api: 'API',
};

export const ErrorTrends: FC = () => {
  const [range, setRange] = useState<Range>('24h');
  const [data, setData] = useState<ErrorTrendResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchTrends = useCallback(async (r: Range) => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchAdminErrorTrends(r);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load error trends');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTrends(range);
  }, [range, fetchTrends]);

  const handleRangeChange = (r: Range) => {
    setRange(r);
  };

  const maxTotal = data
    ? Math.max(1, ...data.buckets.map((b) => b.total))
    : 1;

  return (
    <Card>
      <div className="p-4">
        {/* Header */}
        <div className="flex flex-wrap justify-between items-center gap-2 mb-4">
          <Body className="font-semibold">Error Trends</Body>

          <div className="flex gap-1">
            {RANGES.map((r) => (
              <Button
                key={r}
                size="sm"
                variant={range === r ? 'primary' : 'ghost'}
                onClick={() => handleRangeChange(r)}
                disabled={loading}
              >
                {r}
              </Button>
            ))}
          </div>
        </div>

        {/* Legend */}
        <div className="flex gap-4 mb-3">
          {Object.entries(SOURCE_LABELS).map(([key, label]) => (
            <div key={key} className="flex items-center gap-1">
              <span
                data-testid={`legend-${key}`}
                className="inline-block w-3 h-3 rounded-sm"
                style={{ backgroundColor: SOURCE_COLORS[key] }}
              />
              <Body className="text-xs text-fg-muted">
                {label}
              </Body>
            </div>
          ))}
        </div>

        {/* Content */}
        {error && !data && (
          <div className="p-4 flex flex-col items-center gap-3">
            <Body className="text-danger-fg">{error}</Body>
            <Button size="sm" variant="secondary" onClick={() => fetchTrends(range)}>
              Retry
            </Button>
          </div>
        )}

        {loading && !data && (
          <div className="flex justify-center p-8">
            <Spinner size="lg" />
          </div>
        )}

        {data && data.buckets.length === 0 && (
          <div className="p-6 text-center">
            <Body className="text-fg-muted">No error data for this time range</Body>
          </div>
        )}

        {data && data.buckets.length > 0 && (
          <div
            data-testid="trend-chart"
            className="flex items-end py-2"
            style={{ gap: 1, height: 160 }}
          >
            {data.buckets.map((bucket, i) => (
              <TrendBar key={i} bucket={bucket} maxTotal={maxTotal} />
            ))}
          </div>
        )}

        {/* Time axis labels */}
        {data && data.buckets.length > 0 && (
          <div className="flex justify-between pt-1">
            <Body className="text-[0.65rem] text-fg-muted">
              {formatTimestamp(data.buckets[0]!.timestamp, range)}
            </Body>
            <Body className="text-[0.65rem] text-fg-muted">
              {formatTimestamp(data.buckets[data.buckets.length - 1]!.timestamp, range)}
            </Body>
          </div>
        )}
      </div>
    </Card>
  );
};

interface TrendBarProps {
  bucket: ErrorTrendBucket;
  maxTotal: number;
}

const TrendBar: FC<TrendBarProps> = ({ bucket, maxTotal }) => {
  const heightPct = (bucket.total / maxTotal) * 100;
  const sources = ['api', 'vm-agent', 'client'] as const;

  if (bucket.total === 0) {
    return (
      <div
        data-testid="trend-bar"
        title={`${formatTime(bucket.timestamp)}: 0 errors`}
        className="flex-1 h-full flex items-end"
        style={{ minWidth: 2 }}
      >
        <div className="w-full bg-border-default opacity-30" style={{ height: 2, borderRadius: 1 }} />
      </div>
    );
  }

  return (
    <div
      data-testid="trend-bar"
      title={`${formatTime(bucket.timestamp)}: ${bucket.total} errors`}
      className="flex-1 h-full flex flex-col justify-end"
      style={{ minWidth: 2 }}
    >
      <div
        className="w-full flex flex-col overflow-hidden"
        style={{ height: `${heightPct}%`, borderRadius: '2px 2px 0 0' }}
      >
        {sources.map((source) => {
          const count = bucket.bySource[source] ?? 0;
          if (count === 0) return null;
          const segmentPct = (count / bucket.total) * 100;
          return (
            <div
              key={source}
              className="w-full"
              style={{
                height: `${segmentPct}%`,
                backgroundColor: SOURCE_COLORS[source],
                minHeight: 1,
              }}
            />
          );
        })}
      </div>
    </div>
  );
};

function formatTimestamp(ts: string, range: string): string {
  const d = new Date(ts);
  if (range === '1h' || range === '24h') {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatTime(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
