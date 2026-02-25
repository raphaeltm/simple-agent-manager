import { type FC } from 'react';
import { Card, Spinner, Button, Body } from '@simple-agent-manager/ui';
import { useAdminErrors } from '../../hooks/useAdminErrors';
import { ObservabilityFilters } from './ObservabilityFilters';
import { ObservabilityLogEntry } from './ObservabilityLogEntry';

export const ErrorList: FC = () => {
  const {
    errors,
    loading,
    error,
    hasMore,
    total,
    filter,
    setSource,
    setLevel,
    setSearch,
    setTimeRange,
    loadMore,
    refresh,
  } = useAdminErrors();

  return (
    <div>
      {error && (
        <div
          style={{
            padding: 'var(--sam-space-3)',
            marginBottom: 'var(--sam-space-4)',
            borderRadius: 'var(--sam-radius-sm)',
            backgroundColor: 'rgba(239, 68, 68, 0.1)',
            color: '#f87171',
            fontSize: 'var(--sam-type-secondary-size)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>{error}</span>
          <Button size="sm" variant="ghost" onClick={refresh}>
            Retry
          </Button>
        </div>
      )}

      <Card>
        <ObservabilityFilters
          source={filter.source}
          level={filter.level}
          search={filter.search}
          timeRange={filter.timeRange}
          onSourceChange={setSource}
          onLevelChange={setLevel}
          onSearchChange={setSearch}
          onTimeRangeChange={setTimeRange}
        />

        {/* Summary bar */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: 'var(--sam-space-2) var(--sam-space-4)',
            borderBottom: '1px solid var(--sam-color-border-default)',
            fontSize: 'var(--sam-type-caption-size)',
            color: 'var(--sam-color-fg-muted)',
          }}
        >
          <span>
            {total > 0
              ? `Showing ${errors.length} of ${total} errors`
              : 'No errors found'}
          </span>
          <Button size="sm" variant="ghost" onClick={refresh} disabled={loading}>
            Refresh
          </Button>
        </div>

        {/* Error list */}
        {loading && errors.length === 0 ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--sam-space-8)' }}>
            <Spinner size="lg" />
          </div>
        ) : errors.length === 0 ? (
          <div style={{ padding: 'var(--sam-space-8)', textAlign: 'center' }}>
            <Body style={{ color: 'var(--sam-color-fg-muted)' }}>
              No errors match the current filters.
            </Body>
          </div>
        ) : (
          <>
            {errors.map((entry) => (
              <ObservabilityLogEntry key={entry.id} error={entry} />
            ))}

            {/* Load More / Loading */}
            {hasMore && (
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'center',
                  padding: 'var(--sam-space-4)',
                }}
              >
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={loadMore}
                  disabled={loading}
                >
                  {loading ? 'Loading...' : 'Load More'}
                </Button>
              </div>
            )}

            {loading && errors.length > 0 && (
              <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--sam-space-3)' }}>
                <Spinner size="sm" />
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
};
