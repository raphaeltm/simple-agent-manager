import type { WorkspaceResponse } from '@simple-agent-manager/shared';
import { Alert, EmptyState,PageLayout, Select, SkeletonCard, Spinner } from '@simple-agent-manager/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Monitor } from 'lucide-react';
import { useMemo, useState } from 'react';

import { WorkspaceCard } from '../components/WorkspaceCard';
import { deleteWorkspace,listWorkspaces, restartWorkspace, stopWorkspace } from '../lib/api';

const STATUS_FILTERS = [
  { value: '', label: 'All statuses' },
  { value: 'running', label: 'Running' },
  { value: 'stopped', label: 'Stopped' },
  { value: 'creating', label: 'Creating' },
  { value: 'error', label: 'Error' },
];

/** Stable query key factory for workspace list queries. */
export const workspacesKeys = {
  all: ['workspaces'] as const,
  list: (status?: string) => ['workspaces', 'list', status ?? ''] as const,
};

export function Workspaces() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState('');
  const [error, setError] = useState<string | null>(null);

  const {
    data: workspaces,
    isLoading,
    isFetching,
  } = useQuery<WorkspaceResponse[]>({
    queryKey: workspacesKeys.list(statusFilter || undefined),
    queryFn: () => listWorkspaces(statusFilter || undefined),
    refetchInterval: 10_000,
  });

  const handleStop = async (id: string) => {
    try {
      await stopWorkspace(id);
      void queryClient.invalidateQueries({ queryKey: workspacesKeys.all });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop workspace');
    }
  };

  const handleRestart = async (id: string) => {
    try {
      await restartWorkspace(id);
      void queryClient.invalidateQueries({ queryKey: workspacesKeys.all });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to restart workspace');
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteWorkspace(id);
      void queryClient.invalidateQueries({ queryKey: workspacesKeys.all });
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

      {isLoading ? (
        <div role="status" aria-label="Loading workspaces" aria-busy="true" className="grid grid-cols-1 gap-3">
          {Array.from({ length: 3 }, (_, i) => (
            <SkeletonCard key={i} lines={2} />
          ))}
        </div>
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
