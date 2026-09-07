import { TASK_EXECUTION_STEPS, type TaskExecutionStep, type TaskStatus } from '@simple-agent-manager/shared';

export const TASK_STATUSES: TaskStatus[] = [
  'draft',
  'ready',
  'queued',
  'delegated',
  'in_progress',
  'completed',
  'failed',
  'cancelled',
];

export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(['completed', 'failed', 'cancelled']);

export const TASK_EXECUTION_STATUSES: TaskStatus[] = ['queued', 'delegated', 'in_progress'];

const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  draft: ['ready', 'cancelled'],
  ready: ['queued', 'delegated', 'cancelled'],
  queued: ['delegated', 'failed', 'cancelled'],
  delegated: ['in_progress', 'failed', 'cancelled'],
  in_progress: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: ['ready', 'cancelled'],
  cancelled: ['ready'],
};

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && TASK_STATUSES.includes(value as TaskStatus);
}

export function getAllowedTaskTransitions(from: TaskStatus): TaskStatus[] {
  return TRANSITIONS[from];
}

export function canTransitionTaskStatus(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) {
    return true;
  }
  return TRANSITIONS[from].includes(to);
}

export function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function isExecutableTaskStatus(status: TaskStatus): boolean {
  return TASK_EXECUTION_STATUSES.includes(status);
}

// =============================================================================
// Execution Step Ordering
// =============================================================================

/**
 * Returns the ordinal index of an execution step.
 * Steps are ordered sequentially; some may be skipped (e.g., provisioning
 * is skipped when a warm node is available), but steps can never go backwards.
 */
export function getExecutionStepIndex(step: TaskExecutionStep): number {
  return TASK_EXECUTION_STEPS.indexOf(step);
}

/**
 * Validates that a step progression moves forward (or stays the same for
 * idempotent re-delivery). Steps can be skipped (forward jumps are valid)
 * but never go backwards.
 *
 * @param from - The current execution step (null means no step set yet)
 * @param to - The target execution step
 * @returns true if the progression is valid
 */
export function canProgressExecutionStep(
  from: TaskExecutionStep | null,
  to: TaskExecutionStep,
): boolean {
  if (from === null) {
    return true; // Any step is valid from unset
  }
  const fromIdx = getExecutionStepIndex(from);
  const toIdx = getExecutionStepIndex(to);
  return toIdx >= fromIdx; // Same step (idempotent) or forward progression
}
