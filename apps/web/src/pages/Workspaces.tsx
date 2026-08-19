import { Alert, EmptyState,PageLayout, Select, SkeletonCard, Spinner } from '@simple-agent-manager/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Monitor } from 'lucide-react';
import { useMemo, useState } from 'react';

import { WorkspaceCard } from '../components/WorkspaceCard';
import { useQueryScope } from '../hooks/useQueryScope';
import { deleteWorkspace, restartWorkspace, stopWorkspace } from '../lib/api';
import { WORKSPACE_LIST_POLL_MS } from '../lib/poll-intervals';
import { workspaceListQueryOptions, workspaceQueryKeys } from '../lib/query-options';

const STATUS_FILTERS = [
  { value: '', label: 'All statuses' },
  { value: 'running', label: 'Running' },
  { value: 'stopped', label: 'Stopped' },
  { value: 'creating', label: 'Creating' },
  { value: 'error', label: 'Error' },
];

export function Workspaces() {
  const queryClient = useQueryClient();
  const queryScope = useQueryScope();
  const [statusFilter, setStatusFilter] = useState('');
  const [error, setError] = useState<string | null>(null);

  const {
    data: workspaces,
    isLoading,
    isFetching,
    isError,
    error: queryError,
  } = useQuery({
    ...workspaceListQueryOptions(queryScope, statusFilter || undefined),
    enabled: Boolean(queryScope),
    refetchInterval: WORKSPACE_LIST_POLL_MS > 0 ? WORKSPACE_LIST_POLL_MS : false,
  });

  const invalidateWorkspaces = () =>
    queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.all(queryScope) });

  const handleStop = async (id: string) => {
    try {
      await stopWorkspace(id);
      void invalidateWorkspaces();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop workspace');
    }
  };

  const handleRestart = async (id: string) => {
    try {
      await restartWorkspace(id);
      void invalidateWorkspaces();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to restart workspace');
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteWorkspace(id);
      void invalidateWorkspaces();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete workspace');
    }
  };

  const sortedWorkspaces = useMemo(
    () => [...(workspaces ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [workspaces]
  );

  return (
    <PageLayout title="Workspaces" maxWidth="xl">
      <div className="flex justify-between items-center mb-6 gap-3 flex-wrap">
        <p className="sam-type-secondary m-0 text-fg-muted flex items-center gap-2">
          All workspaces across all nodes.
          {isFetching && workspaces && <Spinner size="sm" />}
        </p>
        <div className="flex items-center gap-3">
          <Select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            aria-label="Filter by status"
          >
            {STATUS_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </Select>
        </div>
      </div>

      {error && (
        <div className="mb-4">
          <Alert variant="error" onDismiss={() => setError(null)}>
            {error}
          </Alert>
        </div>
      )}

      {/* Keep the previously rendered list up while a filter change loads its own
          query key — switching the status filter is a different key, so `isLoading`
          is true even though there is perfectly good content on screen. Matches the
          guard `Nodes.tsx` already uses. */}
      {isLoading && sortedWorkspaces.length === 0 ? (
        <div role="status" aria-label="Loading workspaces" aria-busy="true" className="grid grid-cols-1 gap-3">
          {Array.from({ length: 3 }, (_, i) => (
            <SkeletonCard key={i} lines={2} />
          ))}
        </div>
      ) : isError && sortedWorkspaces.length === 0 ? (
        // Initial load failed with no cached data: surface the error instead of
        // a misleading "No workspaces yet" empty state. A background refetch
        // failure while stale data is present keeps the data mounted (below).
        <Alert variant="error">
          {(queryError instanceof Error && queryError.message) || 'Failed to load workspaces'}
        </Alert>
      ) : sortedWorkspaces.length === 0 ? (
        <EmptyState
          icon={<Monitor size={48} />}
          heading={statusFilter ? 'No matching workspaces' : 'No workspaces yet'}
          description={
            statusFilter
              ? 'Try changing the status filter.'
              : 'Workspaces are created from the Nodes page or via project tasks.'
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3">
          {sortedWorkspaces.map((ws) => (
            <WorkspaceCard
              key={ws.id}
              workspace={ws}
              onStop={handleStop}
              onRestart={handleRestart}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
    </PageLayout>
  );
}
