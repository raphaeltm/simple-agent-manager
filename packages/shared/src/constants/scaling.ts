import { DEFAULT_NODE_WARM_TIMEOUT_MS } from './node-pooling';
import { DEFAULT_MAX_WORKSPACES_PER_NODE } from './task-execution';

// =============================================================================
// Per-Project Scaling Parameters (Defaults, Mins, Maxes)
// =============================================================================

/** Default task execution timeout (ms). Override per-project or via TASK_RUN_MAX_EXECUTION_MS env var. */
export const DEFAULT_TASK_EXECUTION_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 hours
export const MIN_TASK_EXECUTION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
export const MAX_TASK_EXECUTION_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Default max concurrent tasks per project. Override per-project or via MCP_DISPATCH_MAX_ACTIVE_PER_PROJECT env var. */
export const DEFAULT_MAX_CONCURRENT_TASKS = 10;
export const MIN_MAX_CONCURRENT_TASKS = 1;
export const MAX_MAX_CONCURRENT_TASKS = 50;

/** Default max dispatch depth. Override per-project or via MCP_DISPATCH_MAX_DEPTH env var. */
export const DEFAULT_MAX_DISPATCH_DEPTH = 3;
export const MIN_MAX_DISPATCH_DEPTH = 1;
export const MAX_MAX_DISPATCH_DEPTH = 10;

/** Default max sub-tasks per task. Override per-project or via MCP_DISPATCH_MAX_PER_TASK env var. */
export const DEFAULT_MAX_SUB_TASKS_PER_TASK = 5;
export const MIN_MAX_SUB_TASKS_PER_TASK = 1;
export const MAX_MAX_SUB_TASKS_PER_TASK = 20;

/** Min/max for warm node timeout. Default uses existing DEFAULT_NODE_WARM_TIMEOUT_MS. */
export const MIN_WARM_NODE_TIMEOUT_MS = 30 * 1000; // 30 seconds — prevents instant-destroy race
export const MAX_WARM_NODE_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 hours

/** Min/max for max workspaces per node. Default uses existing DEFAULT_MAX_WORKSPACES_PER_NODE. */
export const MIN_MAX_WORKSPACES_PER_NODE = 1;
export const MAX_MAX_WORKSPACES_PER_NODE = 10;

/** Default CPU threshold (%). Override per-project or via TASK_RUN_NODE_CPU_THRESHOLD_PERCENT env var. */
export const DEFAULT_NODE_CPU_THRESHOLD_PERCENT = 50;
export const MIN_NODE_CPU_THRESHOLD_PERCENT = 10;
export const MAX_NODE_CPU_THRESHOLD_PERCENT = 95;

/** Default memory threshold (%). Override per-project or via TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT env var. */
export const DEFAULT_NODE_MEMORY_THRESHOLD_PERCENT = 50;
export const MIN_NODE_MEMORY_THRESHOLD_PERCENT = 10;
export const MAX_NODE_MEMORY_THRESHOLD_PERCENT = 95;

/** Scaling parameter metadata for validation and UI display. */
export interface ScalingParamMeta {
  key: string;
  label: string;
  envVar: string;
  defaultValue: number;
  min: number;
  max: number;
  unit: 'ms' | 'count' | 'percent';
}

/** Registry of all per-project scaling parameters. */
export const SCALING_PARAMS: ScalingParamMeta[] = [
  { key: 'taskExecutionTimeoutMs', label: 'Task Execution Timeout', envVar: 'TASK_RUN_MAX_EXECUTION_MS', defaultValue: DEFAULT_TASK_EXECUTION_TIMEOUT_MS, min: MIN_TASK_EXECUTION_TIMEOUT_MS, max: MAX_TASK_EXECUTION_TIMEOUT_MS, unit: 'ms' },
  { key: 'maxConcurrentTasks', label: 'Max Concurrent Tasks', envVar: 'MCP_DISPATCH_MAX_ACTIVE_PER_PROJECT', defaultValue: DEFAULT_MAX_CONCURRENT_TASKS, min: MIN_MAX_CONCURRENT_TASKS, max: MAX_MAX_CONCURRENT_TASKS, unit: 'count' },
  { key: 'maxDispatchDepth', label: 'Max Dispatch Depth', envVar: 'MCP_DISPATCH_MAX_DEPTH', defaultValue: DEFAULT_MAX_DISPATCH_DEPTH, min: MIN_MAX_DISPATCH_DEPTH, max: MAX_MAX_DISPATCH_DEPTH, unit: 'count' },
  { key: 'maxSubTasksPerTask', label: 'Max Sub-Tasks Per Task', envVar: 'MCP_DISPATCH_MAX_PER_TASK', defaultValue: DEFAULT_MAX_SUB_TASKS_PER_TASK, min: MIN_MAX_SUB_TASKS_PER_TASK, max: MAX_MAX_SUB_TASKS_PER_TASK, unit: 'count' },
  { key: 'warmNodeTimeoutMs', label: 'Warm Node Timeout', envVar: 'NODE_WARM_TIMEOUT_MS', defaultValue: DEFAULT_NODE_WARM_TIMEOUT_MS, min: MIN_WARM_NODE_TIMEOUT_MS, max: MAX_WARM_NODE_TIMEOUT_MS, unit: 'ms' },
  { key: 'maxWorkspacesPerNode', label: 'Max Workspaces Per Node', envVar: 'MAX_WORKSPACES_PER_NODE', defaultValue: DEFAULT_MAX_WORKSPACES_PER_NODE, min: MIN_MAX_WORKSPACES_PER_NODE, max: MAX_MAX_WORKSPACES_PER_NODE, unit: 'count' },
  { key: 'nodeCpuThresholdPercent', label: 'Node CPU Threshold', envVar: 'TASK_RUN_NODE_CPU_THRESHOLD_PERCENT', defaultValue: DEFAULT_NODE_CPU_THRESHOLD_PERCENT, min: MIN_NODE_CPU_THRESHOLD_PERCENT, max: MAX_NODE_CPU_THRESHOLD_PERCENT, unit: 'percent' },
  { key: 'nodeMemoryThresholdPercent', label: 'Node Memory Threshold', envVar: 'TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT', defaultValue: DEFAULT_NODE_MEMORY_THRESHOLD_PERCENT, min: MIN_NODE_MEMORY_THRESHOLD_PERCENT, max: MAX_NODE_MEMORY_THRESHOLD_PERCENT, unit: 'percent' },
];

/** Scaling parameter keys as a type. */
export type ScalingParamKey = typeof SCALING_PARAMS[number]['key'];

/**
 * Resolve a project scaling config value with fallback chain:
 * project setting → env var → hardcoded default.
 */
export function resolveProjectScalingConfig(
  projectValue: number | null | undefined,
  envValue: string | undefined,
  defaultValue: number,
): number {
  if (projectValue != null && Number.isFinite(projectValue)) return projectValue;
  if (envValue != null) {
    const parsed = parseInt(envValue, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return defaultValue;
}
