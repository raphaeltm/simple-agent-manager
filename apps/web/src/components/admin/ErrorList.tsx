import { Body,Button, Card, Spinner } from '@simple-agent-manager/ui';
import { type FC } from 'react';

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
        <div className="p-3 mb-4 rounded-sm bg-danger-tint text-danger-fg text-sm flex justify-between items-center">
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
        <div className="flex justify-between items-center px-4 py-2 border-b border-border-default text-xs text-fg-muted">
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
          <div className="flex justify-center p-8">
            <Spinner size="lg" />
          </div>
        ) : errors.length === 0 ? (
          <div className="p-8 text-center">
            <Body className="text-fg-muted">
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
              <div className="flex justify-center p-4">
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
              <div className="flex justify-center p-3">
                <Spinner size="sm" />
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
};
