import { useCallback, useEffect, useMemo, useState } from 'react';
import type { WorkspaceResponse } from '@simple-agent-manager/shared';
import { Alert, PageLayout, Select, SkeletonCard, EmptyState } from '@simple-agent-manager/ui';
import { UserMenu } from '../components/UserMenu';
import { WorkspaceCard } from '../components/WorkspaceCard';
import { listWorkspaces, stopWorkspace, restartWorkspace, deleteWorkspace } from '../lib/api';
import { Monitor } from 'lucide-react';

const STATUS_FILTERS = [
  { value: '', label: 'All statuses' },
  { value: 'running', label: 'Running' },
  { value: 'stopped', label: 'Stopped' },
  { value: 'creating', label: 'Creating' },
  { value: 'error', label: 'Error' },
];

export function Workspaces() {
  const [workspaces, setWorkspaces] = useState<WorkspaceResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('');

  const loadData = useCallback(async () => {
    try {
      setError(null);
      const data = await listWorkspaces(statusFilter || undefined);
      setWorkspaces(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load workspaces');
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    setLoading(true);
    void loadData();
    const interval = window.setInterval(() => {
      void loadData();
    }, 10000);
    return () => window.clearInterval(interval);
  }, [loadData]);

  const handleStop = async (id: string) => {
    try {
      await stopWorkspace(id);
      void loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop workspace');
    }
  };

  const handleRestart = async (id: string) => {
    try {
      await restartWorkspace(id);
      void loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to restart workspace');
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteWorkspace(id);
      void loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete workspace');
    }
  };

  const sortedWorkspaces = useMemo(
    () => [...workspaces].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [workspaces]
  );

  return (
    <PageLayout title="Workspaces" maxWidth="xl" headerRight={<UserMenu />}>
      <div className="flex justify-between items-center mb-6 gap-3 flex-wrap">
        <p className="sam-type-secondary m-0 text-fg-muted">
          All workspaces across all nodes.
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

      {loading ? (
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
