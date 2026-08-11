import type {
  NodeMetrics,
  PlacementExplanation,
  PlacementNodeEvaluation,
  PlacementSelectionPath,
  VMSize,
} from '@simple-agent-manager/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import * as nodeLifecycle from './node-lifecycle';
import {
  createPlacementExplanation,
  evaluatePlacementNode,
  type PlacementLimitsEnv,
  type PlacementLimitsOverride,
  placementLoadScore,
  type PlacementNodeInput,
  requireProvisioning,
  resolvePlacementRequest,
  selectPlacementNode,
} from './placement-explanation';

export interface NodeCandidate {
  id: string;
  status: string;
  healthStatus: string;
  vmSize: string;
  vmLocation: string;
  lastMetrics: NodeMetrics | null;
  activeWorkspaceCount: number;
}

export interface NodeSelectorEnv extends PlacementLimitsEnv {
  NODE_LIFECYCLE?: DurableObjectNamespace;
}

export interface NodePlacementOptions {
  vmSize: VMSize;
  vmLocation: string;
  taskId?: string;
  preferredNodeId?: string;
  preferredOnly?: boolean;
  selectionPath?: 'trial' | 'manual';
  limits?: PlacementLimitsOverride;
  nowMs?: number;
}

export interface NodePlacementResult {
  node: NodeCandidate | null;
  explanation: PlacementExplanation;
}

type PlacementDb = ReturnType<typeof drizzle<typeof schema>>;

function parseMetrics(raw: string | null): NodeMetrics | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const candidate = value as Record<string, unknown>;
    if (
      ['cpuLoadAvg1', 'memoryPercent', 'diskPercent'].some(
        (field) =>
          field in candidate &&
          (typeof candidate[field] !== 'number' || !Number.isFinite(candidate[field]))
      )
    ) {
      return null;
    }
    const metrics: NodeMetrics = {};
    if (typeof candidate.cpuLoadAvg1 === 'number' && Number.isFinite(candidate.cpuLoadAvg1)) {
      metrics.cpuLoadAvg1 = candidate.cpuLoadAvg1;
    }
    if (typeof candidate.memoryPercent === 'number' && Number.isFinite(candidate.memoryPercent)) {
      metrics.memoryPercent = candidate.memoryPercent;
    }
    if (typeof candidate.diskPercent === 'number' && Number.isFinite(candidate.diskPercent)) {
      metrics.diskPercent = candidate.diskPercent;
    }
    return Object.keys(metrics).length > 0 ? metrics : null;
  } catch {
    return null;
  }
}

export function scoreNodeLoad(metrics: NodeMetrics | null): number | null {
  if (!metrics) return null;
  return (metrics.cpuLoadAvg1 ?? 0) * 0.4 + (metrics.memoryPercent ?? 0) * 0.6;
}

export function nodeHasCapacity(
  metrics: NodeMetrics | null,
  cpuThreshold: number,
  memoryThreshold: number
): boolean {
  if (!metrics) return true;
  return (
    (metrics.cpuLoadAvg1 ?? 0) < cpuThreshold && (metrics.memoryPercent ?? 0) < memoryThreshold
  );
}

async function loadPlacementNodes(db: PlacementDb, userId: string): Promise<PlacementNodeInput[]> {
  const rows = await db
    .select({
      id: schema.nodes.id,
      status: schema.nodes.status,
      runtime: schema.nodes.runtime,
      vmSize: schema.nodes.vmSize,
      vmLocation: schema.nodes.vmLocation,
      healthStatus: schema.nodes.healthStatus,
      lastHeartbeatAt: schema.nodes.lastHeartbeatAt,
      agentReadyAt: schema.nodes.agentReadyAt,
      agentVersion: schema.nodes.agentVersion,
      lastMetrics: schema.nodes.lastMetrics,
      warmSince: schema.nodes.warmSince,
    })
    .from(schema.nodes)
    .where(and(eq(schema.nodes.userId, userId), eq(schema.nodes.nodeRole, 'workspace')));

  if (rows.length === 0) return [];
  const counts = await db
    .select({ nodeId: schema.workspaces.nodeId, id: schema.workspaces.id })
    .from(schema.workspaces)
    .where(
      and(
        eq(schema.workspaces.userId, userId),
        inArray(schema.workspaces.status, ['running', 'creating', 'recovery'])
      )
    );
  const countByNode = new Map<string, number>();
  for (const row of counts) {
    if (row.nodeId) countByNode.set(row.nodeId, (countByNode.get(row.nodeId) ?? 0) + 1);
  }
  return rows.map((row) => ({
    ...row,
    activeWorkspaceCount: countByNode.get(row.id) ?? 0,
  }));
}

