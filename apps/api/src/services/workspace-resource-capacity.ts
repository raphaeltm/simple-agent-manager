import type { ResolvedResourceReservation } from '@simple-agent-manager/shared';

import type { Env } from '../env';

export const ACTIVE_WORKSPACE_RESERVATION_STATUS_SQL = "'running', 'creating', 'recovery'";
export const DEFAULT_WORKSPACE_ADMISSION_CPU_SHARE_BUDGET_PERCENT = 100;
export const DEFAULT_WORKSPACE_ADMISSION_HOST_MEMORY_RESERVE_MB = 512;
export const DEFAULT_WORKSPACE_ADMISSION_DISK_PRESSURE_THRESHOLD_PERCENT = 90;
export const DEFAULT_WORKSPACE_ADMISSION_METRICS_TTL_MS = 180_000;
export const DEFAULT_WORKSPACE_ADMISSION_CPU_SCORE_WEIGHT_PERCENT = 40;
export const DEFAULT_WORKSPACE_ADMISSION_MEMORY_SCORE_WEIGHT_PERCENT = 60;
export const RESOURCE_REQUIREMENTS_SOURCE_SQL =
  "'task', 'trigger', 'skill', 'agent-profile', 'project', 'user', 'platform'";
const D1_BIND_LIMIT = 100;

export interface WorkspaceAdmissionPolicy {
  maxWorkspaces: number;
  cpuShareBudgetPercent: number;
  hostMemoryReserveMb: number;
  diskPressureThresholdPercent: number;
  metricsTtlMs: number;
  cpuThresholdPercent: number;
  memoryThresholdPercent: number;
  cpuScoreWeightPercent: number;
  memoryScoreWeightPercent: number;
}

export interface WorkspaceAdmissionMetrics {
  cpuLoadAvg1: number | null;
  cpuPercent: number | null;
  memoryPercent: number | null;
  diskPercent: number | null;
  creatingWorkspaces: number;
  fresh: boolean;
  malformed: boolean;
  unsupportedVersion: boolean;
}

export interface ActiveWorkspaceReservationUsage {
  activeCount: number;
  invalidCount: number;
  exclusiveCount: number;
  minMaxCoTenants: number | null;
  cpuMillis: number;
  memoryMb: number;
  diskMb: number;
}

export interface WorkspaceReservationCapacityResult {
  admitted: boolean;
  reasons: string[];
}

export interface WorkspaceResourceNode {
  id: string;
  providerInstanceId?: string | null;
  providerInstanceVcpuCount?: number | null;
  providerInstanceMemoryMb?: number | null;
  providerInstanceDiskGb?: number | null;
  observedProviderInstanceVcpuCount?: number | null;
  observedProviderInstanceMemoryMb?: number | null;
  observedProviderInstanceDiskGb?: number | null;
  observedHardwareSource?: string | null;
  lastMetrics?: string | null;
  lastHeartbeatAt?: string | null;
}

export interface TrustedWorkspaceNodeCapacity {
  vcpuCount: number | null;
  memoryMb: number | null;
  diskGb: number | null;
  source: 'observed' | 'planned' | null;
  reasons: string[];
}

