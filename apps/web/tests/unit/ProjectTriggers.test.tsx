import type { TriggerResponse } from '@simple-agent-manager/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  listTriggers: vi.fn(),
  runTrigger: vi.fn().mockResolvedValue({ executionId: 'exec-1', taskId: 'task-1' }),
  updateTrigger: vi.fn(),
  deleteTrigger: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('../../src/lib/api', () => api);
vi.mock('../../src/hooks/useQueryScope', () => ({ useQueryScope: () => 'user-1' }));
vi.mock('../../src/hooks/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../src/pages/ProjectContext', () => ({
  useProjectContext: () => ({ projectId: 'project-1' }),
}));
vi.mock('../../src/components/triggers/TriggerForm', () => ({
  TriggerForm: ({ onSaved }: { onSaved: () => void }) => (
    <button onClick={onSaved}>mock saved</button>
  ),
}));
vi.mock('../../src/components/triggers/WebhookCredentialDialog', () => ({
  WebhookCredentialDialog: () => <div>webhook credential</div>,
}));
vi.mock('../../src/components/triggers/TriggerCard', () => ({
  TriggerCard: ({
    trigger,
    onTogglePause,
  }: {
    trigger: TriggerResponse;
    onTogglePause: (trigger: TriggerResponse) => void;
  }) => (
    <article>
      <h2>{trigger.name}</h2>
      <button onClick={() => onTogglePause(trigger)}>toggle {trigger.name}</button>
    </article>
  ),
}));

import { ProjectTriggers } from '../../src/pages/ProjectTriggers';

const trigger: TriggerResponse = {
  id: 'trigger-1',
  projectId: 'project-1',
  userId: 'user-1',
  name: 'Daily review',
  description: null,
  status: 'active',
  sourceType: 'cron',
  cronExpression: '0 9 * * *',
  cronTimezone: 'UTC',
  skipIfRunning: true,
  promptTemplate: 'Review',
  agentProfileId: null,
  skillId: null,
  taskMode: 'task',
  vmSizeOverride: null,
  maxConcurrent: 1,
  lastTriggeredAt: null,
  triggerCount: 0,
  nextFireAt: null,
  createdAt: '2026-08-19T00:00:00.000Z',
  updatedAt: '2026-08-19T00:00:00.000Z',
};

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 15_000 }, mutations: { retry: false } },
  });
}

function renderWithClient(ui: ReactElement, queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listTriggers.mockResolvedValue({ triggers: [trigger] });
  api.updateTrigger.mockResolvedValue({ ...trigger, status: 'paused' });
});
afterEach(cleanup);

describe('ProjectTriggers', () => {
  it('uses TanStack Query cache across mounts and invalidates after mutations', async () => {
    const user = userEvent.setup();
    const queryClient = makeClient();

    const first = renderWithClient(<ProjectTriggers />, queryClient);
    expect(await screen.findByText('Daily review')).toBeInTheDocument();
    expect(api.listTriggers).toHaveBeenCalledTimes(1);

    first.unmount();
    renderWithClient(<ProjectTriggers />, queryClient);
    expect(await screen.findByText('Daily review')).toBeInTheDocument();
    expect(api.listTriggers).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: /toggle daily review/i }));

    await waitFor(() => expect(api.updateTrigger).toHaveBeenCalledWith('project-1', 'trigger-1', { status: 'paused' }));
    await waitFor(() => expect(api.listTriggers).toHaveBeenCalledTimes(2));
  });
});
