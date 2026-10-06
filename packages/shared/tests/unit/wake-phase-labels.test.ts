import { describe, expect, it } from 'vitest';

import {
  EXECUTION_STEP_ORDER,
  TASK_EXECUTION_STEPS,
  WAKE_PHASE_LABELS,
  WAKE_PHASE_PENDING_LABEL,
  wakePhaseLabel,
} from '../../src/types/task';

describe('wake phase labels', () => {
  it('covers every execution step', () => {
    // The Record<TaskExecutionStep, string> type enforces this at compile time,
    // but a step added at runtime via a merged type would slip through. This
    // pins it so a new step cannot ship with an undefined wake label.
    for (const step of TASK_EXECUTION_STEPS) {
      expect(WAKE_PHASE_LABELS[step], `missing wake label for "${step}"`).toBeTruthy();
      expect(typeof WAKE_PHASE_LABELS[step]).toBe('string');
    }
    expect(Object.keys(WAKE_PHASE_LABELS).sort()).toEqual([...TASK_EXECUTION_STEPS].sort());
  });

  it('falls back to the pending label when no phase has been reported', () => {
    // A wake is claimed in D1 before the replacement runner writes its first
    // execution step. That window must still render something meaningful.
    expect(wakePhaseLabel(null)).toBe(WAKE_PHASE_PENDING_LABEL);
    expect(wakePhaseLabel(undefined)).toBe(WAKE_PHASE_PENDING_LABEL);
  });

  it('returns the wake-specific label for a known phase', () => {
    expect(wakePhaseLabel('node_provisioning')).toBe('Provisioning a server...');
    expect(wakePhaseLabel('agent_session')).toBe('Starting the agent...');
  });

  it('uses wake-shaped wording, not the task-launch wording', () => {
    // The two label maps deliberately diverge: a session being restored is not a
    // task being launched. If these ever become identical the wake map is
    // redundant and something has drifted.
    expect(WAKE_PHASE_LABELS.workspace_ready).toBe('Restoring your session...');
    expect(WAKE_PHASE_LABELS.attachment_transfer).not.toMatch(/attachment/i);
  });

  it('orders phases monotonically so the UI can reject stale updates', () => {
    // useWakeProgress drops a lower-ordered phase arriving after a higher one.
    // That logic is only sound if the order is strictly increasing.
    const order = TASK_EXECUTION_STEPS.map((s) => EXECUTION_STEP_ORDER[s]);
    for (let i = 1; i < order.length; i++) {
      expect(order[i]).toBeGreaterThan(order[i - 1]);
    }
  });
});
