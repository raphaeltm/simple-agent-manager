import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { NodeResponse } from '@simple-agent-manager/shared';
import { Alert, Button, PageLayout, Skeleton, StatusBadge } from '@simple-agent-manager/ui';
import { UserMenu } from '../components/UserMenu';
import { MiniMetricBadge } from '../components/node/MiniMetricBadge';
import { createNode, listNodes } from '../lib/api';

function formatHeartbeat(value: string | null): string {
  if (!value) {
    return 'No heartbeat yet';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Invalid heartbeat timestamp';
  }
  return `Heartbeat: ${date.toLocaleString()}`;
}

export function Nodes() {
  const navigate = useNavigate();
  const [nodes, setNodes] = useState<NodeResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadNodes = useCallback(async () => {
    try {
      setError(null);
      const response = await listNodes();
      setNodes(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load nodes');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadNodes();
    const interval = window.setInterval(() => {
      void loadNodes();
    }, 10000);
    return () => window.clearInterval(interval);
  }, [loadNodes]);

  const handleCreateNode = async () => {
    try {
      setCreating(true);
      setError(null);
      const timestamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '').toLowerCase();
      const created = await createNode({ name: `node-${timestamp}` });
      navigate(`/nodes/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create node');
    } finally {
      setCreating(false);
    }
  };

  const sortedNodes = useMemo(
    () => [...nodes].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [nodes]
  );

  return (
    <PageLayout title="Nodes" maxWidth="xl" headerRight={<UserMenu />}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 'var(--sam-space-6)',
          gap: 'var(--sam-space-3)',
          flexWrap: 'wrap',
        }}
      >
        <p style={{ margin: 0, color: 'var(--sam-color-fg-muted)' }}>
          Nodes host one or more workspaces. Health transitions are `healthy` → `stale` → `unhealthy` based on heartbeat freshness.
        </p>
        <Button onClick={handleCreateNode} disabled={creating}>
          {creating ? 'Creating...' : 'Create Node'}
        </Button>
      </div>

      {error && (
        <div style={{ marginBottom: 'var(--sam-space-4)' }}>
          <Alert variant="error" onDismiss={() => setError(null)}>
            {error}
          </Alert>
        </div>
      )}

      {loading ? (
        <div style={{ display: 'grid', gap: 'var(--sam-space-3)' }}>
          {Array.from({ length: 3 }, (_, i) => (
            <div
              key={i}
              aria-hidden="true"
              style={{
                border: '1px solid var(--sam-color-border-default)',
                borderRadius: 'var(--sam-radius-md)',
                padding: 'var(--sam-space-4)',
                background: 'var(--sam-color-bg-surface)',
                display: 'grid',
                gap: 'var(--sam-space-2)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Skeleton width="40%" height="1.125rem" />
                <div style={{ display: 'flex', gap: 'var(--sam-space-2)' }}>
                  <Skeleton width="60px" height="1.25rem" borderRadius="9999px" />
                  <Skeleton width="60px" height="1.25rem" borderRadius="9999px" />
                </div>
              </div>
              <Skeleton width="50%" height="0.875rem" />
            </div>
          ))}
        </div>
      ) : sortedNodes.length === 0 ? (
        <div
          style={{
            border: '1px solid var(--sam-color-border-default)',
            borderRadius: 'var(--sam-radius-md)',
            padding: 'var(--sam-space-6)',
            background: 'var(--sam-color-bg-surface)',
            color: 'var(--sam-color-fg-muted)',
          }}
        >
          No nodes yet.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 'var(--sam-space-3)' }}>
          {sortedNodes.map((node) => (
            <button
              key={node.id}
              onClick={() => navigate(`/nodes/${node.id}`)}
              style={{
                textAlign: 'left',
                border: '1px solid var(--sam-color-border-default)',
                borderRadius: 'var(--sam-radius-md)',
                padding: 'var(--sam-space-4)',
                background: 'var(--sam-color-bg-surface)',
                color: 'var(--sam-color-fg-primary)',
                cursor: 'pointer',
                display: 'grid',
                gap: 'var(--sam-space-2)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--sam-space-2)', flexWrap: 'wrap' }}>
                <div style={{ fontWeight: 600 }}>{node.name}</div>
                <div style={{ display: 'flex', gap: 'var(--sam-space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
                  <StatusBadge status={node.status} />
                  <StatusBadge status={node.healthStatus || 'stale'} />
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--sam-space-2)', flexWrap: 'wrap' }}>
                <div style={{ fontSize: '0.875rem', color: 'var(--sam-color-fg-muted)' }}>
                  {formatHeartbeat(node.lastHeartbeatAt)}
                </div>
                {node.lastMetrics && (
                  <div style={{ display: 'flex', gap: 'var(--sam-space-1)', flexWrap: 'wrap' }}>
                    {node.lastMetrics.cpuLoadAvg1 != null && (
                      <MiniMetricBadge label="LOAD" value={node.lastMetrics.cpuLoadAvg1} suffix="" precision={1} warnAt={2} critAt={4} />
                    )}
                    {node.lastMetrics.memoryPercent != null && (
                      <MiniMetricBadge label="MEM" value={node.lastMetrics.memoryPercent} />
                    )}
                    {node.lastMetrics.diskPercent != null && (
                      <MiniMetricBadge label="DISK" value={node.lastMetrics.diskPercent} />
                    )}
                  </div>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </PageLayout>
  );
}
