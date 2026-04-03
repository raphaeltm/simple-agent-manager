import { EXECUTION_STEP_LABELS } from '@simple-agent-manager/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ProvisioningIndicator } from '../../../src/pages/project-chat/ProvisioningIndicator';
import type { ProvisioningState } from '../../../src/pages/project-chat/types';

vi.mock('@simple-agent-manager/ui', () => ({
  Spinner: ({ size }: { size?: string }) => <span data-testid="spinner" data-size={size}>Loading...</span>,
}));

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
    ...overrides,
  };
}

describe('ProvisioningIndicator', () => {
  it('shows the execution step label as status text', () => {
    const state = makeState({ executionStep: 'workspace_creation' });
    render(<ProvisioningIndicator state={state} bootLogCount={0} onViewLogs={vi.fn()} />);
    expect(screen.getByText(EXECUTION_STEP_LABELS.workspace_creation)).toBeInTheDocument();
  });

  it('shows "Starting..." when no execution step is set', () => {
    const state = makeState({ executionStep: null });
    render(<ProvisioningIndicator state={state} bootLogCount={0} onViewLogs={vi.fn()} />);
    expect(screen.getByText('Starting...')).toBeInTheDocument();
  });

  it('shows spinner for non-terminal states', () => {
    const state = makeState({ status: 'running' });
    render(<ProvisioningIndicator state={state} bootLogCount={0} onViewLogs={vi.fn()} />);
    expect(screen.getByTestId('spinner')).toBeInTheDocument();
  });

  it('hides spinner for terminal states', () => {
    const state = makeState({ status: 'failed', errorMessage: 'Something broke' });
    render(<ProvisioningIndicator state={state} bootLogCount={0} onViewLogs={vi.fn()} />);
    expect(screen.queryByTestId('spinner')).not.toBeInTheDocument();
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

  it('shows View Logs button when bootLogCount > 0', () => {
    const onViewLogs = vi.fn();
    const state = makeState();
    render(<ProvisioningIndicator state={state} bootLogCount={5} onViewLogs={onViewLogs} />);
    expect(screen.getByText('View Logs')).toBeInTheDocument();
  });

  it('hides View Logs button when bootLogCount is 0', () => {
    const state = makeState();
    render(<ProvisioningIndicator state={state} bootLogCount={0} onViewLogs={vi.fn()} />);
    expect(screen.queryByText('View Logs')).not.toBeInTheDocument();
  });

  it('calls onViewLogs when View Logs button is clicked', () => {
    const onViewLogs = vi.fn();
    const state = makeState();
    render(<ProvisioningIndicator state={state} bootLogCount={3} onViewLogs={onViewLogs} />);
    screen.getByText('View Logs').click();
    expect(onViewLogs).toHaveBeenCalledTimes(1);
  });

  it('renders progress bar segments for non-terminal state', () => {
    const state = makeState({ executionStep: 'workspace_creation' });
    const { container } = render(
      <ProvisioningIndicator state={state} bootLogCount={0} onViewLogs={vi.fn()} />,
    );
    // Progress bar has multiple segment divs with title attributes matching step labels
    const segments = container.querySelectorAll('[title]');
    expect(segments.length).toBeGreaterThan(0);
    // 'running' and 'awaiting_followup' are filtered out from progress bar
    const titles = Array.from(segments).map((el) => el.getAttribute('title'));
    expect(titles).not.toContain(EXECUTION_STEP_LABELS.running);
    expect(titles).not.toContain(EXECUTION_STEP_LABELS.awaiting_followup);
  });

  it('hides progress bar for terminal states', () => {
    const state = makeState({ status: 'completed' });
    const { container } = render(
      <ProvisioningIndicator state={state} bootLogCount={0} onViewLogs={vi.fn()} />,
    );
    const segments = container.querySelectorAll('[title]');
    expect(segments.length).toBe(0);
  });
});
