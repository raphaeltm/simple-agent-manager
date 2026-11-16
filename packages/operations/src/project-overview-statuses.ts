/**
 * Task statuses whose chat can be running: placed but not started, and started. An allowlist
 * (`.claude/rules/79`): a status added later is not running until someone decides it is.
 * `sleeping` is deliberately absent: a sleeping chat is not running. Its own module so the
 * Overview read and the brief read can share it without importing each other.
 */
export const OVERVIEW_STARTING_TASK_STATUSES = ['queued', 'delegated'] as const;
export const OVERVIEW_RUNNING_TASK_STATUSES = [
  ...OVERVIEW_STARTING_TASK_STATUSES,
  'in_progress',
] as const;
