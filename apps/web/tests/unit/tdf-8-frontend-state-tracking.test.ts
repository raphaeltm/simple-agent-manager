import {
  EXECUTION_STEP_LABELS,
  EXECUTION_STEP_ORDER,
  isTaskExecutionStep,
  TASK_EXECUTION_STEPS,
} from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

describe('Execution step labels (shared types)', () => {
  it('has a label for every execution step', () => {
    for (const step of TASK_EXECUTION_STEPS) {
      expect(EXECUTION_STEP_LABELS[step]).toBeDefined();
      expect(typeof EXECUTION_STEP_LABELS[step]).toBe('string');
      expect(EXECUTION_STEP_LABELS[step].length).toBeGreaterThan(0);
    }
  });

  it('has an order index for every execution step', () => {
    for (const step of TASK_EXECUTION_STEPS) {
      expect(typeof EXECUTION_STEP_ORDER[step]).toBe('number');
    }
  });

  it('order indices are sequential starting from 0', () => {
    const values = TASK_EXECUTION_STEPS.map((s) => EXECUTION_STEP_ORDER[s]);
    expect(values).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('isTaskExecutionStep validates known steps', () => {
    expect(isTaskExecutionStep('node_selection')).toBe(true);
    expect(isTaskExecutionStep('running')).toBe(true);
    expect(isTaskExecutionStep('awaiting_followup')).toBe(true);
  });

  it('isTaskExecutionStep rejects invalid values', () => {
    expect(isTaskExecutionStep('invalid')).toBe(false);
    expect(isTaskExecutionStep(null)).toBe(false);
    expect(isTaskExecutionStep(42)).toBe(false);
    expect(isTaskExecutionStep(undefined)).toBe(false);
  });

  it('labels are user-friendly (end with ...)', () => {
    for (const step of TASK_EXECUTION_STEPS) {
      expect(EXECUTION_STEP_LABELS[step]).toMatch(/\.\.\.$/);
    }
  });
});
