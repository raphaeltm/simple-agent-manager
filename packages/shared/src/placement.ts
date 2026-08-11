import type {
  LegacyPlacementExplanation,
  PlacementExplanation,
  PlacementNodeEvaluation,
  PlacementNodeSnapshot,
  PlacementProvisioningAttempt,
  PlacementRejectionReason,
  PlacementRequestSnapshot,
  PlacementSelectionPath,
  ResourceRequirementsSource,
} from './types/resource';
import type { VMSize } from './types/workspace';

const VM_SIZES = new Set<VMSize>(['small', 'medium', 'large']);
const PATHS = new Set<PlacementSelectionPath>([
  'preferred',
  'warm',
  'capacity',
  'trial',
  'manual',
  'provisioning',
]);
const REJECTIONS = new Set<PlacementRejectionReason>([
  'node-not-found',
  'not-running',
  'wrong-runtime',
  'unhealthy',
  'heartbeat-missing',
  'heartbeat-stale',
  'agent-not-ready',
  'agent-version-mismatch',
  'undersized',
  'workspace-limit',
  'cpu-threshold',
  'memory-threshold',
  'not-warm',
  'warm-claim-lost',
]);
const PROVISIONING_OUTCOMES = new Set<PlacementProvisioningAttempt['outcome']>([
  'started',
  'succeeded',
  'capacity-rejected',
  'failed',
]);
const PROVISIONING_FAILURES = new Set<NonNullable<PlacementProvisioningAttempt['failureReason']>>([
  'capacity-unavailable',
  'node-limit',
  'quota-exceeded',
  'credentials-unavailable',
  'provider-failed',
  'provisioning-timeout',
  'readiness-timeout',
  'node-unavailable',
]);
const RESOURCE_SOURCES = new Set<ResourceRequirementsSource>([
  'task',
  'trigger',
  'skill',
  'agent-profile',
  'project',
  'user',
  'platform',
]);
const VM_SIZE_SOURCES = new Set<ResourceRequirementsSource | 'explicit'>([
  ...RESOURCE_SOURCES,
  'explicit',
]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null;
}

function stringValue(value: unknown, maxLength = 256): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : null;
}

function vmSize(value: unknown): VMSize | null {
  return typeof value === 'string' && VM_SIZES.has(value as VMSize) ? (value as VMSize) : null;
}

function parseRequest(value: unknown): PlacementRequestSnapshot | null {
  const raw = record(value);
  const size = vmSize(raw?.vmSize);
  const location = stringValue(raw?.vmLocation, 64);
  const maxWorkspaces = finiteNumber(raw?.maxWorkspacesPerNode, 1);
  const cpu = finiteNumber(raw?.cpuThresholdPercent, 0, 100);
  const memory = finiteNumber(raw?.memoryThresholdPercent, 0, 100);
  const stale = finiteNumber(raw?.heartbeatStaleSeconds, 1);
  if (
    raw?.runtime !== 'vm' ||
    !size ||
    !location ||
    maxWorkspaces === null ||
    cpu === null ||
    memory === null ||
    stale === null
  ) {
    return null;
  }
  return {
    runtime: 'vm',
    vmSize: size,
    vmLocation: location,
    maxWorkspacesPerNode: maxWorkspaces,
    cpuThresholdPercent: cpu,
    memoryThresholdPercent: memory,
    heartbeatStaleSeconds: stale,
  };
}

function parseSnapshot(value: unknown): PlacementNodeSnapshot | null {
  const raw = record(value);
  const size = stringValue(raw?.vmSize, 32);
  const location = stringValue(raw?.vmLocation, 64);
  const active = finiteNumber(raw?.activeWorkspaceCount);
  const heartbeat =
    raw?.heartbeatAgeSeconds === null ? null : finiteNumber(raw?.heartbeatAgeSeconds);
  const cpu = raw?.cpuLoadAvg1 === null ? null : finiteNumber(raw?.cpuLoadAvg1, 0, 100);
  const memory = raw?.memoryPercent === null ? null : finiteNumber(raw?.memoryPercent, 0, 100);
  if (
    (raw?.runtime !== 'vm' && raw?.runtime !== 'other') ||
    !size ||
    !location ||
    !['healthy', 'stale', 'unhealthy', 'unknown'].includes(String(raw?.healthStatus)) ||
    typeof raw?.agentVersionCompatible !== 'boolean' ||
    active === null ||
    (raw?.heartbeatAgeSeconds !== null && heartbeat === null) ||
    (raw?.cpuLoadAvg1 !== null && cpu === null) ||
    (raw?.memoryPercent !== null && memory === null)
  ) {
    return null;
  }
  return {
    runtime: raw.runtime,
    vmSize: size,
    vmLocation: location,
    healthStatus: raw.healthStatus as PlacementNodeSnapshot['healthStatus'],
    agentVersionCompatible: raw.agentVersionCompatible,
    heartbeatAgeSeconds: heartbeat,
    activeWorkspaceCount: active,
    cpuLoadAvg1: cpu,
    memoryPercent: memory,
  };
}

function parseEvaluation(value: unknown): PlacementNodeEvaluation | null {
  const raw = record(value);
  const nodeId = stringValue(raw?.nodeId, 128);
  const path = raw?.path;
  const snapshot = parseSnapshot(raw?.snapshot);
  if (
    !nodeId ||
    typeof path !== 'string' ||
    path === 'provisioning' ||
    !PATHS.has(path as PlacementSelectionPath) ||
    typeof raw?.accepted !== 'boolean' ||
    !Array.isArray(raw?.rejectionReasons) ||
    !raw.rejectionReasons.every(
      (reason) => typeof reason === 'string' && REJECTIONS.has(reason as PlacementRejectionReason)
    ) ||
    !snapshot
  ) {
    return null;
  }
  return {
    nodeId,
    path: path as PlacementNodeEvaluation['path'],
    accepted: raw.accepted,
    rejectionReasons: raw.rejectionReasons as PlacementRejectionReason[],
    snapshot,
  };
}

