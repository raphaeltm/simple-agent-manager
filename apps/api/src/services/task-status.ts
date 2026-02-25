import type { TaskStatus } from '@simple-agent-manager/shared';

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

export function isExecutableTaskStatus(status: TaskStatus): boolean {
  return TASK_EXECUTION_STATUSES.includes(status);
}
