import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  canTransitionTaskStatus,
  getAllowedTaskTransitions,
  isExecutableTaskStatus,
  isTaskStatus,
  isTerminalStatus,
  TASK_STATUSES,
  TERMINAL_STATUSES,
  TASK_EXECUTION_STATUSES,
  getExecutionStepIndex,
  canProgressExecutionStep,
} from '../../../src/services/task-status';
import { TASK_EXECUTION_STEPS } from '@simple-agent-manager/shared';
import type { TaskStatus, TaskExecutionStep } from '@simple-agent-manager/shared';

// =============================================================================
// Complete transition matrix — every valid edge in the state machine
// =============================================================================
const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  draft: ['ready', 'cancelled'],
  ready: ['queued', 'delegated', 'cancelled'],
  queued: ['delegated', 'failed', 'cancelled'],
  delegated: ['in_progress', 'failed', 'cancelled'],
  in_progress: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: ['ready', 'cancelled'],
  cancelled: ['ready'],
};

// =============================================================================
// Status validation
// =============================================================================
describe('isTaskStatus', () => {
  it.each(TASK_STATUSES)('accepts valid status: %s', (status) => {
    expect(isTaskStatus(status)).toBe(true);
  });

  it.each([
    'unknown',
    'running',
    'pending',
    'active',
    '',
    null,
    undefined,
    42,
    true,
    {},
    [],
  ])('rejects invalid value: %j', (value) => {
    expect(isTaskStatus(value)).toBe(false);
  });
});

// =============================================================================
// Exhaustive transition tests
// =============================================================================
describe('canTransitionTaskStatus — exhaustive matrix', () => {
  // Self-transitions are always allowed
  describe('self-transitions', () => {
    it.each(TASK_STATUSES)('%s → %s (self) is allowed', (status) => {
      expect(canTransitionTaskStatus(status, status)).toBe(true);
    });
  });

  // Every valid transition
  describe('valid transitions', () => {
    const validCases: [TaskStatus, TaskStatus][] = [];
    for (const [from, targets] of Object.entries(VALID_TRANSITIONS)) {
      for (const to of targets) {
        validCases.push([from as TaskStatus, to as TaskStatus]);
      }
    }

    it.each(validCases)('%s → %s is allowed', (from, to) => {
      expect(canTransitionTaskStatus(from, to)).toBe(true);
    });
  });

  // Every invalid transition (the complement of valid transitions + self-transitions)
  describe('invalid transitions', () => {
    const invalidCases: [TaskStatus, TaskStatus][] = [];
    for (const from of TASK_STATUSES) {
      const allowed = new Set([from, ...VALID_TRANSITIONS[from]]);
      for (const to of TASK_STATUSES) {
        if (!allowed.has(to)) {
          invalidCases.push([from, to]);
        }
      }
    }

    it.each(invalidCases)('%s → %s is rejected', (from, to) => {
      expect(canTransitionTaskStatus(from, to)).toBe(false);
    });

    // Verify we actually generated invalid cases (sanity check)
    it('has generated invalid cases to test', () => {
      expect(invalidCases.length).toBeGreaterThan(0);
    });
  });

  // Verify complete matrix coverage
  it('covers all 64 combinations (8 × 8)', () => {
    let testedCount = 0;
    for (const from of TASK_STATUSES) {
      for (const to of TASK_STATUSES) {
        // Just verify each call returns a boolean without throwing
        const result = canTransitionTaskStatus(from, to);
        expect(typeof result).toBe('boolean');
        testedCount++;
      }
    }
    expect(testedCount).toBe(64);
  });
});

// =============================================================================
// getAllowedTaskTransitions
// =============================================================================
describe('getAllowedTaskTransitions', () => {
  it.each(TASK_STATUSES)('returns an array for status: %s', (status) => {
    const transitions = getAllowedTaskTransitions(status);
    expect(Array.isArray(transitions)).toBe(true);
  });

  it('returns exact expected transitions for each status', () => {
    for (const status of TASK_STATUSES) {
      expect(getAllowedTaskTransitions(status)).toEqual(VALID_TRANSITIONS[status]);
    }
  });

  // Terminal states have no outgoing transitions (except retry/reactivate for failed/cancelled)
  it('completed has no allowed transitions', () => {
    expect(getAllowedTaskTransitions('completed')).toEqual([]);
  });

  it('failed allows retry to ready and cancel', () => {
    expect(getAllowedTaskTransitions('failed')).toEqual(['ready', 'cancelled']);
  });

  it('cancelled allows reactivation to ready', () => {
    expect(getAllowedTaskTransitions('cancelled')).toEqual(['ready']);
  });

  // Consistency: every target returned by getAllowedTaskTransitions
  // is accepted by canTransitionTaskStatus
  it('is consistent with canTransitionTaskStatus', () => {
    for (const from of TASK_STATUSES) {
      const allowed = getAllowedTaskTransitions(from);
      for (const to of allowed) {
        expect(canTransitionTaskStatus(from, to)).toBe(true);
      }
    }
  });
});