export function resolveWorkspaceAdmissionPolicy(
  env: Pick<
    Env,
    | 'MAX_WORKSPACES_PER_NODE'
    | 'TASK_RUN_NODE_CPU_THRESHOLD_PERCENT'
    | 'TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT'
    | 'TASK_RUN_NODE_CPU_SHARE_BUDGET_PERCENT'
    | 'TASK_RUN_NODE_HOST_MEMORY_RESERVE_MB'
    | 'VM_AGENT_MEMORY_RESERVE_MB'
    | 'TASK_RUN_NODE_DISK_PRESSURE_THRESHOLD_PERCENT'
    | 'TASK_RUN_NODE_METRICS_TTL_MS'
    | 'TASK_RUN_NODE_CPU_SCORE_WEIGHT_PERCENT'
    | 'TASK_RUN_NODE_MEMORY_SCORE_WEIGHT_PERCENT'
  >,
  scaling?: {
    maxWorkspacesPerNode?: number | null;
    nodeCpuThresholdPercent?: number | null;
    nodeMemoryThresholdPercent?: number | null;
    nodeCpuShareBudgetPercent?: number | null;
    nodeHostMemoryReserveMb?: number | null;
    nodeDiskPressureThresholdPercent?: number | null;
    nodeMetricsTtlMs?: number | null;
    nodeCpuScoreWeightPercent?: number | null;
    nodeMemoryScoreWeightPercent?: number | null;
  } | null
): WorkspaceAdmissionPolicy {
  const cpuScoreWeightPercent = positiveInt(
    scaling?.nodeCpuScoreWeightPercent,
    parseEnvInt(
      env.TASK_RUN_NODE_CPU_SCORE_WEIGHT_PERCENT,
      DEFAULT_WORKSPACE_ADMISSION_CPU_SCORE_WEIGHT_PERCENT
    )
  );
  const memoryScoreWeightPercent = positiveInt(
    scaling?.nodeMemoryScoreWeightPercent,
    parseEnvInt(
      env.TASK_RUN_NODE_MEMORY_SCORE_WEIGHT_PERCENT,
      DEFAULT_WORKSPACE_ADMISSION_MEMORY_SCORE_WEIGHT_PERCENT
    )
  );
  const totalWeight = cpuScoreWeightPercent + memoryScoreWeightPercent;

  return {
    maxWorkspaces: positiveInt(
      scaling?.maxWorkspacesPerNode,
      parseEnvInt(env.MAX_WORKSPACES_PER_NODE, 3)
    ),
    cpuShareBudgetPercent: boundedInt(
      scaling?.nodeCpuShareBudgetPercent,
      parseEnvInt(
        env.TASK_RUN_NODE_CPU_SHARE_BUDGET_PERCENT,
        DEFAULT_WORKSPACE_ADMISSION_CPU_SHARE_BUDGET_PERCENT
      ),
      1,
      1_000
    ),
    hostMemoryReserveMb: resolveEffectiveNodeHostMemoryReserveMb(env, scaling),
    diskPressureThresholdPercent: boundedInt(
      scaling?.nodeDiskPressureThresholdPercent,
      parseEnvInt(
        env.TASK_RUN_NODE_DISK_PRESSURE_THRESHOLD_PERCENT,
        DEFAULT_WORKSPACE_ADMISSION_DISK_PRESSURE_THRESHOLD_PERCENT
      ),
      1,
      100
    ),
    metricsTtlMs: positiveInt(
      scaling?.nodeMetricsTtlMs,
      parseEnvInt(env.TASK_RUN_NODE_METRICS_TTL_MS, DEFAULT_WORKSPACE_ADMISSION_METRICS_TTL_MS)
    ),
    cpuThresholdPercent: boundedInt(
      scaling?.nodeCpuThresholdPercent,
      parseEnvInt(env.TASK_RUN_NODE_CPU_THRESHOLD_PERCENT, 50),
      1,
      1_000
    ),
    memoryThresholdPercent: boundedInt(
      scaling?.nodeMemoryThresholdPercent,
      parseEnvInt(env.TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT, 50),
      1,
      100
    ),
    cpuScoreWeightPercent:
      totalWeight > 0
        ? cpuScoreWeightPercent
        : DEFAULT_WORKSPACE_ADMISSION_CPU_SCORE_WEIGHT_PERCENT,
    memoryScoreWeightPercent:
      totalWeight > 0
        ? memoryScoreWeightPercent
        : DEFAULT_WORKSPACE_ADMISSION_MEMORY_SCORE_WEIGHT_PERCENT,
  };
}

export function resolveEffectiveNodeHostMemoryReserveMb(
  env: Pick<Env, 'TASK_RUN_NODE_HOST_MEMORY_RESERVE_MB' | 'VM_AGENT_MEMORY_RESERVE_MB'>,
  scaling?: { nodeHostMemoryReserveMb?: number | null } | null
): number {
  return nonNegativeInt(
    scaling?.nodeHostMemoryReserveMb,
    parseEnvInt(
      env.TASK_RUN_NODE_HOST_MEMORY_RESERVE_MB ?? env.VM_AGENT_MEMORY_RESERVE_MB,
      DEFAULT_WORKSPACE_ADMISSION_HOST_MEMORY_RESERVE_MB
    )
  );
}

export function isResolvedResourceReservation(
  value: unknown
): value is ResolvedResourceReservation {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    (record.version === 1 || record.version === 2) &&
    positiveInteger(record.cpuMillis) !== null &&
    positiveInteger(record.memoryMb) !== null &&
    nonNegativeInteger(record.diskMb) !== null &&
    positiveInteger(record.maxCoTenants) !== null &&
    typeof record.exclusiveNode === 'boolean' &&
    typeof record.source === 'string' &&
    ['task', 'trigger', 'skill', 'agent-profile', 'project', 'user', 'platform'].includes(
      record.source
    )
  );
}