function parseAttempt(value: unknown): PlacementProvisioningAttempt | null {
  const raw = record(value);
  const size = vmSize(raw?.vmSize);
  const location = stringValue(raw?.vmLocation, 64);
  const outcome = raw?.outcome;
  const failureReason = raw?.failureReason;
  if (
    !size ||
    !location ||
    typeof outcome !== 'string' ||
    !PROVISIONING_OUTCOMES.has(outcome as PlacementProvisioningAttempt['outcome']) ||
    (failureReason !== undefined &&
      (typeof failureReason !== 'string' ||
        !PROVISIONING_FAILURES.has(
          failureReason as NonNullable<PlacementProvisioningAttempt['failureReason']>
        )))
  ) {
    return null;
  }
  return {
    vmSize: size,
    vmLocation: location,
    outcome: outcome as PlacementProvisioningAttempt['outcome'],
    ...(failureReason
      ? { failureReason: failureReason as PlacementProvisioningAttempt['failureReason'] }
      : {}),
  };
}

function parseV2(value: unknown): PlacementExplanation | null {
  const raw = record(value);
  const path = raw?.selectionPath;
  const selectedNodeId = raw?.selectedNodeId;
  const summary = stringValue(raw?.summary, 300);
  const decidedAt = stringValue(raw?.decidedAt, 64);
  const updatedAt = stringValue(raw?.updatedAt, 64);
  const request = parseRequest(raw?.request);
  if (
    raw?.schemaVersion !== 2 ||
    !['reused', 'provisioned', 'failed'].includes(String(raw?.outcome)) ||
    typeof path !== 'string' ||
    !PATHS.has(path as PlacementSelectionPath) ||
    (selectedNodeId !== null && !stringValue(selectedNodeId, 128)) ||
    !summary ||
    !request ||
    !Array.isArray(raw?.evaluatedNodes) ||
    !Array.isArray(raw?.provisioningAttempts) ||
    !decidedAt ||
    !updatedAt
  ) {
    return null;
  }
  const evaluatedNodes = raw.evaluatedNodes.map(parseEvaluation);
  const provisioningAttempts = raw.provisioningAttempts.map(parseAttempt);
  if (evaluatedNodes.some((item) => !item) || provisioningAttempts.some((item) => !item)) {
    return null;
  }
  return {
    schemaVersion: 2,
    outcome: raw.outcome as PlacementExplanation['outcome'],
    selectionPath: path as PlacementSelectionPath,
    selectedNodeId: selectedNodeId as string | null,
    summary,
    request,
    evaluatedNodes: evaluatedNodes as PlacementNodeEvaluation[],
    provisioningAttempts: provisioningAttempts as PlacementProvisioningAttempt[],
    decidedAt,
    updatedAt,
  };
}

function parseLegacy(value: unknown): LegacyPlacementExplanation | null {
  const raw = record(value);
  const selectedVmSize = vmSize(raw?.selectedVmSize);
  const vmSizeSource = raw?.vmSizeSource;
  const reason = stringValue(raw?.reason, 500);
  const decidedAt = stringValue(raw?.decidedAt, 64);
  const reservation = record(raw?.reservation);
  if (
    !selectedVmSize ||
    typeof vmSizeSource !== 'string' ||
    !VM_SIZE_SOURCES.has(vmSizeSource as ResourceRequirementsSource | 'explicit') ||
    !reason ||
    !decidedAt ||
    !reservation ||
    finiteNumber(reservation.cpuMillis) === null ||
    finiteNumber(reservation.memoryMb) === null ||
    finiteNumber(reservation.diskMb) === null ||
    typeof reservation.exclusiveNode !== 'boolean' ||
    finiteNumber(reservation.maxCoTenants, 1) === null ||
    typeof reservation.source !== 'string' ||
    !RESOURCE_SOURCES.has(reservation.source as ResourceRequirementsSource) ||
    !stringValue(reservation.sourceId, 128) ||
    finiteNumber(reservation.version, 1) === null
  ) {
    return null;
  }
  return {
    selectedVmSize,
    vmSizeSource: vmSizeSource as LegacyPlacementExplanation['vmSizeSource'],
    reservation: {
      cpuMillis: reservation.cpuMillis as number,
      memoryMb: reservation.memoryMb as number,
      diskMb: reservation.diskMb as number,
      exclusiveNode: reservation.exclusiveNode,
      maxCoTenants: reservation.maxCoTenants as number,
      source: reservation.source as ResourceRequirementsSource,
      sourceId: reservation.sourceId as string,
      version: reservation.version as number,
    },
    reason,
    decidedAt,
  };
}

export function parsePlacementExplanation(
  value: unknown
): PlacementExplanation | LegacyPlacementExplanation | null {
  return parseV2(value) ?? parseLegacy(value);
}

export function parsePlacementExplanationJson(
  raw: string | null | undefined
): PlacementExplanation | LegacyPlacementExplanation | null {
  if (!raw) return null;
  try {
    return parsePlacementExplanation(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function isPlacementExplanationV2(
  value: PlacementExplanation | LegacyPlacementExplanation
): value is PlacementExplanation {
  return 'schemaVersion' in value && value.schemaVersion === 2;
}
