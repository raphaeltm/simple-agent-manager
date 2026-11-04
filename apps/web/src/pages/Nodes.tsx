import type { NodeWorkspaceResourceUsage } from '@simple-agent-manager/shared';
import {
  Alert,
  Button,
  EmptyState,
  PageLayout,
  SkeletonCard,
  Spinner,
} from '@simple-agent-manager/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Server } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';

import { CreateNodeForm } from '../components/node/CreateNodeForm';
import { CPU_COLOR, MEMORY_COLOR, Swatch } from '../components/node/usage/MirrorChart';
import { NodeUsagePane, type UsageWindow } from '../components/node/usage/NodeUsagePane';
import { useQueryScope } from '../hooks/useQueryScope';
import { deleteNode, stopNode } from '../lib/api';
import {
  NODE_LIST_POLL_MS,
  NODE_PAGE_CLOCK_TICK_MS,
  NODE_RESOURCE_USAGE_POLL_MS,
} from '../lib/poll-intervals';
import {
  nodeListQueryOptions,
  nodeQueryKeys,
  nodeResourceUsageQueryOptions,
} from '../lib/query-options';

/** Shared so a machine with no sessions keeps the same prop identity between renders. */
const NO_SESSIONS: NodeWorkspaceResourceUsage[] = [];

/**
 * Re-renders on a slow tick so ages and live-memory freshness stay current between polls.
 * Skips ticks while the tab is hidden and catches up as soon as it is visible again.
 */
function useClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== 'hidden') setNow(Date.now());
    };
    const id = setInterval(tick, NODE_PAGE_CLOCK_TICK_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);
  return now;
}