export function parseWorkspaceAdmissionMetrics(
  node: WorkspaceResourceNode,
  policy: WorkspaceAdmissionPolicy,
  nowMs = Date.now()
): WorkspaceAdmissionMetrics | null {
  if (!node.lastMetrics) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(node.lastMetrics);
  } catch {
    return {
      cpuLoadAvg1: null,
      cpuPercent: null,
      memoryPercent: null,
      diskPercent: null,
      creatingWorkspaces: 0,
      fresh: false,
      malformed: true,
      unsupportedVersion: false,
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      cpuLoadAvg1: null,
      cpuPercent: null,
      memoryPercent: null,
      diskPercent: null,
      creatingWorkspaces: 0,
      fresh: false,
      malformed: true,
      unsupportedVersion: false,
    };
  }

  const record = parsed as Record<string, unknown>;
  const version = record.version;
  const unsupportedVersion =
    typeof version === 'number' && Number.isInteger(version) && version > 1;
  const malformed =
    unsupportedVersion ||
    malformedOptionalNumber(record, 'cpuLoadAvg1', nonNegativeNumber) ||
    malformedOptionalNumber(record, 'memoryPercent', percentNumber) ||
    malformedOptionalNumber(record, 'diskPercent', percentNumber) ||
    malformedOptionalNumber(record, 'creatingWorkspaces', nonNegativeInteger) ||
    (version !== undefined && !unsupportedVersion && version !== 1);
  const cpuLoadAvg1 = nonNegativeNumber(record.cpuLoadAvg1);
  const memoryPercent = percentNumber(record.memoryPercent);
  const diskPercent = percentNumber(record.diskPercent);
  const creatingWorkspaces = nonNegativeInteger(record.creatingWorkspaces) ?? 0;
  const heartbeatMs = parseTimestampMs(node.lastHeartbeatAt);
  const fresh =
    heartbeatMs !== null &&
    nowMs >= heartbeatMs &&
    nowMs - heartbeatMs <= Math.max(1, policy.metricsTtlMs);

  return {
    cpuLoadAvg1,
    cpuPercent: normalizeLoadAverageToCpuPercent(
      cpuLoadAvg1,
      resolveTrustedWorkspaceNodeCapacity(node).vcpuCount
    ),
    memoryPercent,
    diskPercent,
    creatingWorkspaces,
    fresh,
    malformed,
    unsupportedVersion,
  };
}

export function normalizeLoadAverageToCpuPercent(
  loadAvg1: number | null,
  vcpuCount: number | null | undefined
): number | null {
  const vcpu = positiveInteger(vcpuCount);
  if (loadAvg1 === null || vcpu === null) return null;
  return (loadAvg1 / vcpu) * 100;
}

export function resolveTrustedWorkspaceNodeCapacity(
  node: WorkspaceResourceNode
): TrustedWorkspaceNodeCapacity {
  const reasons: string[] = [];
  const observedVcpu = positiveInteger(node.observedProviderInstanceVcpuCount);
  const observedMemoryMb = positiveInteger(node.observedProviderInstanceMemoryMb);
  const observedDiskGb = positiveInteger(node.observedProviderInstanceDiskGb);
  const plannedVcpu = positiveInteger(node.providerInstanceVcpuCount);
  const plannedMemoryMb = positiveInteger(node.providerInstanceMemoryMb);
  const plannedDiskGb = positiveInteger(node.providerInstanceDiskGb);
  const hasProviderInstance =
    typeof node.providerInstanceId === 'string' && node.providerInstanceId.trim().length > 0;

  if (hasProviderInstance) {
    if (observedVcpu !== null && observedMemoryMb !== null && observedDiskGb !== null) {
      return {
        vcpuCount: observedVcpu,
        memoryMb: observedMemoryMb,
        diskGb: observedDiskGb,
        source: 'observed',
        reasons,
      };
    }
    reasons.push('node has no trusted observed hardware capacity');
    return { vcpuCount: null, memoryMb: null, diskGb: null, source: null, reasons };
  }

  if (plannedVcpu !== null && plannedMemoryMb !== null && plannedDiskGb !== null) {
    return {
      vcpuCount: plannedVcpu,
      memoryMb: plannedMemoryMb,
      diskGb: plannedDiskGb,
      source: 'planned',
      reasons,
    };
  }

  reasons.push('node has no planned capacity before provider allocation');
  return { vcpuCount: null, memoryMb: null, diskGb: null, source: null, reasons };
}

