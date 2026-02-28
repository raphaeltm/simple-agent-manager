import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EXECUTION_STEP_LABELS,
  EXECUTION_STEP_ORDER,
  TASK_EXECUTION_STEPS,
  isTaskExecutionStep,
} from '@simple-agent-manager/shared';

const srcRoot = join(__dirname, '../../src');

function readSource(relativePath: string): string {
  return readFileSync(join(srcRoot, relativePath), 'utf-8');
}

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
    expect(values).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
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

describe('ProvisioningIndicator (ProjectChat)', () => {
  const source = readSource('pages/ProjectChat.tsx');

  it('imports execution step constants from shared', () => {
    expect(source).toContain('EXECUTION_STEP_LABELS');
    expect(source).toContain('EXECUTION_STEP_ORDER');
    expect(source).toContain('TASK_EXECUTION_STEPS');
  });

  it('tracks executionStep in provisioning state', () => {
    expect(source).toContain('executionStep: TaskExecutionStep | null');
  });

  it('polls task for executionStep updates', () => {
    expect(source).toContain('task.executionStep');
    expect(source).toContain('executionStep: task.executionStep ?? null');
  });

  it('renders segmented progress bar for provisioning steps', () => {
    expect(source).toContain('PROVISIONING_STEPS');
    expect(source).toContain('PROVISIONING_STEPS.map');
    expect(source).toContain('flex: 1');
  });

  it('filters out running and awaiting_followup from progress bar', () => {
    expect(source).toContain("s !== 'running'");
    expect(source).toContain("s !== 'awaiting_followup'");
  });

  it('shows step as complete, current, or pending', () => {
    expect(source).toContain('isComplete');
    expect(source).toContain('isCurrent');
    expect(source).toContain('var(--sam-color-success)');
    expect(source).toContain('var(--sam-color-accent-primary)');
    expect(source).toContain('var(--sam-color-border-default)');
  });

  it('uses execution step label as status text', () => {
    expect(source).toContain('EXECUTION_STEP_LABELS[state.executionStep]');
  });

  it('shows elapsed time counter', () => {
    expect(source).toContain('elapsedDisplay');
    expect(source).toContain('state.startedAt');
  });

  it('shows branch name during provisioning', () => {
    expect(source).toContain('state.branchName');
  });

  it('shows error message with styled container', () => {
    expect(source).toContain('state.errorMessage');
    expect(source).toContain('var(--sam-color-danger)');
    expect(source).toContain('wordBreak');
  });
});

describe('TaskKanbanCard execution step display', () => {
  const source = readSource('components/task/TaskKanbanCard.tsx');

  it('imports EXECUTION_STEP_LABELS from shared', () => {
    expect(source).toContain("import { EXECUTION_STEP_LABELS } from '@simple-agent-manager/shared'");
  });

  it('shows execution step label for transient statuses', () => {
    expect(source).toContain('task.executionStep');
    expect(source).toContain('EXECUTION_STEP_LABELS[task.executionStep]');
  });

  it('falls back to status string when no execution step', () => {
    expect(source).toContain(': task.status');
  });

  it('shows step label for active tasks with non-running step', () => {
    expect(source).toContain("task.executionStep !== 'running'");
  });
});

describe('TaskExecutionProgress removal (TDF-8)', () => {
  it('TaskExecutionProgress.tsx should not exist (absorbed into ProvisioningIndicator)', () => {
    expect(() => {
      readSource('components/task/TaskExecutionProgress.tsx');
    }).toThrow();
  });
});
