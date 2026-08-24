import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithQuery } from '../test-utils/query-test-utils';

const mocks = vi.hoisted(() => ({
  listTaskEvents: vi.fn(),
  useAuth: vi.fn(),
}));

vi.mock('../../src/components/AuthProvider', () => ({
  useAuth: mocks.useAuth,
}));

vi.mock('../../src/lib/api/tasks', () => ({
  listTaskEvents: mocks.listTaskEvents,
}));

vi.mock('../../src/hooks/useQueryScope', () => ({
  useQueryScope: () => 'user-1',
}));

import { FailureCard } from '../../src/components/debug/FailureCard';

function makeTaskEmbed(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-001',
    status: 'failed',
    executionStep: 'running',
    errorMessage: 'Agent process exited unexpectedly with code 137',
    taskMode: 'task',
    ...overrides,
  };
}

const defaultEvents = [
  {
    id: 'ev-1',
    taskId: 'task-001',
    fromStatus: null,
    toStatus: 'ready',
    actorType: 'system',
    actorId: null,
    reason: null,
    createdAt: new Date(Date.now() - 600_000).toISOString(),
  },
  {
    id: 'ev-2',
    taskId: 'task-001',
    fromStatus: 'ready',
    toStatus: 'in_progress',
    actorType: 'agent',
    actorId: 'agent-1',
    reason: null,
    createdAt: new Date(Date.now() - 300_000).toISOString(),
  },
  {
    id: 'ev-3',
    taskId: 'task-001',
    fromStatus: 'in_progress',
    toStatus: 'failed',
    actorType: 'system',
    actorId: null,
    reason: 'Agent process exited unexpectedly with code 137',
    createdAt: new Date(Date.now() - 10_000).toISOString(),
  },
];