export function scoreWorkspaceAdmissionMetrics(
  metrics: WorkspaceAdmissionMetrics | null,
  policy: WorkspaceAdmissionPolicy
): number | null {
  if (!metrics) return null;
  const cpu = metrics.cpuPercent ?? 0;
  const memory = metrics.memoryPercent ?? 0;
  const weight = policy.cpuScoreWeightPercent + policy.memoryScoreWeightPercent;
  if (weight <= 0) return null;
  return (cpu * policy.cpuScoreWeightPercent + memory * policy.memoryScoreWeightPercent) / weight;
}

export async function loadActiveWorkspaceReservationUsage(
  database: D1Database,
  nodeIds: string[]
): Promise<Map<string, ActiveWorkspaceReservationUsage>> {
  const usage = new Map<string, ActiveWorkspaceReservationUsage>();
  const uniqueNodeIds = Array.from(new Set(nodeIds)).filter((id) => id.length > 0);

  for (let i = 0; i < uniqueNodeIds.length; i += D1_BIND_LIMIT) {
    const chunk = uniqueNodeIds.slice(i, i + D1_BIND_LIMIT);
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => '?').join(',');
    const rows = await database
      .prepare(
        `SELECT node_id AS nodeId, resolved_reservation_json AS reservationJson
         FROM workspaces
         WHERE node_id IN (${placeholders})
           AND status IN (${ACTIVE_WORKSPACE_RESERVATION_STATUS_SQL})`
      )
      .bind(...chunk)
      .all<{ nodeId: string; reservationJson: string | null }>();

    for (const row of rows.results ?? []) {
      const existing = usage.get(row.nodeId) ?? emptyUsage();
      existing.activeCount += 1;
      const reservation = parseReservationJson(row.reservationJson);
      if (!reservation) {
        existing.invalidCount += 1;
      } else {
        existing.cpuMillis += reservation.cpuMillis;
        existing.memoryMb += reservation.memoryMb;
        existing.diskMb += reservation.diskMb;
        if (reservation.exclusiveNode) existing.exclusiveCount += 1;
        existing.minMaxCoTenants =
          existing.minMaxCoTenants === null
            ? reservation.maxCoTenants
            : Math.min(existing.minMaxCoTenants, reservation.maxCoTenants);
      }
      usage.set(row.nodeId, existing);
    }
  }

  return usage;
}

export function evaluateWorkspaceReservationCapacity(
  node: WorkspaceResourceNode,
  usage: ActiveWorkspaceReservationUsage | undefined,
  request: ResolvedResourceReservation,
  policy: WorkspaceAdmissionPolicy,
  metrics = parseWorkspaceAdmissionMetrics(node, policy)
): WorkspaceReservationCapacityResult {
  const reasons: string[] = [];
  const active = usage ?? emptyUsage();

  if (!isResolvedResourceReservation(request)) {
    reasons.push('requested reservation is malformed');
  }
  if (policy.maxWorkspaces < 1) {
    reasons.push('max workspaces per node must be positive');
  }
  if (active.activeCount >= policy.maxWorkspaces) {
    reasons.push('workspace count cap reached');
  }
  if (active.activeCount >= request.maxCoTenants) {
    reasons.push('requested co-tenant cap reached');
  }
  if (active.minMaxCoTenants !== null && active.activeCount >= active.minMaxCoTenants) {
    reasons.push('existing reservation co-tenant cap reached');
  }
  if (request.exclusiveNode && active.activeCount > 0) {
    reasons.push('requested reservation requires an exclusive node');
  }
  if (active.exclusiveCount > 0) {
    reasons.push('existing reservation requires an exclusive node');
  }
  if (active.activeCount > 0 && active.invalidCount > 0) {
    reasons.push('active reservation snapshot is missing or malformed');
  }

  const trustedCapacity = resolveTrustedWorkspaceNodeCapacity(node);
  const vcpu = trustedCapacity.vcpuCount;
  const memoryMb = trustedCapacity.memoryMb;
  const diskGb = trustedCapacity.diskGb;
  if (trustedCapacity.source === null) {
    reasons.push(...trustedCapacity.reasons);
  }

  const measuredAdmissionReason = measuredAdmissionDiagnostic(
    metrics,
    policy,
    active.activeCount === 0 && vcpu === null
  );
  if (measuredAdmissionReason) {
    if (active.activeCount > 0 || metrics !== null) {
      reasons.push(measuredAdmissionReason);
    }
  }

  if (vcpu !== null && active.cpuMillis + request.cpuMillis > cpuBudgetMillis(vcpu, policy)) {
    reasons.push('CPU share budget would be exceeded');
  }
  if (memoryMb !== null && active.memoryMb + request.memoryMb > usableMemoryMb(memoryMb, policy)) {
    reasons.push('memory budget would be exceeded after host reserve');
  }
  if (diskGb !== null && active.diskMb + request.diskMb > diskGb * 1024) {
    reasons.push('disk reservation budget would be exceeded');
  }

  return { admitted: reasons.length === 0, reasons };
}