export function Nodes() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const queryScope = useQueryScope();
  const clock = useClock();

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    data: nodes,
    isLoading: nodesLoading,
    isFetching: nodesFetching,
    isError: nodesError,
    error: nodesQueryError,
  } = useQuery({
    ...nodeListQueryOptions(queryScope),
    enabled: Boolean(queryScope),
    refetchInterval: NODE_LIST_POLL_MS > 0 ? NODE_LIST_POLL_MS : false,
  });

  const {
    data: usage,
    isError: usageError,
    error: usageQueryError,
  } = useQuery({
    ...nodeResourceUsageQueryOptions(queryScope),
    enabled: Boolean(queryScope),
    refetchInterval: NODE_RESOURCE_USAGE_POLL_MS > 0 ? NODE_RESOURCE_USAGE_POLL_MS : false,
  });

  const isRefreshing = nodesFetching && !!nodes;

  const sortedNodes = useMemo(
    () => [...(nodes ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [nodes]
  );

  const sessionsByNode = useMemo(() => {
    if (!usage) return null;
    const map = new Map<string, NodeWorkspaceResourceUsage[]>();
    for (const workspace of usage.workspaces) {
      const existing = map.get(workspace.nodeId) ?? [];
      existing.push(workspace);
      map.set(workspace.nodeId, existing);
    }
    return map;
  }, [usage]);

  const usageWindow = useMemo<UsageWindow | null>(
    () =>
      usage
        ? { windowStart: usage.windowStart, windowEnd: usage.windowEnd, bucketMs: usage.bucketMs }
        : null,
    [usage]
  );

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: nodeQueryKeys.all(queryScope) });
  }, [queryClient, queryScope]);

  const handleStopNode = useCallback(
    async (id: string) => {
      try {
        await stopNode(id);
        invalidate();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to stop node');
      }
    },
    [invalidate]
  );

  const handleDeleteNode = useCallback(
    async (id: string) => {
      const targetNode = (nodes ?? []).find((n) => n.id === id);
      if (targetNode?.nodeRole === 'deployment') {
        const envs = targetNode.deploymentEnvironments ?? [];
        const envSummary =
          envs.length > 0
            ? `${envs.length} deployment environment${envs.length === 1 ? '' : 's'}: ${envs.map((env) => env.name).join(', ')}`
            : 'deployment environments currently listed on this node';
        const confirmed = window.confirm(
          `"${targetNode.name}" is a deployment node hosting ${envSummary}. Deleting it here destroys the node infrastructure and affects ALL hosted environments, but it does not perform each environment's volume teardown.\n\nFor full per-environment teardown, use Destroy on the project Deployments page.\n\nContinue with node-only deletion?`
        );
        if (!confirmed) return;
      }
      try {
        await deleteNode(id);
        invalidate();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete node');
      }
    },
    [invalidate, nodes]
  );

  return (
    <PageLayout title="Nodes" maxWidth="xl">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 basis-[260px] flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <p className="sam-type-secondary m-0 text-fg-muted">
              The machines your agents run on, the sessions on each, and what they are using.
            </p>
            {isRefreshing && <Spinner size="sm" />}
          </div>
          {sortedNodes.length > 0 && (
            <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-fg-muted">
              {usage && <span>Last {usage.windowMinutes} minutes.</span>}
              {usage && usage.historyOmittedCount > 0 && (
                <span>
                  Usage for {usage.historyOmittedCount} older session
                  {usage.historyOmittedCount === 1 ? '' : 's'} was not loaded.
                </span>
              )}
              <span className="flex items-center gap-1.5">
                <Swatch color={MEMORY_COLOR} /> Memory goes up
              </span>
              <span className="flex items-center gap-1.5">
                <Swatch color={CPU_COLOR} /> CPU goes down
              </span>
              <span>Dashed: what SAM set aside.</span>
              <span>
                History arrives in batches, so the newest minutes fill in later; the dot is live
                memory.
              </span>
            </p>
          )}
        </div>
        <Button
          onClick={() => setShowCreateForm((v) => !v)}
          variant={showCreateForm ? 'secondary' : 'primary'}
        >
          {showCreateForm ? 'Cancel' : 'Create Node'}
        </Button>
      </div>

      {showCreateForm && (
        <div className="mb-4">
          <CreateNodeForm
            onError={setError}
            onCreated={(created) => {
              setShowCreateForm(false);
              navigate(`/nodes/${created.id}`);
            }}
          />
        </div>
      )}

      {error && (
        <div className="mb-4">
          <Alert variant="error" onDismiss={() => setError(null)}>
            {error}
          </Alert>
        </div>
      )}

      {usageError && !usage && sortedNodes.length > 0 && (
        <div className="mb-4">
          <Alert variant="error">
            Couldn&apos;t load sessions and usage:{' '}
            {(usageQueryError instanceof Error && usageQueryError.message) || 'unknown error'}
          </Alert>
        </div>
      )}

      {nodesLoading && sortedNodes.length === 0 ? (
        <div className="grid grid-cols-1 gap-4">
          {Array.from({ length: 3 }, (_, i) => (
            <SkeletonCard key={i} lines={3} />
          ))}
        </div>
      ) : nodesError && sortedNodes.length === 0 ? (
        // Initial load failed with no cached data: surface the error instead of
        // a misleading "No nodes yet" empty state. A background refetch failure
        // while stale data is present keeps the data mounted (below).
        <Alert variant="error">
          {(nodesQueryError instanceof Error && nodesQueryError.message) || 'Failed to load nodes'}
        </Alert>
      ) : sortedNodes.length === 0 ? (
        !showCreateForm && (
          <EmptyState
            icon={<Server size={48} />}
            heading="No nodes yet"
            description="Create your first node to start hosting workspaces."
            action={{ label: 'Create Node', onClick: () => setShowCreateForm(true) }}
          />
        )
      ) : (
        <div className="grid grid-cols-1 items-start gap-[var(--sam-space-gutter)] 2xl:grid-cols-2">
          {sortedNodes.map((node) => (
            <NodeUsagePane
              key={node.id}
              node={node}
              sessions={sessionsByNode ? (sessionsByNode.get(node.id) ?? NO_SESSIONS) : undefined}
              usageWindow={usageWindow}
              clock={clock}
              onStop={handleStopNode}
              onDelete={handleDeleteNode}
            />
          ))}
        </div>
      )}
    </PageLayout>
  );
}
