import { EXECUTION_STEP_LABELS } from '@simple-agent-manager/shared';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ProvisioningIndicator } from '../../../src/pages/project-chat/ProvisioningIndicator';
import type { ProvisioningState } from '../../../src/pages/project-chat/types';

function makeState(overrides: Partial<ProvisioningState> = {}): ProvisioningState {
  return {
    taskId: 'task-1',
    sessionId: 'sess-1',
    branchName: 'sam/feature-branch',
    status: 'running',
    executionStep: 'workspace_creation',
    errorMessage: null,
    startedAt: Date.now(),
    workspaceId: null,
    workspaceUrl: null,
    requestedVmSize: null,
    provisionedVmSize: null,
    ...overrides,
  };
}

describe('ProvisioningIndicator', () => {
  it('shows staged status text and preserves execution step detail', () => {
    const state = makeState({ executionStep: 'workspace_creation' });
    const { container } = render(
      <ProvisioningIndicator state={state} bootLogCount={0} onViewLogs={vi.fn()} />
    );
    expect(screen.getByText('Cloning repository · 2 of 4')).toBeInTheDocument();
    expect(container).toHaveTextContent('Creating workspace. This usually takes 2–4 minutes.');
  });

  it('shows "Starting..." when no execution step is set', () => {
    const state = makeState({ executionStep: null });
    render(<ProvisioningIndicator state={state} bootLogCount={0} onViewLogs={vi.fn()} />);
    expect(screen.getByText('Starting...')).toBeInTheDocument();
  });

  it('shows the stage track with the current stage marked while provisioning', () => {
    const state = makeState({ executionStep: 'workspace_ready' });
    render(<ProvisioningIndicator state={state} bootLogCount={0} onViewLogs={vi.fn()} />);
    const track = screen.getByTestId('stage-track');
    expect(within(track).getByText('Installing dependencies')).toHaveAttribute(
      'aria-current',
      'step'
    );
    expect(track.querySelectorAll('[data-stage-state="done"]')).toHaveLength(2);
    expect(track.querySelectorAll('[data-stage-state="current"]')).toHaveLength(1);
  });

  it('marks the stage that failed and alerts', () => {
    const state = makeState({
      status: 'failed',
      executionStep: 'workspace_ready',
      errorMessage: 'Something broke',
    });
    render(<ProvisioningIndicator state={state} bootLogCount={0} onViewLogs={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveAttribute('data-tone', 'danger');
    const track = screen.getByTestId('stage-track');
    expect(track.querySelectorAll('[data-stage-state="failed"]')).toHaveLength(1);
    expect(track.querySelectorAll('[data-stage-state="current"]')).toHaveLength(0);
  });

  it('shows "Setup failed" for failed status', () => {
    const state = makeState({ status: 'failed', errorMessage: 'Timeout' });
    render(<ProvisioningIndicator state={state} bootLogCount={0} onViewLogs={vi.fn()} />);
    expect(screen.getByText('Setup failed')).toBeInTheDocument();
  });

  it('shows "Cancelled" for cancelled status', () => {
    const state = makeState({ status: 'cancelled' });
    render(<ProvisioningIndicator state={state} bootLogCount={0} onViewLogs={vi.fn()} />);
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
  });

  it('displays branch name during provisioning', () => {
    const state = makeState({ branchName: 'sam/my-branch' });
    render(<ProvisioningIndicator state={state} bootLogCount={0} onViewLogs={vi.fn()} />);
    expect(screen.getByText('sam/my-branch')).toBeInTheDocument();
  });

  it('hides branch name for terminal states', () => {
    const state = makeState({ status: 'completed', branchName: 'sam/my-branch' });
    render(<ProvisioningIndicator state={state} bootLogCount={0} onViewLogs={vi.fn()} />);
    expect(screen.queryByText('sam/my-branch')).not.toBeInTheDocument();
  });

  it('shows error message when present', () => {
    const state = makeState({ status: 'failed', errorMessage: 'VM failed to start' });
    render(<ProvisioningIndicator state={state} bootLogCount={0} onViewLogs={vi.fn()} />);
    expect(screen.getByText('VM failed to start')).toBeInTheDocument();
  });

  it('does not show error container when errorMessage is null', () => {
    const state = makeState({ errorMessage: null });
    render(<ProvisioningIndicator state={state} bootLogCount={0} onViewLogs={vi.fn()} />);
    expect(screen.queryByText('VM failed to start')).not.toBeInTheDocument();
  });

  it('shows View logs button when bootLogCount > 0', () => {
    const onViewLogs = vi.fn();
    const state = makeState();
    render(<ProvisioningIndicator state={state} bootLogCount={5} onViewLogs={onViewLogs} />);
    expect(screen.getByText('View logs')).toBeInTheDocument();
  });

  it('hides View logs button when bootLogCount is 0', () => {
    const state = makeState();
    render(<ProvisioningIndicator state={state} bootLogCount={0} onViewLogs={vi.fn()} />);
    expect(screen.queryByText('View logs')).not.toBeInTheDocument();
  });

  it('calls onViewLogs when View logs button is clicked', () => {
    const onViewLogs = vi.fn();
    const state = makeState();
    render(<ProvisioningIndicator state={state} bootLogCount={3} onViewLogs={onViewLogs} />);
    screen.getByText('View logs').click();
    expect(onViewLogs).toHaveBeenCalledTimes(1);
  });

  it('hides the stage track once setup completed or was cancelled', () => {
    for (const status of ['completed', 'cancelled'] as const) {
      const { unmount } = render(
        <ProvisioningIndicator
          state={makeState({ status })}
          bootLogCount={0}
          onViewLogs={vi.fn()}
        />
      );
      expect(screen.getByTestId('provisioning-indicator')).toBeInTheDocument();
      expect(screen.queryByTestId('stage-track')).not.toBeInTheDocument();
      unmount();
    }
  });

  it.each([
    { requestedVmSize: 'medium', provisionedVmSize: 'small' },
    { requestedVmSize: 'small', provisionedVmSize: 'large' },
    { requestedVmSize: null, provisionedVmSize: 'medium' },
  ])('does not infer capacity exhaustion from compatibility labels: %j', (sizes) => {
    // A native offering can succeed on its first attempt while its historical
    // size label differs from the request's compatibility label.
    const state = makeState({ ...sizes, executionStep: 'node_agent_ready' });
    const onViewLogs = vi.fn();
    render(<ProvisioningIndicator state={state} bootLogCount={3} onViewLogs={onViewLogs} />);

    expect(
      screen.queryByText(/machines were available|larger size was unavailable/)
    ).not.toBeInTheDocument();
    expect(screen.getByText('Provisioning VM · 1 of 4')).toBeInTheDocument();
    expect(screen.getByText(/This usually takes/)).toHaveTextContent(
      EXECUTION_STEP_LABELS.node_agent_ready.replace(/\.+$/, '.')
    );
    screen.getByRole('button', { name: 'View logs' }).click();
    expect(onViewLogs).toHaveBeenCalledOnce();
  });
});
