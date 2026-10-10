/**
 * The shared lifecycle sets every status check reads. Each task status must belong to
 * exactly one class, so a status added later fails here until someone decides whether it
 * is running, sleeping or finished (`packages/shared/.claude/rules/79`).
 */
import { TASK_STATUSES, type TaskStatus } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import { ACTIVE_STATUSES, AGENT_TARGET_STATUSES } from '../../../src/routes/mcp/_helpers';
import {
  getAllowedTaskTransitions,
  LIVE_TASK_STATUSES,
  SLEEPING_TASK_STATUSES,
  TERMINAL_STATUS_VALUES,
  WAKEABLE_TASK_STATUSES,
} from '../../../src/services/task-status';

type LifecycleClass = 'not_started' | 'live' | 'sleeping' | 'terminal';

const CLASS_OF: Record<TaskStatus, LifecycleClass> = {
  draft: 'not_started',
  ready: 'not_started',
  queued: 'live',
  delegated: 'live',
  in_progress: 'live',
  sleeping: 'sleeping',
  completed: 'terminal',
  failed: 'terminal',
  cancelled: 'terminal',
};

function classesOf(status: string): LifecycleClass[] {
  return [
    LIVE_TASK_STATUSES.includes(status) ? 'live' : null,
    SLEEPING_TASK_STATUSES.includes(status) ? 'sleeping' : null,
    (TERMINAL_STATUS_VALUES as readonly string[]).includes(status) ? 'terminal' : null,
  ].filter((value): value is LifecycleClass => value !== null);
}

describe('task lifecycle status sets', () => {
  it.each(TASK_STATUSES)('places %s in exactly its lifecycle class', (status) => {
    const expected = CLASS_OF[status as TaskStatus];
    expect(expected, `classify the new task status "${status}" in CLASS_OF`).toBeDefined();
    expect(classesOf(status)).toEqual(expected === 'not_started' ? [] : [expected]);
  });

  it('keeps the legacy awaiting_followup rows live', () => {
    expect(classesOf('awaiting_followup')).toEqual(['live']);
  });

  it('makes every live or sleeping task wakeable and nothing else', () => {
    expect([...WAKEABLE_TASK_STATUSES].sort()).toEqual(
      [...LIVE_TASK_STATUSES, ...SLEEPING_TASK_STATUSES].sort()
    );
    expect(new Set(WAKEABLE_TASK_STATUSES).size).toBe(WAKEABLE_TASK_STATUSES.length);
  });

  it('only lets a task sleep after it started', () => {
    const canSleepFrom = TASK_STATUSES.filter((status) =>
      getAllowedTaskTransitions(status).includes('sleeping')
    );
    expect(canSleepFrom.sort()).toEqual(['delegated', 'in_progress']);
  });

  it('keeps MCP callers and dispatch slots live-only while targets may sleep', () => {
    expect([...ACTIVE_STATUSES].sort()).toEqual(
      ['awaiting_followup', 'delegated', 'in_progress', 'queued'].sort()
    );
    expect([...AGENT_TARGET_STATUSES].sort()).toEqual([...WAKEABLE_TASK_STATUSES].sort());
    expect(ACTIVE_STATUSES).not.toContain('sleeping');
    expect(AGENT_TARGET_STATUSES).toContain('sleeping');
  });
});