function toCandidate(node: PlacementNodeInput): NodeCandidate {
  return {
    id: node.id,
    status: node.status,
    healthStatus: node.healthStatus ?? 'unknown',
    vmSize: node.vmSize,
    vmLocation: node.vmLocation,
    lastMetrics: parseMetrics(node.lastMetrics),
    activeWorkspaceCount: node.activeWorkspaceCount,
  };
}

function sortEvaluations(
  evaluations: PlacementNodeEvaluation[],
  vmSize: string,
  vmLocation: string
): PlacementNodeEvaluation[] {
  return evaluations.sort((a, b) => {
    const aLocation = a.snapshot.vmLocation === vmLocation ? 1 : 0;
    const bLocation = b.snapshot.vmLocation === vmLocation ? 1 : 0;
    if (aLocation !== bLocation) return bLocation - aLocation;
    const aSize = a.snapshot.vmSize === vmSize ? 1 : 0;
    const bSize = b.snapshot.vmSize === vmSize ? 1 : 0;
    if (aSize !== bSize) return bSize - aSize;
    const aScore = placementLoadScore(a);
    const bScore = placementLoadScore(b);
    if (aScore === null && bScore === null) return a.nodeId.localeCompare(b.nodeId);
    if (aScore === null) return 1;
    if (bScore === null) return -1;
    return aScore - bScore || a.nodeId.localeCompare(b.nodeId);
  });
}

function missingPreferredEvaluation(
  nodeId: string,
  path: 'preferred' | 'manual'
): PlacementNodeEvaluation {
  return {
    nodeId,
    path,
    accepted: false,
    rejectionReasons: ['node-not-found'],
    snapshot: {
      runtime: 'vm',
      vmSize: 'unknown',
      vmLocation: 'unknown',
      healthStatus: 'unknown',
      agentVersionCompatible: false,
      heartbeatAgeSeconds: null,
      activeWorkspaceCount: 0,
      cpuLoadAvg1: null,
      memoryPercent: null,
    },
  };
}

