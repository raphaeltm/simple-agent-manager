import { type FC, useState, useEffect, useCallback } from 'react';
import { Card, Spinner, Button, Body } from '@simple-agent-manager/ui';
import { fetchAdminErrorTrends } from '../../lib/api';
import type { ErrorTrendResponse, ErrorTrendBucket } from '@simple-agent-manager/shared';

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
      <div style={{ padding: 'var(--sam-space-4)' }}>
        {/* Header */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 'var(--sam-space-4)',
          }}
        >
          <Body style={{ fontWeight: 600 }}>Error Trends</Body>

          <div style={{ display: 'flex', gap: 'var(--sam-space-1)' }}>
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
        <div
          style={{
            display: 'flex',
            gap: 'var(--sam-space-4)',
            marginBottom: 'var(--sam-space-3)',
          }}
        >
          {Object.entries(SOURCE_LABELS).map(([key, label]) => (
            <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-1)' }}>
              <span
                data-testid={`legend-${key}`}
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 2,
                  backgroundColor: SOURCE_COLORS[key],
                  display: 'inline-block',
                }}
              />
              <Body style={{ fontSize: 'var(--sam-type-caption-size)', color: 'var(--sam-color-fg-muted)' }}>
                {label}
              </Body>
            </div>
          ))}
        </div>

        {/* Content */}
        {error && !data && (
          <div
            style={{
              padding: 'var(--sam-space-4)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 'var(--sam-space-3)',
            }}
          >
            <Body style={{ color: '#f87171' }}>{error}</Body>
            <Button size="sm" variant="secondary" onClick={() => fetchTrends(range)}>
              Retry
            </Button>
          </div>
        )}

        {loading && !data && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--sam-space-8)' }}>
            <Spinner size="lg" />
          </div>
        )}

        {data && data.buckets.length === 0 && (
          <div style={{ padding: 'var(--sam-space-6)', textAlign: 'center' }}>
            <Body style={{ color: 'var(--sam-color-fg-muted)' }}>No error data for this time range</Body>
          </div>
        )}

        {data && data.buckets.length > 0 && (
          <div
            data-testid="trend-chart"
            style={{
              display: 'flex',
              alignItems: 'flex-end',
              gap: 1,
              height: 160,
              padding: 'var(--sam-space-2) 0',
            }}
          >
            {data.buckets.map((bucket, i) => (
              <TrendBar key={i} bucket={bucket} maxTotal={maxTotal} />
            ))}
          </div>
        )}

        {/* Time axis labels */}
        {data && data.buckets.length > 0 && (
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              paddingTop: 'var(--sam-space-1)',
            }}
          >
            <Body style={{ fontSize: '0.65rem', color: 'var(--sam-color-fg-muted)' }}>
              {formatTimestamp(data.buckets[0]!.timestamp, range)}
            </Body>
            <Body style={{ fontSize: '0.65rem', color: 'var(--sam-color-fg-muted)' }}>
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
        style={{
          flex: 1,
          minWidth: 2,
          height: '100%',
          display: 'flex',
          alignItems: 'flex-end',
        }}
      >
        <div
          style={{
            width: '100%',
            height: 2,
            backgroundColor: 'var(--sam-color-border-default)',
            borderRadius: 1,
            opacity: 0.3,
          }}
        />
      </div>
    );
  }

  return (
    <div
      data-testid="trend-bar"
      title={`${formatTime(bucket.timestamp)}: ${bucket.total} errors`}
      style={{
        flex: 1,
        minWidth: 2,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
      }}
    >
      <div
        style={{
          width: '100%',
          height: `${heightPct}%`,
          display: 'flex',
          flexDirection: 'column',
          borderRadius: '2px 2px 0 0',
          overflow: 'hidden',
        }}
      >
        {sources.map((source) => {
          const count = bucket.bySource[source] ?? 0;
          if (count === 0) return null;
          const segmentPct = (count / bucket.total) * 100;
          return (
            <div
              key={source}
              style={{
                width: '100%',
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
