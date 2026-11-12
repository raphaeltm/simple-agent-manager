/**
 * Workspace admission policy resolution: the tunables both advisory node selection and the atomic
 * placement SQL evaluate against. Split out of `workspace-resource-capacity.ts` (rule 18), which
 * re-exports everything here.
 */
import {
  DEFAULT_NODE_CPU_THRESHOLD_PERCENT,
  DEFAULT_NODE_HOST_MEMORY_RESERVE_MB,
  DEFAULT_NODE_MEMORY_THRESHOLD_PERCENT,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';

export const DEFAULT_WORKSPACE_ADMISSION_CPU_SHARE_BUDGET_PERCENT = 100;
/**
 * Memory held back for the host (OS, Docker, VM agent). One value drives provisioning
 * (offering memory minus this must cover the request), admission (`measuredHostOverheadMb`)
 * and the cloud-init workload-slice `MemoryMax`. Provisioning cannot measure a node that does
 * not exist yet, so it is only consistent with admission while this is at or above real host
 * overhead. Measured 2026-11-08 on idle production nodes: 4 GB 500-770 MB, 8 GB 565-729 MB
 * (typical), 16 GB 655-1278 MB; a fresh staging cx23 read 459 MB. The previous 512 MB was below
 * nearly all of them, so a node provisioned for an exact-fit request could never admit it.
 */
export const DEFAULT_WORKSPACE_ADMISSION_HOST_MEMORY_RESERVE_MB = DEFAULT_NODE_HOST_MEMORY_RESERVE_MB;
export const DEFAULT_WORKSPACE_ADMISSION_DISK_PRESSURE_THRESHOLD_PERCENT = 80;
export const DEFAULT_WORKSPACE_ADMISSION_METRICS_TTL_MS = 180_000;
export const DEFAULT_WORKSPACE_ADMISSION_CPU_SCORE_WEIGHT_PERCENT = 40;
export const DEFAULT_WORKSPACE_ADMISSION_MEMORY_SCORE_WEIGHT_PERCENT = 60;

export interface WorkspaceAdmissionPolicy {
  cpuShareBudgetPercent: number;
  hostMemoryReserveMb: number;
  diskPressureThresholdPercent: number;
  metricsTtlMs: number;
  cpuThresholdPercent: number;
  memoryThresholdPercent: number;
  cpuScoreWeightPercent: number;
  memoryScoreWeightPercent: number;
}

/**
 * The policy of a NEW placement. The lifetime cutoff must have been resolved
 * (`resolvePlacementAdmissionPolicy`), so a placement path cannot forget it; null disables it.
 */
export type PlacementAdmissionPolicy = WorkspaceAdmissionPolicy & {
  lifetimeAdmissionCutoffAgeMs: number | null;
};

export function resolveWorkspaceAdmissionPolicy(
  env: Pick<
    Env,
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
      parseEnvInt(env.TASK_RUN_NODE_CPU_THRESHOLD_PERCENT, DEFAULT_NODE_CPU_THRESHOLD_PERCENT),
      1,
      1_000
    ),
    memoryThresholdPercent: boundedInt(
      scaling?.nodeMemoryThresholdPercent,
      parseEnvInt(
        env.TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT,
        DEFAULT_NODE_MEMORY_THRESHOLD_PERCENT
      ),
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