describe('FailureCard', () => {
  beforeEach(() => {
    mocks.useAuth.mockReturnValue({ isSuperadmin: false });
    mocks.listTaskEvents.mockResolvedValue({ events: defaultEvents });
  });

  it('renders classification label and explanation for agent crash', () => {
    renderWithQuery(
      <FailureCard projectId="proj-1" taskEmbed={makeTaskEmbed()} recoverable={false} />
    );

    expect(screen.getByText('Agent crashed')).toBeInTheDocument();
    expect(screen.getByText(/exited unexpectedly/i)).toBeInTheDocument();
  });

  it('renders classification for capacity errors', () => {
    renderWithQuery(
      <FailureCard
        projectId="proj-1"
        taskEmbed={makeTaskEmbed({
          errorMessage: 'Server limit reached. You cannot create more servers.',
        })}
        recoverable={false}
      />
    );

    expect(screen.getByText('Cloud capacity')).toBeInTheDocument();
  });

  it('renders classification for cancelled tasks', () => {
    renderWithQuery(
      <FailureCard
        projectId="proj-1"
        taskEmbed={makeTaskEmbed({
          errorMessage: 'Task cancelled by the user.',
          status: 'cancelled',
        })}
        recoverable={false}
      />
    );

    expect(screen.getByText('Cancelled')).toBeInTheDocument();
  });

  it('renders expected human-input expiry as a neutral lifecycle outcome', async () => {
    mocks.useAuth.mockReturnValue({ isSuperadmin: true });
    renderWithQuery(
      <FailureCard
        projectId="proj-1"
        taskEmbed={makeTaskEmbed({
          errorMessage: 'Human input request expired after timeout',
          status: 'failed',
        })}
        recoverable={false}
      />
    );

    expect(screen.getByText('Input request expired')).toBeInTheDocument();
    expect(screen.queryByText('Retryable')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Input request expired/i }));
    await waitFor(() => {
      expect(screen.getByText(/No debugging is needed/i)).toBeInTheDocument();
    });
    expect(screen.getByText('Reason')).toBeInTheDocument();
    expect(screen.queryByText('Error')).not.toBeInTheDocument();
    expect(screen.queryByText('Copy debug report')).not.toBeInTheDocument();
    expect(screen.queryByText('View in admin errors')).not.toBeInTheDocument();
  });

  it('shows Recoverable badge when recoverable', () => {
    renderWithQuery(
      <FailureCard projectId="proj-1" taskEmbed={makeTaskEmbed()} recoverable={true} />
    );

    expect(screen.getByText('Recoverable')).toBeInTheDocument();
  });

  it('expands detail on click', async () => {
    renderWithQuery(
      <FailureCard
        projectId="proj-1"
        taskEmbed={makeTaskEmbed()}
        sessionId="sess-1"
        workspaceId="ws-1"
        nodeId="node-1"
        recoverable={false}
      />
    );

    const toggleBtn = screen.getByRole('button', { name: /Agent crashed/i });
    fireEvent.click(toggleBtn);

    await waitFor(() => {
      expect(screen.getByText('Next step')).toBeInTheDocument();
    });
    expect(screen.getByText('Timeline')).toBeInTheDocument();
    expect(screen.getByText('Error')).toBeInTheDocument();
    expect(screen.getByTitle(/Task: task-001/)).toBeInTheDocument();
    expect(screen.getByTitle(/Session: sess-1/)).toBeInTheDocument();
    expect(screen.getByTitle(/Workspace: ws-1/)).toBeInTheDocument();
    expect(screen.getByTitle(/Node: node-1/)).toBeInTheDocument();
  });

  it('renders lifecycle timeline events from listTaskEvents', async () => {
    renderWithQuery(
      <FailureCard projectId="proj-1" taskEmbed={makeTaskEmbed()} recoverable={false} />
    );

    fireEvent.click(screen.getByRole('button', { name: /Agent crashed/i }));

    await waitFor(() => {
      expect(mocks.listTaskEvents).toHaveBeenCalledWith('proj-1', 'task-001', 50);
    });

    await waitFor(() => {
      expect(screen.getByText('ready')).toBeInTheDocument();
    });
    expect(screen.getByText('in progress')).toBeInTheDocument();
    expect(screen.getByText('failed')).toBeInTheDocument();
    expect(screen.getByText('by agent')).toBeInTheDocument();
  });

  it('copy debug report button copies to clipboard', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      writable: true,
      configurable: true,
    });

    renderWithQuery(
      <FailureCard
        projectId="proj-1"
        taskEmbed={makeTaskEmbed()}
        sessionId="sess-1"
        recoverable={false}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Agent crashed/i }));

    // Wait for the lifecycle events to load so the report can include them.
    await waitFor(() => {
      expect(screen.getByText('failed')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Copy debug report'));

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledTimes(1);
    });

    const report = writeTextMock.mock.calls[0]![0] as string;
    expect(report).toContain('task-001');
    expect(report).toContain('sess-1');
    expect(report).toContain('agent-crash');
    expect(report).toContain('Agent process exited');
    // The loaded lifecycle timeline is part of the copied report.
    expect(report).toContain('Status Events');
    expect(report).toContain('in_progress → failed');
    expect(report).toContain('Agent process exited unexpectedly with code 137');

    await waitFor(() => {
      expect(screen.getByText('Copied')).toBeInTheDocument();
    });
  });

  it('does not show admin errors link for non-superadmin', () => {
    mocks.useAuth.mockReturnValue({ isSuperadmin: false });

    renderWithQuery(
      <FailureCard
        projectId="proj-1"
        taskEmbed={makeTaskEmbed()}
        sessionId="sess-1"
        recoverable={false}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Agent crashed/i }));
    expect(screen.queryByText('View in admin errors')).not.toBeInTheDocument();
  });

  it('shows admin errors link for superadmin', async () => {
    mocks.useAuth.mockReturnValue({ isSuperadmin: true });

    renderWithQuery(
      <FailureCard
        projectId="proj-1"
        taskEmbed={makeTaskEmbed()}
        sessionId="sess-1"
        recoverable={false}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Agent crashed/i }));

    await waitFor(() => {
      const link = screen.getByText('View in admin errors');
      expect(link).toBeInTheDocument();
      expect(link.closest('a')).toHaveAttribute('href', expect.stringContaining('/admin/errors'));
      expect(link.closest('a')).toHaveAttribute(
        'href',
        expect.stringContaining('sessionId=sess-1')
      );
      expect(link.closest('a')).toHaveAttribute('href', expect.stringContaining('taskId=task-001'));
    });
  });

  it('shows recoverable guidance when expanded', async () => {
    renderWithQuery(
      <FailureCard projectId="proj-1" taskEmbed={makeTaskEmbed()} recoverable={true} />
    );

    fireEvent.click(screen.getByRole('button', { name: /Agent crashed/i }));

    await waitFor(() => {
      expect(screen.getByText(/Send another message to retry/)).toBeInTheDocument();
    });
  });

  it('shows execution step when available', async () => {
    renderWithQuery(
      <FailureCard
        projectId="proj-1"
        taskEmbed={makeTaskEmbed({ executionStep: 'provisioning_node' })}
        recoverable={false}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Agent crashed/i }));

    await waitFor(() => {
      expect(screen.getByText('provisioning node')).toBeInTheDocument();
    });
  });

  it('handles empty events gracefully', async () => {
    mocks.listTaskEvents.mockResolvedValue({ events: [] });

    renderWithQuery(
      <FailureCard projectId="proj-1" taskEmbed={makeTaskEmbed()} recoverable={false} />
    );

    fireEvent.click(screen.getByRole('button', { name: /Agent crashed/i }));

    await waitFor(() => {
      expect(screen.getByText('No lifecycle events recorded.')).toBeInTheDocument();
    });
  });

  it('handles event loading error gracefully', async () => {
    mocks.listTaskEvents.mockRejectedValue(new Error('Network error'));

    renderWithQuery(
      <FailureCard projectId="proj-1" taskEmbed={makeTaskEmbed()} recoverable={false} />
    );

    fireEvent.click(screen.getByRole('button', { name: /Agent crashed/i }));

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
  });

  it('shows "Copy failed" when the clipboard write rejects', async () => {
    const writeTextMock = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      writable: true,
      configurable: true,
    });

    renderWithQuery(
      <FailureCard projectId="proj-1" taskEmbed={makeTaskEmbed()} recoverable={false} />
    );

    fireEvent.click(screen.getByRole('button', { name: /Agent crashed/i }));
    await waitFor(() => {
      expect(screen.getByText('Copy debug report')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Copy debug report'));

    await waitFor(() => {
      expect(screen.getByText('Copy failed')).toBeInTheDocument();
    });
  });

  it('shows "Copy failed" when the clipboard API is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      writable: true,
      configurable: true,
    });

    renderWithQuery(
      <FailureCard projectId="proj-1" taskEmbed={makeTaskEmbed()} recoverable={false} />
    );

    fireEvent.click(screen.getByRole('button', { name: /Agent crashed/i }));
    await waitFor(() => {
      expect(screen.getByText('Copy debug report')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Copy debug report'));

    await waitFor(() => {
      expect(screen.getByText('Copy failed')).toBeInTheDocument();
    });
  });
});
