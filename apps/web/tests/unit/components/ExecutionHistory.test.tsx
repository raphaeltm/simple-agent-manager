import type { TriggerExecutionResponse } from '@simple-agent-manager/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cleanupStuckExecutions: vi.fn(),
  deleteExecution: vi.fn(),
  isMobile: false,
}));

vi.mock('../../../src/lib/api/triggers', () => ({
  cleanupStuckExecutions: mocks.cleanupStuckExecutions,
  deleteExecution: mocks.deleteExecution,
}));

vi.mock('../../../src/hooks/useIsMobile', () => ({
  useIsMobile: () => mocks.isMobile,
}));

import { ExecutionHistory } from '../../../src/components/triggers/ExecutionHistory';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeExecution(overrides: Partial<TriggerExecutionResponse> & { id: string }): TriggerExecutionResponse {
  return {
    id: overrides.id,
    triggerId: 'trigger-1',
    projectId: 'project-1',
    status: 'completed',
    eventType: 'cron',
    sequenceNumber: 1,
    scheduledAt: '2026-06-05T10:00:00Z',
    startedAt: '2026-06-05T10:00:05Z',
    completedAt: '2026-06-05T10:01:00Z',
    taskId: null,
    renderedPrompt: 'Run trigger',
    errorMessage: null,
    skipReason: null,
    createdAt: '2026-06-05T10:00:00Z',
    ...overrides,
  };
}

function renderHistory(props: Partial<ComponentProps<typeof ExecutionHistory>> = {}) {
  return render(
    <ExecutionHistory
      executions={[makeExecution({ id: 'exec-1', status: 'queued', startedAt: null, completedAt: null })]}
      loading={false}
      hasMore={false}
      onLoadMore={vi.fn()}
      projectId="project-1"
      triggerId="trigger-1"
      onMutated={vi.fn()}
      {...props}
    />,
  );
}

describe('ExecutionHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isMobile = false;
    mocks.cleanupStuckExecutions.mockResolvedValue({ cleaned: 1 });
    mocks.deleteExecution.mockResolvedValue({ success: true });
  });

  it('cleans up stuck executions, disables destructive controls while in flight, and refreshes', async () => {
    const user = userEvent.setup();
    const pendingCleanup = deferred<{ cleaned: number }>();
    const onMutated = vi.fn();
    mocks.cleanupStuckExecutions.mockReturnValue(pendingCleanup.promise);

    renderHistory({ onMutated });

    const cleanupButton = screen.getByRole('button', { name: /clear stuck queued/i });
    const deleteButton = screen.getByRole('button', { name: /delete execution/i });
    await user.click(cleanupButton);

    expect(cleanupButton).toBeDisabled();
    expect(deleteButton).toBeDisabled();
    expect(mocks.cleanupStuckExecutions).toHaveBeenCalledWith('project-1', 'trigger-1');

    pendingCleanup.resolve({ cleaned: 1 });
    await waitFor(() => expect(onMutated).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows cleanup failure feedback and re-enables controls', async () => {
    const user = userEvent.setup();
    mocks.cleanupStuckExecutions.mockRejectedValue(new Error('Cleanup failed'));

    renderHistory();

    await user.click(screen.getByRole('button', { name: /clear stuck queued/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Cleanup failed');
    expect(screen.getByRole('button', { name: /clear stuck queued/i })).not.toBeDisabled();
  });

  it('deletes an execution, disables destructive controls while in flight, and refreshes', async () => {
    const user = userEvent.setup();
    const pendingDelete = deferred<{ success: boolean }>();
    const onMutated = vi.fn();
    mocks.deleteExecution.mockReturnValue(pendingDelete.promise);

    renderHistory({
      executions: [
        makeExecution({ id: 'exec-1', status: 'queued', startedAt: null, completedAt: null }),
        makeExecution({ id: 'exec-2', status: 'completed' }),
      ],
      onMutated,
    });

    const deleteButtons = screen.getAllByRole('button', { name: /delete execution/i });
    await user.click(deleteButtons[1]);

    expect(deleteButtons[0]).toBeDisabled();
    expect(deleteButtons[1]).toBeDisabled();
    expect(mocks.deleteExecution).toHaveBeenCalledWith('project-1', 'trigger-1', 'exec-2');

    pendingDelete.resolve({ success: true });
    await waitFor(() => expect(onMutated).toHaveBeenCalledTimes(1));
  });

  it('shows delete failure feedback and preserves the row', async () => {
    const user = userEvent.setup();
    mocks.deleteExecution.mockRejectedValue(new Error('Delete failed'));

    renderHistory({ executions: [makeExecution({ id: 'exec-1', status: 'completed' })] });

    await user.click(screen.getByRole('button', { name: /delete execution/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Delete failed');
    expect(screen.getByRole('button', { name: /delete execution/i })).not.toBeDisabled();
    expect(screen.getByText('Completed')).toBeInTheDocument();
  });

  it('does not show a delete control for running executions on desktop or mobile', () => {
    const running = makeExecution({
      id: 'exec-running',
      status: 'running',
      completedAt: null,
      taskId: 'task-1',
    });

    const { rerender } = renderHistory({ executions: [running] });
    expect(screen.queryByRole('button', { name: /delete execution/i })).not.toBeInTheDocument();

    mocks.isMobile = true;
    rerender(
      <ExecutionHistory
        executions={[running]}
        loading={false}
        hasMore={false}
        onLoadMore={vi.fn()}
        projectId="project-1"
        triggerId="trigger-1"
      />,
    );
    expect(screen.queryByRole('button', { name: /delete execution/i })).not.toBeInTheDocument();
  });
});