export function hasWorkspaceReservationCapacity(
  node: WorkspaceResourceNode,
  usage: ActiveWorkspaceReservationUsage | undefined,
  request: ResolvedResourceReservation,
  policy: WorkspaceAdmissionPolicy,
  metrics?: WorkspaceAdmissionMetrics | null
): boolean {
  return evaluateWorkspaceReservationCapacity(node, usage, request, policy, metrics).admitted;
}

export function emptyUsage(): ActiveWorkspaceReservationUsage {
  return {
    activeCount: 0,
    invalidCount: 0,
    exclusiveCount: 0,
    minMaxCoTenants: null,
    cpuMillis: 0,
    memoryMb: 0,
    diskMb: 0,
  };
}

export function cpuBudgetMillis(vcpuCount: number, policy: WorkspaceAdmissionPolicy): number {
  return Math.floor((vcpuCount * 1000 * policy.cpuShareBudgetPercent) / 100);
}

export function usableMemoryMb(memoryMb: number, policy: WorkspaceAdmissionPolicy): number {
  return Math.max(0, memoryMb - policy.hostMemoryReserveMb);
}

function measuredAdmissionDiagnostic(
  metrics: WorkspaceAdmissionMetrics | null,
  policy: WorkspaceAdmissionPolicy,
  allowUnknownCpuPressure: boolean
): string | null {
  if (!metrics) return 'occupied node has no resource telemetry';
  if (metrics.unsupportedVersion) return 'node resource telemetry version is unsupported';
  if (metrics.malformed) return 'node resource telemetry is malformed';
  if (!metrics.fresh) return 'node telemetry is stale';
  if (metrics.cpuPercent === null && !allowUnknownCpuPressure) {
    return 'node has no CPU pressure telemetry';
  }
  if (metrics.memoryPercent === null) return 'node has no memory pressure telemetry';
  if (metrics.diskPercent === null) return 'node has no disk pressure telemetry';
  if (metrics.creatingWorkspaces > 0) return 'node is already creating a workspace';
  if (metrics.cpuPercent !== null && metrics.cpuPercent >= policy.cpuThresholdPercent) {
    return 'CPU pressure threshold reached';
  }
  if (metrics.memoryPercent >= policy.memoryThresholdPercent) {
    return 'memory pressure threshold reached';
  }
  if (metrics.diskPercent >= policy.diskPressureThresholdPercent) {
    return 'disk pressure threshold reached';
  }
  return null;
}

function parseReservationJson(value: string | null): ResolvedResourceReservation | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return isResolvedResourceReservation(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function parseEnvInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function positiveInt(value: number | null | undefined, fallback: number): number {
  return Number.isInteger(value) && value !== null && value !== undefined && value > 0
    ? value
    : Math.max(1, Math.floor(fallback));
}

function nonNegativeInt(value: number | null | undefined, fallback: number): number {
  return Number.isInteger(value) && value !== null && value !== undefined && value >= 0
    ? value
    : Math.max(0, Math.floor(fallback));
}

function boundedInt(
  value: number | null | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  return Math.min(max, Math.max(min, positiveInt(value, fallback)));
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function percentNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null;
}

function malformedOptionalNumber(
  record: Record<string, unknown>,
  key: string,
  parser: (value: unknown) => number | null
): boolean {
  return Object.hasOwn(record, key) && parser(record[key]) === null;
}
