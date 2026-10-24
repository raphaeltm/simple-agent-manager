import { Spinner } from '@simple-agent-manager/ui';
import { useEffect, useState } from 'react';

import { AccountMapCanvas } from '../components/account-map/AccountMapCanvas';
import { AccountMapEmptyState } from '../components/account-map/AccountMapEmptyState';
import { AccountMapToolbar } from '../components/account-map/AccountMapToolbar';
import { useAccountMapData } from '../components/account-map/hooks/useAccountMapData';
import { useMapFilters } from '../components/account-map/hooks/useMapFilters';
import { useIsMobile } from '../hooks/useIsMobile';

export function AccountMap() {
  const isMobile = useIsMobile();
  const [activeOnly, setActiveOnly] = useState(true);

  const { nodes, edges, loading, error, isEmpty, stats, truncation, refresh, reorganize } =
    useAccountMapData({ isMobile, activeOnly });

  const {
    filteredNodes,
    filteredEdges,
    searchQuery,
    setSearchQuery,
    activeFilters,
    toggleFilter,
    resetFilters,
    hasActiveFilters,
    matchCount,
    totalCount,
    filterNodeCountChanged,
  } = useMapFilters({ nodes, edges });

  // Auto-reorganize when type filters add/remove nodes from the graph
  useEffect(() => {
    if (filterNodeCountChanged) {
      reorganize();
    }
  }, [filterNodeCountChanged, reorganize]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 px-6">
        <p className="sam-type-body text-danger">{error}</p>
        <button
          onClick={() => void refresh()}
          className="px-3 py-1.5 text-sm bg-accent text-fg-on-accent rounded-md border-none cursor-pointer hover:opacity-90 transition-opacity"
        >
          Retry
        </button>
      </div>
    );
  }

  if (isEmpty) {
    return <AccountMapEmptyState />;
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <AccountMapToolbar
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        activeFilters={activeFilters}
        onToggleFilter={toggleFilter}
        onResetFilters={resetFilters}
        onReorganize={reorganize}
        hasActiveFilters={hasActiveFilters}
        matchCount={matchCount}
        totalCount={totalCount}
        stats={stats}
        isMobile={isMobile}
        activeOnly={activeOnly}
        onToggleActiveOnly={() => setActiveOnly((v) => !v)}
      />
      {truncation && Object.values(truncation).some(Boolean) && (
        <p
          className="px-3 py-1.5 text-xs text-fg-muted bg-surface border-b border-border-default"
          role="status"
        >
          {truncation.incomplete
            ? 'Some map data could not be loaded. Refresh to try again.'
            : truncation.linkProjects || truncation.ideas
              ? 'Idea links are checked for recent projects and ideas only. Older linked ideas may be omitted.'
              : 'Showing a recent subset of the map. Older projects, ideas, chats or links may be omitted.'}
        </p>
      )}
      <div className="flex-1 min-h-0">
        <AccountMapCanvas nodes={filteredNodes} edges={filteredEdges} isMobile={isMobile} />
      </div>
    </div>
  );
}
