import { useState, useEffect, useCallback, useMemo } from 'react';
import type { Node, Edge } from '@xyflow/react';
import { getAccountMap, type AccountMapResponse } from '../../../lib/api';
import { applyDagreLayout } from '../layout/dagre-layout';

/** Edge color mapping by relationship type */
const EDGE_COLORS: Record<string, string> = {
  has_workspace: '#00ccff',
  runs_on: '#00ff88',
  has_session: '#aa88ff',
  session_workspace: '#aa88ff',
  has_task: '#ffaa00',
  task_workspace: '#ffaa00',
  has_idea: '#ffdd44',
  idea_session: '#ffdd44',
};

interface UseAccountMapDataOptions {
  isMobile: boolean;
  activeOnly: boolean;
}

interface UseAccountMapDataResult {
  nodes: Node[];
  edges: Edge[];
  loading: boolean;
  error: string | null;
  isEmpty: boolean;
  stats: { projects: number; nodes: number; workspaces: number; sessions: number; tasks: number };
  refresh: () => void;
  reorganize: () => void;
}

export function useAccountMapData({ isMobile, activeOnly }: UseAccountMapDataOptions): UseAccountMapDataResult {
  const [rawData, setRawData] = useState<AccountMapResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [layoutKey, setLayoutKey] = useState(0);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getAccountMap({ activeOnly });
      setRawData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load account map');
    } finally {
      setLoading(false);
    }
  }, [activeOnly]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const { nodes, edges, stats, isEmpty } = useMemo(() => {
    if (!rawData) {
      return {
        nodes: [] as Node[],
        edges: [] as Edge[],
        stats: { projects: 0, nodes: 0, workspaces: 0, sessions: 0, tasks: 0 },
        isEmpty: true,
      };
    }

    const flowNodes: Node[] = [];

    // Count relationships for enrichment
    const workspacesByProject = new Map<string, number>();
    const sessionsByProject = new Map<string, number>();
    const tasksByProject = new Map<string, number>();

    for (const ws of rawData.workspaces) {
      if (ws.projectId) {
        workspacesByProject.set(ws.projectId, (workspacesByProject.get(ws.projectId) ?? 0) + 1);
      }
    }
    for (const s of rawData.sessions) {
      sessionsByProject.set(s.projectId, (sessionsByProject.get(s.projectId) ?? 0) + 1);
    }
    for (const t of rawData.tasks) {
      if (t.projectId) {
        tasksByProject.set(t.projectId, (tasksByProject.get(t.projectId) ?? 0) + 1);
      }
    }

    // Projects
    for (const p of rawData.projects) {
      flowNodes.push({
        id: p.id,
        type: 'projectNode',
        position: { x: 0, y: 0 },
        data: {
          label: p.name,
          repository: p.repository,
          status: p.status,
          lastActivityAt: p.lastActivityAt,
          activeSessionCount: p.activeSessionCount,
          workspaceCount: workspacesByProject.get(p.id) ?? 0,
          sessionCount: sessionsByProject.get(p.id) ?? 0,
          taskCount: tasksByProject.get(p.id) ?? 0,
          isMobile,
        },
      });
    }

    // Nodes (VMs)
    for (const n of rawData.nodes) {
      flowNodes.push({
        id: n.id,
        type: 'nodeVMNode',
        position: { x: 0, y: 0 },
        data: {
          label: n.name,
          status: n.status,
          vmSize: n.vmSize,
          vmLocation: n.vmLocation,
          cloudProvider: n.cloudProvider,
          ipAddress: n.ipAddress,
          healthStatus: n.healthStatus,
          isMobile,
        },
      });
    }

    // Workspaces
    for (const ws of rawData.workspaces) {
      flowNodes.push({
        id: ws.id,
        type: 'workspaceNode',
        position: { x: 0, y: 0 },
        data: {
          label: ws.displayName ?? ws.id.slice(0, 8),
          branch: ws.branch,
          status: ws.status,
          vmSize: ws.vmSize,
          isMobile,
        },
      });
    }

    // Sessions
    for (const s of rawData.sessions) {
      flowNodes.push({
        id: s.id,
        type: 'sessionNode',
        position: { x: 0, y: 0 },
        data: {
          label: s.topic ?? 'Chat Session',
          status: s.status,
          messageCount: s.messageCount,
          isMobile,
        },
      });
    }

    // Tasks
    for (const t of rawData.tasks) {
      flowNodes.push({
        id: t.id,
        type: 'taskNode',
        position: { x: 0, y: 0 },
        data: {
          label: t.title ?? 'Task',
          status: t.status,
          executionStep: t.executionStep,
          priority: t.priority,
          isMobile,
        },
      });
    }

    // Edges
    const flowEdges: Edge[] = rawData.relationships.map((rel, i) => ({
      id: `e-${rel.source}-${rel.target}-${i}`,
      source: rel.source,
      target: rel.target,
      type: 'animatedFlow',
      data: {
        color: EDGE_COLORS[rel.type] ?? '#29423b',
        active: rel.active,
      },
    }));

    // Only include edges where both source and target exist in nodes
    const nodeIds = new Set(flowNodes.map((n) => n.id));
    const validEdges = flowEdges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));

    // Apply layout
    const layoutedNodes = applyDagreLayout(flowNodes, validEdges);

    const totalEntities =
      rawData.projects.length +
      rawData.nodes.length +
      rawData.workspaces.length +
      rawData.sessions.length +
      rawData.tasks.length;

    return {
      nodes: layoutedNodes,
      edges: validEdges,
      stats: {
        projects: rawData.projects.length,
        nodes: rawData.nodes.length,
        workspaces: rawData.workspaces.length,
        sessions: rawData.sessions.length,
        tasks: rawData.tasks.length,
      },
      isEmpty: totalEntities === 0,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawData, isMobile, layoutKey]);

  const reorganize = useCallback(() => {
    setLayoutKey((k) => k + 1);
  }, []);

  return { nodes, edges, loading, error, isEmpty, stats, refresh: fetchData, reorganize };
}