export async function selectNodeWithExplanation(
  db: PlacementDb,
  userId: string,
  env: NodeSelectorEnv,
  options: NodePlacementOptions
): Promise<NodePlacementResult> {
  const nowMs = options.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const request = resolvePlacementRequest(env, options.vmSize, options.vmLocation, options.limits);
  const initialPath: PlacementSelectionPath = options.preferredNodeId
    ? options.selectionPath === 'manual'
      ? 'manual'
      : 'preferred'
    : (options.selectionPath ?? 'capacity');
  let explanation = createPlacementExplanation(request, initialPath, now);
  const nodes = await loadPlacementNodes(db, userId);

  if (options.preferredNodeId) {
    const node = nodes.find((candidate) => candidate.id === options.preferredNodeId);
    const path = initialPath as 'preferred' | 'manual';
    const evaluation = node
      ? evaluatePlacementNode(node, request, path, env.VM_AGENT_REQUIRED_VERSION, nowMs)
      : missingPreferredEvaluation(options.preferredNodeId, path);
    explanation.evaluatedNodes.push(evaluation);
    if (node && evaluation.accepted) {
      return {
        node: toCandidate(node),
        explanation: selectPlacementNode(explanation, evaluation, now),
      };
    }
    explanation.summary = `Preferred node ${options.preferredNodeId} was rejected.`;
    explanation.outcome = 'failed';
    return { node: null, explanation };
  }

  if (options.taskId && env.NODE_LIFECYCLE && !options.selectionPath) {
    const warmExclusions = new Map<string, PlacementNodeEvaluation['rejectionReasons']>();
    const warmEvaluations = sortEvaluations(
      nodes.map((node) =>
        evaluatePlacementNode(node, request, 'warm', env.VM_AGENT_REQUIRED_VERSION, nowMs)
      ),
      options.vmSize,
      options.vmLocation
    );
    explanation.evaluatedNodes.push(...warmEvaluations);
    for (const evaluation of warmEvaluations.filter((item) => item.accepted)) {
      let claimLost = true;
      try {
        const claimed = await nodeLifecycle.tryClaim(
          env as unknown as import('../env').Env,
          evaluation.nodeId,
          options.taskId
        );
        if (claimed.claimed) {
          claimLost = false;
          // Re-read D1 after the atomic claim. A heartbeat, compatibility marker,
          // or workspace count can change between the candidate read and claim.
          const freshNode = (await loadPlacementNodes(db, userId)).find(
            (candidate) => candidate.id === evaluation.nodeId
          );
          const freshEvaluation = freshNode
            ? evaluatePlacementNode(
                freshNode,
                request,
                'capacity',
                env.VM_AGENT_REQUIRED_VERSION,
                nowMs
              )
            : missingPreferredEvaluation(evaluation.nodeId, 'preferred');
          if (freshNode && freshEvaluation.accepted) {
            evaluation.snapshot = freshEvaluation.snapshot;
            return {
              node: toCandidate(freshNode),
              explanation: selectPlacementNode(explanation, evaluation, now),
            };
          }
          evaluation.accepted = false;
          evaluation.rejectionReasons = freshEvaluation.rejectionReasons;
        }
      } catch {
        // The typed reason below intentionally replaces raw DO/provider errors.
      }
      evaluation.accepted = false;
      if (claimLost) evaluation.rejectionReasons.push('warm-claim-lost');
      warmExclusions.set(evaluation.nodeId, evaluation.rejectionReasons);
    }
    const evaluations = sortEvaluations(
      nodes.map((node) => {
        const evaluation = evaluatePlacementNode(
          node,
          request,
          'capacity',
          env.VM_AGENT_REQUIRED_VERSION,
          nowMs
        );
        const exclusionReasons = warmExclusions.get(evaluation.nodeId);
        if (exclusionReasons) {
          evaluation.accepted = false;
          evaluation.rejectionReasons = [
            ...new Set([...evaluation.rejectionReasons, ...exclusionReasons]),
          ];
        }
        return evaluation;
      }),
      options.vmSize,
      options.vmLocation
    );
    explanation.evaluatedNodes.push(...evaluations);
    const selected = evaluations.find((evaluation) => evaluation.accepted);
    const selectedNode = selected
      ? (nodes.find((candidate) => candidate.id === selected.nodeId) ?? null)
      : null;
    if (selected && selectedNode) {
      return {
        node: toCandidate(selectedNode),
        explanation: selectPlacementNode(explanation, selected, now),
      };
    }
  } else {
    const capacityPath = options.selectionPath ?? 'capacity';
    const evaluations = sortEvaluations(
      nodes.map((node) =>
        evaluatePlacementNode(node, request, capacityPath, env.VM_AGENT_REQUIRED_VERSION, nowMs)
      ),
      options.vmSize,
      options.vmLocation
    );
    explanation.evaluatedNodes.push(...evaluations);
    const selected = evaluations.find((evaluation) => evaluation.accepted);
    const selectedNode = selected
      ? (nodes.find((candidate) => candidate.id === selected.nodeId) ?? null)
      : null;
    if (selected && selectedNode) {
      return {
        node: toCandidate(selectedNode),
        explanation: selectPlacementNode(explanation, selected, now),
      };
    }
  }
  explanation = requireProvisioning(explanation, now);
  return { node: null, explanation };
}

/** Backward-compatible selector wrapper for callers that only need the selected node. */
export async function selectNodeForTaskRun(
  db: PlacementDb,
  userId: string,
  env: NodeSelectorEnv,
  preferredLocation = 'nbg1',
  preferredSize: string = 'medium',
  taskId?: string
): Promise<NodeCandidate | null> {
  const vmSize = ['small', 'medium', 'large'].includes(preferredSize)
    ? (preferredSize as VMSize)
    : 'medium';
  return (
    await selectNodeWithExplanation(db, userId, env, {
      vmSize,
      vmLocation: preferredLocation,
      taskId,
    })
  ).node;
}
