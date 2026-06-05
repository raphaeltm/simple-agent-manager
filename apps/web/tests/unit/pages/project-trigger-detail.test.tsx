import type { TriggerExecutionResponse, TriggerResponse } from '@simple-agent-manager/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '../../../src/hooks/useToast';
import { ProjectContext, type ProjectContextValue } from '../../../src/pages/ProjectContext';
import { ProjectTriggerDetail } from '../../../src/pages/ProjectTriggerDetail';

const mocks = vi.hoisted(() => ({
  getTrigger: vi.fn(),
  listTriggerExecutions: vi.fn(),
  runTrigger: vi.fn(),
  updateTrigger: vi.fn(),
  deleteTrigger: vi.fn(),
  listAgentProfiles: vi.fn(),
}));

vi.mock('../../../src/lib/api', () => ({
  getTrigger: mocks.getTrigger,
  listTriggerExecutions: mocks.listTriggerExecutions,
  runTrigger: mocks.runTrigger,
  updateTrigger: mocks.updateTrigger,
  deleteTrigger: mocks.deleteTrigger,
  listAgentProfiles: mocks.listAgentProfiles,
}));

const projectCtx: ProjectContextValue = {
  projectId: 'proj-test',
  project: null,
  installations: [],
  reload: vi.fn().mockResolvedValue(undefined),
};

function makeTrigger(overrides: Partial<TriggerResponse> = {}): TriggerResponse {
  return {
    id: 'trig-1',
    projectId: 'proj-test',
    userId: 'user-1',
    name: 'Daily Sync',
    description: 'Sync data every day',
    status: 'active',
    sourceType: 'cron',
    cronExpression: '0 0 * * *',
    cronTimezone: 'UTC',
    cronHumanReadable: 'Daily at midnight',
    skipIfRunning: false,
    promptTemplate: 'Run sync',
    agentProfileId: null,
    taskMode: 'task',
    vmSizeOverride: null,
    maxConcurrent: 1,
    lastTriggeredAt: null,
    triggerCount: 0,
    nextFireAt: '2026-06-06T00:00:00Z',
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

function makeExecution(index: number): TriggerExecutionResponse {
  return {
    id: `exec-${index}`,
    triggerId: 'trig-1',
    projectId: 'proj-test',
    status: 'completed',
    eventType: 'cron',
    sequenceNumber: index,
    scheduledAt: `2026-06-${String(index).padStart(2, '0')}T10:00:00Z`,
    startedAt: `2026-06-${String(index).padStart(2, '0')}T10:00:05Z`,
    completedAt: `2026-06-${String(index).padStart(2, '0')}T10:01:00Z`,
    taskId: `task-${index}`,
    renderedPrompt: 'Run sync',
    errorMessage: null,
    skipReason: null,
    createdAt: `2026-06-${String(index).padStart(2, '0')}T10:00:00Z`,
  };
}

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={['/projects/proj-test/triggers/trig-1']}>
      <ProjectContext.Provider value={projectCtx}>
        <ToastProvider>
          <Routes>
            <Route path="/projects/:projectId/triggers/:triggerId" element={<ProjectTriggerDetail />} />
          </Routes>
        </ToastProvider>
      </ProjectContext.Provider>
    </MemoryRouter>,
  );
}

describe('ProjectTriggerDetail pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTrigger.mockResolvedValue(makeTrigger());
    mocks.listAgentProfiles.mockResolvedValue([]);
    mocks.runTrigger.mockResolvedValue({ executionId: 'exec-new', taskId: 'task-new' });
    mocks.updateTrigger.mockResolvedValue(makeTrigger());
    mocks.deleteTrigger.mockResolvedValue({ success: true });
  });

  it('does not show Load more for an exactly full final page without nextCursor', async () => {
    mocks.listTriggerExecutions.mockResolvedValue({
      executions: Array.from({ length: 20 }, (_, i) => makeExecution(i + 1)),
      nextCursor: null,
    });

    renderDetail();

    expect(await screen.findByText('Daily Sync')).toBeInTheDocument();
    await waitFor(() => {
      expect(mocks.listTriggerExecutions).toHaveBeenCalledWith('proj-test', 'trig-1', {
        limit: 20,
        offset: 0,
      });
    });
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
  });

  it('loads the next page using nextCursor and hides Load more when continuation ends', async () => {
    const user = userEvent.setup();
    mocks.listTriggerExecutions
      .mockResolvedValueOnce({
        executions: Array.from({ length: 20 }, (_, i) => makeExecution(i + 1)),
        nextCursor: '20',
      })
      .mockResolvedValueOnce({
        executions: [makeExecution(21)],
        nextCursor: null,
      });

    renderDetail();

    const loadMore = await screen.findByRole('button', { name: /load more/i });
    await user.click(loadMore);

    await waitFor(() => {
      expect(mocks.listTriggerExecutions).toHaveBeenLastCalledWith('proj-test', 'trig-1', {
        limit: 20,
        offset: 20,
      });
    });
    await waitFor(() => {
      expect(screen.getAllByRole('link', { name: /view session/i })).toHaveLength(21);
    });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
    });
  });
});
