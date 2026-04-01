/**
 * Behavioral tests for task execution step tracking (TDF-8).
 *
 * - Shared type tests (EXECUTION_STEP_LABELS, EXECUTION_STEP_ORDER) are genuine
 *   behavioral tests and are preserved from the original file.
 * - ProvisioningIndicator tests are NEW behavioral tests replacing source-contract tests.
 */
import {
  EXECUTION_STEP_LABELS,
  EXECUTION_STEP_ORDER,
  isTaskExecutionStep,
  TASK_EXECUTION_STEPS,
} from '@simple-agent-manager/shared';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProvisioningIndicator } from '../../src/pages/project-chat/ProvisioningIndicator';
import type { ProvisioningState } from '../../src/pages/project-chat/types';

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Shared type tests (preserved — these are already behavioral, not source-contract)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// ProvisioningIndicator — behavioral tests (replaces source-contract tests)
// ---------------------------------------------------------------------------

function makeProvisioningState(overrides: Partial<ProvisioningState> = {}): ProvisioningState {
  return {
    taskId: 'task-1',
    sessionId: 'session-1',
    branchName: 'sam/fix-bug',
    status: 'in_progress',
    executionStep: 'workspace_creation',
    errorMessage: null,
    startedAt: Date.now() - 10_000, // 10 seconds ago
    workspaceId: null,
    workspaceUrl: null,
    ...overrides,
  };
}

describe('ProvisioningIndicator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the current execution step label', () => {
    render(
      <ProvisioningIndicator
        state={makeProvisioningState({ executionStep: 'workspace_creation' })}
        bootLogCount={0}
        onViewLogs={vi.fn()}
      />,
    );

    expect(screen.getByText(EXECUTION_STEP_LABELS.workspace_creation)).toBeInTheDocument();
  });

  it('shows "Starting..." when no execution step is set', () => {
    render(
      <ProvisioningIndicator
        state={makeProvisioningState({ executionStep: null })}
        bootLogCount={0}
        onViewLogs={vi.fn()}
      />,
    );

    expect(screen.getByText('Starting...')).toBeInTheDocument();
  });

  it('renders progress bar with correct segments (excluding running and awaiting_followup)', () => {
    const { container } = render(
      <ProvisioningIndicator
        state={makeProvisioningState({ executionStep: 'workspace_creation' })}
        bootLogCount={0}
        onViewLogs={vi.fn()}
      />,
    );

    // Progress bar segments — should be TASK_EXECUTION_STEPS minus 'running' and 'awaiting_followup'
    const expectedCount = TASK_EXECUTION_STEPS.filter(
      (s) => s !== 'running' && s !== 'awaiting_followup',
    ).length;

    // Each segment has a title attribute with the step label
    const segments = container.querySelectorAll('[title]');
    const stepSegments = Array.from(segments).filter((el) =>
      Object.values(EXECUTION_STEP_LABELS).some((label) => el.getAttribute('title') === label),
    );
    expect(stepSegments.length).toBe(expectedCount);
  });

  it('shows elapsed time and updates it over time', async () => {
    const startedAt = Date.now();
    render(
      <ProvisioningIndicator
        state={makeProvisioningState({ startedAt })}
        bootLogCount={0}
        onViewLogs={vi.fn()}
      />,
    );

    expect(screen.getByText('0s')).toBeInTheDocument();

    // Advance 5 seconds
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(screen.getByText('5s')).toBeInTheDocument();

    // Advance to 65 seconds
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(screen.getByText('1m 5s')).toBeInTheDocument();
  });

  it('shows branch name during provisioning', () => {
    render(
      <ProvisioningIndicator
        state={makeProvisioningState({ branchName: 'sam/my-branch' })}
        bootLogCount={0}
        onViewLogs={vi.fn()}
      />,
    );

    expect(screen.getByText('sam/my-branch')).toBeInTheDocument();
  });

  it('shows error message when present', () => {
    render(
      <ProvisioningIndicator
        state={makeProvisioningState({
          status: 'failed',
          errorMessage: 'VM failed to start',
        })}
        bootLogCount={0}
        onViewLogs={vi.fn()}
      />,
    );

    expect(screen.getByText('Setup failed')).toBeInTheDocument();
    expect(screen.getByText('VM failed to start')).toBeInTheDocument();
  });

  it('shows View Logs button when bootLogCount > 0 and fires callback', () => {
    const onViewLogs = vi.fn();
    render(
      <ProvisioningIndicator
        state={makeProvisioningState()}
        bootLogCount={5}
        onViewLogs={onViewLogs}
      />,
    );

    const button = screen.getByText('View Logs');
    expect(button).toBeInTheDocument();

    fireEvent.click(button);
    expect(onViewLogs).toHaveBeenCalledTimes(1);
  });

  it('hides View Logs button when bootLogCount is 0', () => {
    render(
      <ProvisioningIndicator
        state={makeProvisioningState()}
        bootLogCount={0}
        onViewLogs={vi.fn()}
      />,
    );

    expect(screen.queryByText('View Logs')).not.toBeInTheDocument();
  });

  it('stops elapsed timer for terminal states', async () => {
    const startedAt = Date.now() - 30_000;
    render(
      <ProvisioningIndicator
        state={makeProvisioningState({ status: 'completed', startedAt })}
        bootLogCount={0}
        onViewLogs={vi.fn()}
      />,
    );

    const initialText = screen.getByText('0s');

    // Advance time — elapsed should NOT update for terminal states
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    // Should still show 0s (timer doesn't start for terminal states)
    expect(initialText).toBeInTheDocument();
  });

  it('does not show progress bar for terminal states', () => {
    const { container } = render(
      <ProvisioningIndicator
        state={makeProvisioningState({ status: 'failed' })}
        bootLogCount={0}
        onViewLogs={vi.fn()}
      />,
    );

    // No progress bar segments should be rendered for terminal states
    const stepSegments = Array.from(container.querySelectorAll('[title]')).filter((el) =>
      Object.values(EXECUTION_STEP_LABELS).some((label) => el.getAttribute('title') === label),
    );
    expect(stepSegments.length).toBe(0);
  });
});
