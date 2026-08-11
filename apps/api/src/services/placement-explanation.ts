import type {
  PlacementExplanation,
  PlacementNodeEvaluation,
  PlacementProvisioningAttempt,
  PlacementProvisioningFailureReason,
  PlacementRequestSnapshot,
  PlacementSelectionPath,
  VMSize,
} from '@simple-agent-manager/shared';
import {
  canSatisfyVmSize,
  DEFAULT_MAX_WORKSPACES_PER_NODE,
  DEFAULT_NODE_HEARTBEAT_STALE_SECONDS,
  DEFAULT_TASK_RUN_NODE_CPU_THRESHOLD_PERCENT,
  DEFAULT_TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT,
  isSafeVmLocationId,
} from '@simple-agent-manager/shared';

import { isNodeAgentVersionCompatible } from './node-agent-compatibility';

export interface PlacementLimitsEnv {
  TASK_RUN_NODE_CPU_THRESHOLD_PERCENT?: string;
  TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT?: string;
  MAX_WORKSPACES_PER_NODE?: string;
  NODE_HEARTBEAT_STALE_SECONDS?: string;
  VM_AGENT_REQUIRED_VERSION?: string;
}

export interface PlacementLimitsOverride {
  cpuThresholdPercent?: number;
  memoryThresholdPercent?: number;
  maxWorkspacesPerNode?: number;
  heartbeatStaleSeconds?: number;
}

export interface PlacementNodeInput {
  id: string;
  status: string;
  runtime: string | null;
  vmSize: string;
  vmLocation: string;
  healthStatus: string | null;
  lastHeartbeatAt: string | null;
  agentReadyAt: string | null;
  agentVersion: string | null;
  lastMetrics: string | null;
  activeWorkspaceCount: number;
  warmSince: string | null;
}

function envInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max = Number.MAX_SAFE_INTEGER
): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function overrideInt(
  value: number | undefined,
  fallback: number,
  min: number,
  max?: number
): number {
  return value === undefined ||
    !Number.isSafeInteger(value) ||
    value < min ||
    (max !== undefined && value > max)
    ? fallback
    : value;
}

function bounded(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min
    ? Math.min(value, max)
    : null;
}

function safeLocation(value: string): string {
  const normalized = value.trim();
  return isSafeVmLocationId(normalized) ? normalized : 'unknown';
}

function parseMetricSnapshot(raw: string | null): {
  cpuLoadAvg1: number | null;
  memoryPercent: number | null;
} {
  if (!raw) return { cpuLoadAvg1: null, memoryPercent: null };
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { cpuLoadAvg1: null, memoryPercent: null };
    }
    const metrics = value as Record<string, unknown>;
    const invalidRecognizedField = ['cpuLoadAvg1', 'memoryPercent'].some(
      (field) =>
        field in metrics && (typeof metrics[field] !== 'number' || !Number.isFinite(metrics[field]))
    );
    if (invalidRecognizedField) return { cpuLoadAvg1: null, memoryPercent: null };
    return {
      cpuLoadAvg1: bounded(metrics.cpuLoadAvg1, 0, 100),
      memoryPercent: bounded(metrics.memoryPercent, 0, 100),
    };
  } catch {
    return { cpuLoadAvg1: null, memoryPercent: null };
  }
}

export function resolvePlacementRequest(
  env: PlacementLimitsEnv,
  vmSize: VMSize,
  vmLocation: string,
  override: PlacementLimitsOverride = {}
): PlacementRequestSnapshot {
  return {
    runtime: 'vm',
    vmSize,
    vmLocation: safeLocation(vmLocation),
    maxWorkspacesPerNode: overrideInt(
      override.maxWorkspacesPerNode,
      envInt(env.MAX_WORKSPACES_PER_NODE, DEFAULT_MAX_WORKSPACES_PER_NODE, 1),
      1
    ),
    cpuThresholdPercent: overrideInt(
      override.cpuThresholdPercent,
      envInt(
        env.TASK_RUN_NODE_CPU_THRESHOLD_PERCENT,
        DEFAULT_TASK_RUN_NODE_CPU_THRESHOLD_PERCENT,
        0,
        100
      ),
      0,
      100
    ),
    memoryThresholdPercent: overrideInt(
      override.memoryThresholdPercent,
      envInt(
        env.TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT,
        DEFAULT_TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT,
        0,
        100
      ),
      0,
      100
    ),
    heartbeatStaleSeconds: overrideInt(
      override.heartbeatStaleSeconds,
      envInt(env.NODE_HEARTBEAT_STALE_SECONDS, DEFAULT_NODE_HEARTBEAT_STALE_SECONDS, 1),
      1
    ),
  };
}