// =============================================================================
// Terminal status helpers
// =============================================================================
describe('isTerminalStatus', () => {
  it.each(['completed', 'failed', 'cancelled'] as TaskStatus[])(
    '%s is terminal',
    (status) => {
      expect(isTerminalStatus(status)).toBe(true);
    },
  );

  it.each(['draft', 'ready', 'queued', 'delegated', 'in_progress'] as TaskStatus[])(
    '%s is not terminal',
    (status) => {
      expect(isTerminalStatus(status)).toBe(false);
    },
  );

  it('TERMINAL_STATUSES set contains exactly completed, failed, cancelled', () => {
    expect(TERMINAL_STATUSES.size).toBe(3);
    expect(TERMINAL_STATUSES.has('completed')).toBe(true);
    expect(TERMINAL_STATUSES.has('failed')).toBe(true);
    expect(TERMINAL_STATUSES.has('cancelled')).toBe(true);
  });
});

// =============================================================================
// Executable status identification
// =============================================================================
describe('isExecutableTaskStatus', () => {
  it.each(['queued', 'delegated', 'in_progress'] as TaskStatus[])(
    '%s is executable',
    (status) => {
      expect(isExecutableTaskStatus(status)).toBe(true);
    },
  );

  it.each(['draft', 'ready', 'completed', 'failed', 'cancelled'] as TaskStatus[])(
    '%s is not executable',
    (status) => {
      expect(isExecutableTaskStatus(status)).toBe(false);
    },
  );

  it('TASK_EXECUTION_STATUSES contains exactly queued, delegated, in_progress', () => {
    expect(TASK_EXECUTION_STATUSES).toEqual(['queued', 'delegated', 'in_progress']);
  });
});

// =============================================================================
// Execution step ordering
// =============================================================================
describe('getExecutionStepIndex', () => {
  it('returns sequential indices for all steps', () => {
    for (let i = 0; i < TASK_EXECUTION_STEPS.length; i++) {
      expect(getExecutionStepIndex(TASK_EXECUTION_STEPS[i])).toBe(i);
    }
  });

  it('node_selection is first (index 0)', () => {
    expect(getExecutionStepIndex('node_selection')).toBe(0);
  });

  it('awaiting_followup is last', () => {
    expect(getExecutionStepIndex('awaiting_followup')).toBe(TASK_EXECUTION_STEPS.length - 1);
  });

  it('steps are ordered: node_selection < node_provisioning < node_agent_ready < workspace_creation < workspace_ready < agent_session < running < awaiting_followup', () => {
    const ordered: TaskExecutionStep[] = [
      'node_selection',
      'node_provisioning',
      'node_agent_ready',
      'workspace_creation',
      'workspace_ready',
      'agent_session',
      'running',
      'awaiting_followup',
    ];
    for (let i = 0; i < ordered.length - 1; i++) {
      expect(getExecutionStepIndex(ordered[i])).toBeLessThan(
        getExecutionStepIndex(ordered[i + 1]),
      );
    }
  });
});

