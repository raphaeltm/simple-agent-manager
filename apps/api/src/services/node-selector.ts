import { and, eq, count } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import {
  DEFAULT_TASK_RUN_NODE_CPU_THRESHOLD_PERCENT,
  DEFAULT_TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT,
} from '@simple-agent-manager/shared';
import type { NodeMetrics } from '@simple-agent-manager/shared';
import * as schema from '../db/schema';

export interface NodeCandidate {
  id: string;
  status: string;
  healthStatus: string;
  vmSize: string;
  vmLocation: string;
  lastMetrics: NodeMetrics | null;
  activeWorkspaceCount: number;
}

export interface NodeSelectionResult {
  nodeId: string;
  autoProvisioned: boolean;
}

export interface NodeSelectorEnv {
  TASK_RUN_NODE_CPU_THRESHOLD_PERCENT?: string;
  TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT?: string;
  MAX_WORKSPACES_PER_NODE?: string;
}

function parseThreshold(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return fallback;
  return parsed;
}

function parseMetrics(raw: string | null): NodeMetrics | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (typeof parsed.cpuLoadAvg1 === 'number' ||
        typeof parsed.memoryPercent === 'number' ||
        typeof parsed.diskPercent === 'number')
    ) {
      return parsed as NodeMetrics;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Score a node by its resource usage. Lower score = more available capacity.
 * Returns a value between 0 and 100, where 0 is fully idle and 100 is fully loaded.
 * Returns null if metrics are unavailable (node can still be used but ranked lower).
 */
export function scoreNodeLoad(metrics: NodeMetrics | null): number | null {
  if (!metrics) return null;

  const cpu = metrics.cpuLoadAvg1 ?? 0;
  const memory = metrics.memoryPercent ?? 0;

  // Weighted average: 40% CPU, 60% memory (memory is more constraining for agent workloads)
  return cpu * 0.4 + memory * 0.6;
}

/**
 * Determine if a node has capacity for another workspace based on resource thresholds.
 */
export function nodeHasCapacity(
  metrics: NodeMetrics | null,
  activeWorkspaceCount: number,
  maxWorkspacesPerNode: number,
  cpuThreshold: number,
  memoryThreshold: number
): boolean {
  if (activeWorkspaceCount >= maxWorkspacesPerNode) {
    return false;
  }

  if (!metrics) {
    // If no metrics available, allow it if workspace count is under limit
    return true;
  }

  const cpu = metrics.cpuLoadAvg1 ?? 0;
  const memory = metrics.memoryPercent ?? 0;

  return cpu < cpuThreshold && memory < memoryThreshold;
}

/**
 * Select the best available node for a task run, or indicate that a new node is needed.
 *
 * Selection algorithm:
 * 1. Get all running, healthy (or stale) nodes for the user
 * 2. For each node, check workspace count and resource metrics
 * 3. Filter to nodes with capacity
 * 4. If a specific vmLocation is requested, prefer nodes in that location
 * 5. Sort by load score (lowest first) — prefer the least loaded node
 * 6. Return the best node, or null if no node has capacity
 */
export async function selectNodeForTaskRun(
  db: ReturnType<typeof drizzle<typeof schema>>,
  userId: string,
  env: NodeSelectorEnv,
  preferredLocation?: string,
  preferredSize?: string
): Promise<NodeCandidate | null> {
  const cpuThreshold = parseThreshold(
    env.TASK_RUN_NODE_CPU_THRESHOLD_PERCENT,
    DEFAULT_TASK_RUN_NODE_CPU_THRESHOLD_PERCENT
  );
  const memoryThreshold = parseThreshold(
    env.TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT,
    DEFAULT_TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT
  );
  const maxWorkspacesPerNode = env.MAX_WORKSPACES_PER_NODE
    ? Number.parseInt(env.MAX_WORKSPACES_PER_NODE, 10) || 10
    : 10;

  // Get all running nodes for this user
  const nodes = await db
    .select()
    .from(schema.nodes)
    .where(
      and(
        eq(schema.nodes.userId, userId),
        eq(schema.nodes.status, 'running')
      )
    );

  if (nodes.length === 0) {
    return null;
  }

  // Get active workspace counts per node
  const candidates: NodeCandidate[] = [];
  for (const node of nodes) {
    // Skip unhealthy nodes
    if (node.healthStatus === 'unhealthy') {
      continue;
    }

    const [wsCountRow] = await db
      .select({ count: count() })
      .from(schema.workspaces)
      .where(
        and(
          eq(schema.workspaces.nodeId, node.id),
          eq(schema.workspaces.userId, userId)
        )
      );

    const activeCount = wsCountRow?.count ?? 0;
    const metrics = parseMetrics(node.lastMetrics);

    const candidate: NodeCandidate = {
      id: node.id,
      status: node.status,
      healthStatus: node.healthStatus,
      vmSize: node.vmSize,
      vmLocation: node.vmLocation,
      lastMetrics: metrics,
      activeWorkspaceCount: activeCount,
    };

    if (nodeHasCapacity(metrics, activeCount, maxWorkspacesPerNode, cpuThreshold, memoryThreshold)) {
      candidates.push(candidate);
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  // Sort candidates: prefer matching location/size, then lowest load
  candidates.sort((a, b) => {
    // Prefer matching location
    const aLocationMatch = preferredLocation && a.vmLocation === preferredLocation ? 1 : 0;
    const bLocationMatch = preferredLocation && b.vmLocation === preferredLocation ? 1 : 0;
    if (aLocationMatch !== bLocationMatch) return bLocationMatch - aLocationMatch;

    // Prefer matching size
    const aSizeMatch = preferredSize && a.vmSize === preferredSize ? 1 : 0;
    const bSizeMatch = preferredSize && b.vmSize === preferredSize ? 1 : 0;
    if (aSizeMatch !== bSizeMatch) return bSizeMatch - aSizeMatch;

    // Prefer lowest load score
    const aScore = scoreNodeLoad(a.lastMetrics);
    const bScore = scoreNodeLoad(b.lastMetrics);
    if (aScore === null && bScore === null) return 0;
    if (aScore === null) return 1;
    if (bScore === null) return -1;
    return aScore - bScore;
  });

  return candidates[0]!;
}