export function createPlacementExplanation(
  request: PlacementRequestSnapshot,
  selectionPath: PlacementSelectionPath,
  now = new Date().toISOString()
): PlacementExplanation {
  return {
    schemaVersion: 2,
    outcome: selectionPath === 'preferred' || selectionPath === 'manual' ? 'failed' : 'provisioned',
    selectionPath,
    selectedNodeId: null,
    summary: 'No reusable node qualified; provisioning is required.',
    request,
    evaluatedNodes: [],
    provisioningAttempts: [],
    decidedAt: now,
    updatedAt: now,
  };
}

export function evaluatePlacementNode(
  node: PlacementNodeInput,
  request: PlacementRequestSnapshot,
  path: Exclude<PlacementSelectionPath, 'provisioning'>,
  requiredAgentVersion: string | undefined,
  nowMs = Date.now()
): PlacementNodeEvaluation {
  const reasons: PlacementNodeEvaluation['rejectionReasons'] = [];
  const metrics = parseMetricSnapshot(node.lastMetrics);
  const heartbeatMs = node.lastHeartbeatAt ? Date.parse(node.lastHeartbeatAt) : Number.NaN;
  const heartbeatAgeSeconds = Number.isFinite(heartbeatMs)
    ? bounded(Math.max(0, (nowMs - heartbeatMs) / 1000), 0, Number.MAX_SAFE_INTEGER)
    : null;
  const agentVersionCompatible = isNodeAgentVersionCompatible(
    node.agentVersion,
    requiredAgentVersion
  );

  if (node.status !== 'running') reasons.push('not-running');
  if (node.runtime === 'cf-container') reasons.push('wrong-runtime');
  if (node.healthStatus !== 'healthy') reasons.push('unhealthy');
  if (!node.lastHeartbeatAt || heartbeatAgeSeconds === null) reasons.push('heartbeat-missing');
  else if (heartbeatAgeSeconds >= request.heartbeatStaleSeconds) reasons.push('heartbeat-stale');
  if (!node.agentReadyAt) reasons.push('agent-not-ready');
  if (!agentVersionCompatible) reasons.push('agent-version-mismatch');
  if (!canSatisfyVmSize(node.vmSize, request.vmSize)) reasons.push('undersized');
  if (node.activeWorkspaceCount >= request.maxWorkspacesPerNode) {
    reasons.push('workspace-limit');
  }
  if (metrics.cpuLoadAvg1 !== null && metrics.cpuLoadAvg1 >= request.cpuThresholdPercent) {
    reasons.push('cpu-threshold');
  }
  if (metrics.memoryPercent !== null && metrics.memoryPercent >= request.memoryThresholdPercent) {
    reasons.push('memory-threshold');
  }
  if (path === 'warm' && !node.warmSince) reasons.push('not-warm');

  const healthStatus = ['healthy', 'stale', 'unhealthy'].includes(node.healthStatus ?? '')
    ? (node.healthStatus as 'healthy' | 'stale' | 'unhealthy')
    : 'unknown';
  return {
    nodeId: node.id,
    path,
    accepted: reasons.length === 0,
    rejectionReasons: reasons,
    snapshot: {
      runtime: node.runtime === 'cf-container' ? 'other' : 'vm',
      vmSize: node.vmSize,
      vmLocation: safeLocation(node.vmLocation),
      healthStatus,
      agentVersionCompatible,
      heartbeatAgeSeconds,
      activeWorkspaceCount: Math.max(
        0,
        Math.min(node.activeWorkspaceCount, Number.MAX_SAFE_INTEGER)
      ),
      cpuLoadAvg1: metrics.cpuLoadAvg1,
      memoryPercent: metrics.memoryPercent,
    },
  };
}