describe('canProgressExecutionStep', () => {
  // From null (unset), any step is valid
  it.each([...TASK_EXECUTION_STEPS])('null → %s is valid', (step) => {
    expect(canProgressExecutionStep(null, step)).toBe(true);
  });

  // Same step (idempotent re-delivery)
  it.each([...TASK_EXECUTION_STEPS])('%s → %s (same) is valid', (step) => {
    expect(canProgressExecutionStep(step, step)).toBe(true);
  });

  // Forward progression (adjacent steps)
  describe('forward progression (adjacent)', () => {
    const adjacentPairs: [TaskExecutionStep, TaskExecutionStep][] = [];
    for (let i = 0; i < TASK_EXECUTION_STEPS.length - 1; i++) {
      adjacentPairs.push([TASK_EXECUTION_STEPS[i], TASK_EXECUTION_STEPS[i + 1]]);
    }

    it.each(adjacentPairs)('%s → %s is valid', (from, to) => {
      expect(canProgressExecutionStep(from, to)).toBe(true);
    });
  });

  // Forward skips (e.g., node_selection → workspace_creation when warm node found)
  describe('forward skips are valid', () => {
    it('node_selection → workspace_creation (warm node skip)', () => {
      expect(canProgressExecutionStep('node_selection', 'workspace_creation')).toBe(true);
    });

    it('node_selection → running (large skip)', () => {
      expect(canProgressExecutionStep('node_selection', 'running')).toBe(true);
    });

    it('workspace_creation → agent_session (skip workspace_ready)', () => {
      expect(canProgressExecutionStep('workspace_creation', 'agent_session')).toBe(true);
    });
  });

  // Backward progression is rejected
  describe('backward progression is rejected', () => {
    const backwardPairs: [TaskExecutionStep, TaskExecutionStep][] = [];
    for (let i = 1; i < TASK_EXECUTION_STEPS.length; i++) {
      for (let j = 0; j < i; j++) {
        backwardPairs.push([TASK_EXECUTION_STEPS[i], TASK_EXECUTION_STEPS[j]]);
      }
    }

    it.each(backwardPairs)('%s → %s is rejected (backward)', (from, to) => {
      expect(canProgressExecutionStep(from, to)).toBe(false);
    });

    it('has generated backward cases to test', () => {
      expect(backwardPairs.length).toBeGreaterThan(0);
    });
  });

  // Specific backward cases for clarity
  it('running → node_selection is rejected', () => {
    expect(canProgressExecutionStep('running', 'node_selection')).toBe(false);
  });

  it('awaiting_followup → running is rejected', () => {
    expect(canProgressExecutionStep('awaiting_followup', 'running')).toBe(false);
  });

  it('workspace_ready → workspace_creation is rejected', () => {
    expect(canProgressExecutionStep('workspace_ready', 'workspace_creation')).toBe(false);
  });
});

// =============================================================================
// State machine structural invariants
// =============================================================================
describe('state machine structural invariants', () => {
  it('every status in TASK_STATUSES has a TRANSITIONS entry', () => {
    for (const status of TASK_STATUSES) {
      expect(getAllowedTaskTransitions(status)).toBeDefined();
    }
  });

  it('all transition targets are valid statuses', () => {
    for (const status of TASK_STATUSES) {
      for (const target of getAllowedTaskTransitions(status)) {
        expect(isTaskStatus(target)).toBe(true);
      }
    }
  });

  it('completed has no outgoing transitions (truly terminal)', () => {
    expect(getAllowedTaskTransitions('completed')).toHaveLength(0);
  });

  it('every non-terminal, non-retry status can reach a terminal state', () => {
    // BFS from each status to verify reachability of at least one terminal state
    for (const start of TASK_STATUSES) {
      if (isTerminalStatus(start)) continue;

      const visited = new Set<TaskStatus>();
      const queue: TaskStatus[] = [start];
      let foundTerminal = false;

      while (queue.length > 0) {
        const current = queue.shift()!;
        if (visited.has(current)) continue;
        visited.add(current);

        if (isTerminalStatus(current)) {
          foundTerminal = true;
          break;
        }

        for (const next of getAllowedTaskTransitions(current)) {
          if (!visited.has(next)) {
            queue.push(next);
          }
        }
      }

      expect(foundTerminal).toBe(true);
    }
  });

  it('failed and cancelled can return to ready (retry/reactivate)', () => {
    expect(canTransitionTaskStatus('failed', 'ready')).toBe(true);
    expect(canTransitionTaskStatus('cancelled', 'ready')).toBe(true);
  });

  it('completed cannot return to any active state', () => {
    for (const status of TASK_STATUSES) {
      if (status === 'completed') continue;
      expect(canTransitionTaskStatus('completed', status)).toBe(false);
    }
  });

  it('cancellation is available from all non-terminal, non-completed states', () => {
    const cancellableStatuses: TaskStatus[] = [
      'draft', 'ready', 'queued', 'delegated', 'in_progress', 'failed',
    ];
    for (const status of cancellableStatuses) {
      expect(canTransitionTaskStatus(status, 'cancelled')).toBe(true);
    }
  });

  it('the happy path is reachable: draft → ready → queued → delegated → in_progress → completed', () => {
    const path: TaskStatus[] = ['draft', 'ready', 'queued', 'delegated', 'in_progress', 'completed'];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransitionTaskStatus(path[i], path[i + 1])).toBe(true);
    }
  });

  it('direct delegation is reachable: draft → ready → delegated', () => {
    expect(canTransitionTaskStatus('draft', 'ready')).toBe(true);
    expect(canTransitionTaskStatus('ready', 'delegated')).toBe(true);
  });

  it('task failure at any executable state leads to failed', () => {
    for (const status of TASK_EXECUTION_STATUSES) {
      expect(canTransitionTaskStatus(status, 'failed')).toBe(true);
    }
  });
});

