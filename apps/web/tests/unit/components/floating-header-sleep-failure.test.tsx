import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { FloatingHeader } from '../../../src/components/project-message-view/FloatingHeader';

vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => ({ user: null, isSuperadmin: false }),
}));

type Lifecycle = React.ComponentProps<typeof FloatingHeader>['lc'];
const oldRuntimeError =
  'Task runtime is conclusively gone after reconciliation grace (workspace_missing).';

function lifecycle(overrides: Partial<Lifecycle> = {}): Lifecycle {
  return {
    session: {
      id: 'sleeping-session', projectId: 'project', taskId: 'old-task',
      topic: 'Preserved workspace', status: 'sleeping', workspaceId: null,
      createdAt: Date.now(), updatedAt: Date.now(), messageCount: 2,
    },
    sessionState: 'sleeping',
    taskEmbed: {
      id: 'old-task', title: 'Preserved workspace', status: 'failed',
      taskMode: 'conversation', executionStep: null, errorMessage: oldRuntimeError,
      outputSummary: null,
    },
    messages: [], hasMore: false, loading: false,
    workspace: null, node: null, detectedPorts: [], idleCountdownMs: null,
    wakeRecoveryStatus: null, resumeError: null,
    ...overrides,
  } as Lifecycle;
}

function renderHeader(lc: Lifecycle) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <FloatingHeader projectId="project" lc={lc} expanded={false} onExpandedChange={vi.fn()} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('FloatingHeader sleeping runtime failure precedence', () => {
  it.each([null, 'waking', 'restored'] as const)(
    'preserves sleeping status without claiming failed recovery when recoveryStatus is %s',
    (wakeRecoveryStatus) => {
      renderHeader(lifecycle({ wakeRecoveryStatus }));
      expect(screen.getByText('Sleeping', { exact: true })).toBeInTheDocument();
      expect(screen.queryByTestId('failure-card-shell')).not.toBeInTheDocument();
      expect(screen.queryByText('Runtime lost')).not.toBeInTheDocument();
    },
  );

  it('retains a canonical failed recovery while the session remains sleeping', () => {
    renderHeader(lifecycle({ wakeRecoveryStatus: 'failed' }));
    expect(screen.getByText('Sleeping', { exact: true })).toBeInTheDocument();
    expect(screen.getByTestId('failure-card-shell')).toBeInTheDocument();
    expect(screen.getByText('Runtime lost')).toBeInTheDocument();
  });

  it('retains a current resume failure', () => {
    renderHeader(lifecycle({ resumeError: 'Snapshot recovery failed' }));
    expect(screen.getByTestId('failure-card-shell')).toBeInTheDocument();
  });

  it('retains runtime failures for an active session', () => {
    const lc = lifecycle();
    renderHeader({ ...lc, session: { ...lc.session!, status: 'active' }, sessionState: 'active' });
    expect(screen.getByText('Runtime lost')).toBeInTheDocument();
  });

  it('retains genuine snapshot errors while sleeping', () => {
    const lc = lifecycle();
    renderHeader({ ...lc, taskEmbed: { ...lc.taskEmbed!, errorMessage: 'Snapshot upload failed' } });
    expect(screen.getByTestId('failure-card-shell')).toBeInTheDocument();
  });
});
