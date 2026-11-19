import type { ResolvedResourceReservation } from '@simple-agent-manager/shared';

import type { WorkspaceAdmissionPolicy } from './workspace-admission-policy';
import {
  type ActiveWorkspaceReservationUsage,
  emptyUsage,
  isResolvedResourceReservation,
  nonNegativeInteger,
  parseTimestampMs,
  positiveInteger,
} from './workspace-reservation-usage';

export const MEASURED_MEMORY_OVERRUN_REASON =
  'measured memory use above the host reserve leaves no room for this reservation';

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

export interface WorkspaceReservationCapacityResult {
  admitted: boolean;
  reasons: string[];
}

export interface WorkspaceResourceNode {
  id: string;
  nodeRole?: string | null;
  nodeClass?: string | null;
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
  const hasProviderInstance =
    typeof node.providerInstanceId === 'string' && node.providerInstanceId.trim().length > 0;
  const isUserOwnedNode = node.nodeClass === 'user-owned';
  const hasObservedSource = node.observedHardwareSource === 'observed';

  if (hasProviderInstance || isUserOwnedNode) {
    if (observedVcpu !== null && observedMemoryMb !== null && observedDiskGb !== null) {
      if (!hasObservedSource) {
        reasons.push('node observed hardware source is not verified');
        return { vcpuCount: null, memoryMb: null, diskGb: null, source: null, reasons };
      }
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

  reasons.push('managed node has no provider runtime identity');
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
    active.activeCount === 0 && vcpu === null,
    active.activeCount > 0 || node.nodeRole === 'deployment'
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
  // The heartbeat already includes observed container usage. Charge only the
  // unobserved remainder of existing reservations, then the full new start.
  // Newly inserted creating rows never receive credit, so final SQL claims
  // cannot repeatedly spend the same heartbeat headroom. Samples are not
  // synchronous or hard runtime limits; cap credit at host usage as well.
  const heartbeat = parseTimestampMs(node.lastHeartbeatAt);
  const observedMemoryCreditMb = (active.observedMemoryCredits ?? []).reduce(
    (total, credit) =>
      heartbeat !== null &&
      credit.heartbeatAt === heartbeat &&
      credit.collectedAt >= heartbeat - policy.metricsTtlMs &&
      credit.collectedAt <= heartbeat
        ? total + credit.memoryMb
        : total,
    0
  );
  const measuredMemoryMb =
    memoryMb !== null && metrics?.memoryPercent != null
      ? (memoryMb * metrics.memoryPercent) / 100
      : null;
  if (
    // Deployments use separate atomic admission and lack workspace observations.
    // Keep this new workspace-only headroom guard aligned with its SQL claim.
    node.nodeRole !== 'deployment' &&
    memoryMb !== null &&
    measuredMemoryMb !== null &&
    measuredHostOverheadMb(measuredMemoryMb, observedMemoryCreditMb, policy) +
      active.memoryMb +
      request.memoryMb >
      memoryMb
  ) {
    reasons.push(MEASURED_MEMORY_OVERRUN_REASON);
  }
  if (diskGb !== null && active.diskMb + request.diskMb > diskGb * 1024) {
    reasons.push('disk reservation budget would be exceeded');
  }

  return {
    admitted: reasons.length === 0,
    reasons,
  };
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

export function cpuBudgetMillis(vcpuCount: number, policy: WorkspaceAdmissionPolicy): number {
  return Math.floor((vcpuCount * 1000 * policy.cpuShareBudgetPercent) / 100);
}

/**
 * The host overhead one memory accounting policy charges, shared by provisioning
 * (`placement-resolver-capacity.ts`), this evaluator and the atomic placement SQL
 * (`workspace-admission-sql.ts`): the configured host reserve, or the measured use
 * no workspace observation explains when that is larger.
 *
 * Condition: the node's real memory demand (host processes plus workloads) leaves
 * room for every declared reservation plus this request. Memory is NON-COMPRESSIBLE,
 * so this is a hard veto, unlike CPU (see `measuredAdmissionDiagnostic`).
 *
 * Signal: the heartbeat's whole-host used memory. It includes the host's own
 * processes, which the reserve already pays for (cloud-init caps the workload slice
 * at total minus the same reserve). Adding measured use ON TOP of the reserve charged
 * host overhead twice, so every exact catalog fit was refused, including a node
 * provisioned for that very request with no workload on it (the 2026-11-05 staging
 * loop). Measured use counts only where it exceeds the reserve: co-tenants running
 * past their reservations and orphaned or leaked usage, which is the overrun the
 * measured guard exists to catch. Provisioning assumes overhead equals the reserve,
 * so the default reserve must stay at or above real host overhead
 * (`DEFAULT_WORKSPACE_ADMISSION_HOST_MEMORY_RESERVE_MB`).
 */
export function measuredHostOverheadMb(
  measuredMemoryMb: number,
  observedMemoryCreditMb: number,
  policy: Pick<WorkspaceAdmissionPolicy, 'hostMemoryReserveMb'>
): number {
  const unattributedMb = measuredMemoryMb - Math.min(measuredMemoryMb, observedMemoryCreditMb);
  return Math.max(policy.hostMemoryReserveMb, unattributedMb);
}

export function usableMemoryMb(memoryMb: number, policy: WorkspaceAdmissionPolicy): number {
  return Math.max(0, memoryMb - policy.hostMemoryReserveMb);
}

/**
 * Live-telemetry admission checks, split by whether the resource is compressible.
 *
 * Memory and disk are NON-COMPRESSIBLE. Their declared reservations remain hard
 * budgets. Live memory percentage stays available for scoring and diagnostics,
 * while disk pressure remains a hard veto because a full filesystem cannot
 * satisfy even a correctly reserved workload.
 *
 * CPU is COMPRESSIBLE: the kernel time-slices it, so oversubscription makes work
 * slower rather than broken. It is also already accounted for — every co-tenant's
 * committed CPU is subtracted from `cpuBudgetMillis` against its declared
 * reservation by the caller, which refuses the request on its own when the budget
 * does not fit. Vetoing a second time on instantaneous CPU therefore double-counts
 * a co-tenant's own reserved burst, and refuses precisely the hosts that are doing
 * the work we want to pack onto. Below saturation the declared reservation is the
 * sole CPU authority; `cpuThresholdPercent` survives only as a saturation ceiling.
 *
 * Do NOT restore a "node is busy" CPU veto here. At the previous 50% default, one
 * busy core on a 2-vCPU host refused every co-tenant, so only idle nodes were ever
 * admissible and production provisioned close to one VM per agent.
 */
function measuredAdmissionDiagnostic(
  metrics: WorkspaceAdmissionMetrics | null,
  policy: WorkspaceAdmissionPolicy,
  allowUnknownCpuPressure: boolean,
  enforceCpuSaturation: boolean
): string | null {
  if (!metrics) return 'occupied node has no resource telemetry';
  if (metrics.unsupportedVersion) return 'node resource telemetry version is unsupported';
  if (metrics.malformed) return 'node resource telemetry is malformed';
  if (!metrics.fresh) return 'node telemetry is stale';
  // Saturation still needs a reading to evaluate, so absent CPU telemetry keeps
  // failing closed exactly as before.
  if (metrics.cpuPercent === null && !allowUnknownCpuPressure) {
    return 'node has no CPU pressure telemetry';
  }
  if (metrics.memoryPercent === null) return 'node has no memory pressure telemetry';
  if (metrics.diskPercent === null) return 'node has no disk pressure telemetry';
  // CPU is compressible. With no workspace reservations, host bootstrap load
  // cannot prove a co-tenant is saturated; the declared budget is the authority.
  // Occupied nodes retain this backstop against under-declared workload bursts.
  // Deployment-role admission has its own SQL policy and retains its CPU ceiling.
  if (
    enforceCpuSaturation &&
    metrics.cpuPercent !== null &&
    metrics.cpuPercent >= policy.cpuThresholdPercent
  ) {
    return 'CPU saturation ceiling reached';
  }
  if (metrics.diskPercent >= policy.diskPressureThresholdPercent) {
    return 'disk pressure threshold reached';
  }
  // A workspace build in progress is NOT a veto. The node builds one workspace at a time, so a
  // new placement queues behind it while its reservation is already charged above. Refusing a
  // busy-but-sufficient node only sent work to a fresh VM (#2065's expiry path); queue length is
  // a ranking preference instead (`startupBacklog`, `compareReusableHosts`).
  return null;
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