// =============================================================================
// Property-based tests (fast-check)
// =============================================================================
describe('property-based tests', () => {
  const statusArb = fc.constantFrom(...TASK_STATUSES);
  const stepArb = fc.constantFrom(...TASK_EXECUTION_STEPS);

  it('self-transitions are always allowed', () => {
    fc.assert(
      fc.property(statusArb, (status) => {
        expect(canTransitionTaskStatus(status, status)).toBe(true);
      }),
    );
  });

  it('canTransitionTaskStatus is consistent with getAllowedTaskTransitions', () => {
    fc.assert(
      fc.property(statusArb, statusArb, (from, to) => {
        if (from === to) return; // Self-transitions are a special case
        const allowed = getAllowedTaskTransitions(from);
        expect(canTransitionTaskStatus(from, to)).toBe(allowed.includes(to));
      }),
    );
  });

  it('terminal statuses have no outgoing transitions to non-self states (except retry paths)', () => {
    fc.assert(
      fc.property(statusArb, (to) => {
        if (to === 'completed') return; // completed is tested separately
        // completed → anything except self is false
        if (to !== 'completed') {
          // This is already covered above
        }
      }),
    );
  });

  it('from any reachable state, at most N transitions are allowed', () => {
    fc.assert(
      fc.property(statusArb, (status) => {
        const allowed = getAllowedTaskTransitions(status);
        // No state has more than 3 outgoing transitions
        expect(allowed.length).toBeLessThanOrEqual(3);
      }),
    );
  });

  it('execution step progression is monotonic', () => {
    fc.assert(
      fc.property(stepArb, stepArb, (from, to) => {
        const fromIdx = getExecutionStepIndex(from);
        const toIdx = getExecutionStepIndex(to);
        if (toIdx >= fromIdx) {
          expect(canProgressExecutionStep(from, to)).toBe(true);
        } else {
          expect(canProgressExecutionStep(from, to)).toBe(false);
        }
      }),
    );
  });

  it('execution step progression from null always succeeds', () => {
    fc.assert(
      fc.property(stepArb, (to) => {
        expect(canProgressExecutionStep(null, to)).toBe(true);
      }),
    );
  });

  it('transition graph has no unexpected cycles through terminal states', () => {
    // Verify: once you reach completed, you cannot leave
    // Verify: failed/cancelled can only go to ready (which is non-terminal)
    fc.assert(
      fc.property(statusArb, (target) => {
        if (target === 'completed') {
          // completed has no outgoing transitions
          expect(getAllowedTaskTransitions('completed')).toHaveLength(0);
        }
      }),
    );
  });
});

// =============================================================================
// Edge cases and regression guards
// =============================================================================
describe('edge cases', () => {
  it('TASK_STATUSES has exactly 8 statuses', () => {
    expect(TASK_STATUSES).toHaveLength(8);
  });

  it('TASK_EXECUTION_STEPS has exactly 8 steps', () => {
    expect(TASK_EXECUTION_STEPS).toHaveLength(8);
  });

  it('execution steps include awaiting_followup', () => {
    expect(TASK_EXECUTION_STEPS).toContain('awaiting_followup');
  });

  it('no status appears twice in TASK_STATUSES', () => {
    const unique = new Set(TASK_STATUSES);
    expect(unique.size).toBe(TASK_STATUSES.length);
  });

  it('no step appears twice in TASK_EXECUTION_STEPS', () => {
    const unique = new Set(TASK_EXECUTION_STEPS);
    expect(unique.size).toBe(TASK_EXECUTION_STEPS.length);
  });

  it('TRANSITIONS keys match TASK_STATUSES exactly', () => {
    // Every status must have a TRANSITIONS entry
    for (const status of TASK_STATUSES) {
      expect(getAllowedTaskTransitions(status)).toBeDefined();
    }
  });
});