export function selectPlacementNode(
  explanation: PlacementExplanation,
  evaluation: PlacementNodeEvaluation,
  now = new Date().toISOString()
): PlacementExplanation {
  return {
    ...explanation,
    outcome: 'reused',
    selectionPath: evaluation.path,
    selectedNodeId: evaluation.nodeId,
    summary: `Reused node ${evaluation.nodeId} through the ${evaluation.path} path.`,
    updatedAt: now,
  };
}

/**
 * Remove cross-project/trial host identifiers from rejected candidates before
 * any placement explanation is persisted, logged, or exposed. The selected
 * node remains visible because it is already part of the workspace contract.
 */
export function sanitizePlacementExplanation(
  explanation: PlacementExplanation
): PlacementExplanation {
  const aliases = new Map<string, string>();
  const evaluatedNodes = explanation.evaluatedNodes.map((evaluation) => {
    if (evaluation.nodeId === explanation.selectedNodeId) return evaluation;
    let alias = aliases.get(evaluation.nodeId);
    if (!alias) {
      alias = `candidate-${aliases.size + 1}`;
      aliases.set(evaluation.nodeId, alias);
    }
    return { ...evaluation, nodeId: alias };
  });
  return {
    ...explanation,
    request: {
      ...explanation.request,
      vmLocation: safeLocation(explanation.request.vmLocation),
    },
    evaluatedNodes,
    provisioningAttempts: explanation.provisioningAttempts.map((attempt) => ({
      ...attempt,
      vmLocation: safeLocation(attempt.vmLocation),
    })),
  };
}

export function requireProvisioning(
  explanation: PlacementExplanation,
  now = new Date().toISOString()
): PlacementExplanation {
  return {
    ...explanation,
    outcome: 'provisioned',
    selectionPath: 'provisioning',
    selectedNodeId: null,
    summary: 'No reusable node qualified; provisioning a new node.',
    updatedAt: now,
  };
}

export function appendProvisioningAttempt(
  explanation: PlacementExplanation,
  attempt: PlacementProvisioningAttempt,
  selectedNodeId?: string | null,
  now = new Date().toISOString()
): PlacementExplanation {
  const resolvedNodeId = selectedNodeId === undefined ? explanation.selectedNodeId : selectedNodeId;
  return {
    ...explanation,
    outcome: attempt.outcome === 'failed' ? 'failed' : 'provisioned',
    selectionPath: 'provisioning',
    selectedNodeId: resolvedNodeId,
    summary:
      attempt.outcome === 'succeeded'
        ? `Provisioned node ${resolvedNodeId ?? 'successfully'}.`
        : attempt.outcome === 'failed'
          ? 'Node provisioning failed.'
          : 'Provisioning a new node.',
    provisioningAttempts: [
      ...explanation.provisioningAttempts,
      { ...attempt, vmLocation: safeLocation(attempt.vmLocation) },
    ],
    updatedAt: now,
  };
}

export function failPlacement(
  explanation: PlacementExplanation,
  failureReason: PlacementProvisioningFailureReason,
  vmSize = explanation.request.vmSize,
  vmLocation = explanation.request.vmLocation,
  now = new Date().toISOString()
): PlacementExplanation {
  return appendProvisioningAttempt(
    explanation,
    { vmSize, vmLocation, outcome: 'failed', failureReason },
    explanation.selectedNodeId,
    now
  );
}

export function placementLoadScore(evaluation: PlacementNodeEvaluation): number | null {
  const { cpuLoadAvg1, memoryPercent } = evaluation.snapshot;
  if (cpuLoadAvg1 === null && memoryPercent === null) return null;
  return Math.max(cpuLoadAvg1 ?? 0, memoryPercent ?? 0);
}
