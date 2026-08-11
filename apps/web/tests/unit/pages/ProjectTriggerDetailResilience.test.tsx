import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getTrigger: vi.fn(),
  listTriggerExecutions: vi.fn(),
  runTrigger: vi.fn(),
  updateTrigger: vi.fn(),
  deleteTrigger: vi.fn(),
  listAgentProfiles: vi.fn(),
  listSkills: vi.fn(),
}));

vi.mock('../../../src/lib/api', () => mocks);
vi.mock('../../../src/lib/api/triggers', () => mocks);

import { ToastProvider } from '../../../src/hooks/useToast';
import { ProjectContext, type ProjectContextValue } from '../../../src/pages/ProjectContext';
import { ProjectTriggerDetail } from '../../../src/pages/ProjectTriggerDetail';

const TRIGGER = {
  id: 'trig-1',
  projectId: 'proj-1',
  userId: 'u1',
  name: 'Nightly Tests',
  description: 'Runs the suite',
  status: 'active',
  sourceType: 'cron',
  cronExpression: '30 2 * * *',
  cronTimezone: 'UTC',
  cronHumanReadable: 'At 2:30 AM',
  skipIfRunning: true,
  promptTemplate: 'run',
  agentProfileId: null,
  taskMode: 'task',
  vmSizeOverride: null,
  maxConcurrent: 1,
  nextFireAt: null,
  lastTriggeredAt: null,
  triggerCount: 3,
  createdAt: '2026-05-01T00:00:00Z',
  updatedAt: '2026-05-01T00:00:00Z',
};

const CONTEXT: ProjectContextValue = {
  projectId: 'proj-1',
  project: null,
  installations: [],
  reload: vi.fn().mockResolvedValue(undefined),
};

function renderDetail(initialPath = '/projects/proj-1/triggers/trig-1') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <ProjectContext.Provider value={CONTEXT}>
        <ToastProvider>
          <Routes>
            <Route path="/projects/:id/triggers/:triggerId" element={<ProjectTriggerDetail />} />
            <Route path="/projects/:id/triggers" element={<ProjectTriggerDetail />} />
          </Routes>
        </ToastProvider>
      </ProjectContext.Provider>
    </MemoryRouter>
  );
}

describe('ProjectTriggerDetail — resilience', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listTriggerExecutions.mockResolvedValue({ executions: [], nextCursor: null });
    mocks.listAgentProfiles.mockResolvedValue({ items: [] });
    mocks.listSkills.mockResolvedValue({ items: [] });
    mocks.runTrigger.mockResolvedValue({});
  });

  /**
   * `loadTrigger()` re-runs after Run Now, Pause/Resume, save and token
   * rotation. A transient failure on any of those used to replace the ENTIRE
   * page — header, execution history, webhook panel and any open dialog — with
   * a "Trigger not found" screen whose only button navigates away. Rule 48:
   * a failed background refetch must not tear down already-rendered content.
   */
  it('keeps the trigger on screen when a background refetch fails', async () => {
    const user = userEvent.setup();
    mocks.getTrigger.mockResolvedValueOnce(TRIGGER);
    renderDetail();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Nightly Tests' })).toBeInTheDocument();
    });

    // The refetch triggered by Run Now fails.
    mocks.getTrigger.mockRejectedValueOnce(new Error('Network unreachable'));
    await user.click(screen.getByRole('button', { name: /run now/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Network unreachable/);
    });

    // The page must still be there.
    expect(screen.getByRole('heading', { name: 'Nightly Tests' })).toBeInTheDocument();
    expect(screen.queryByText('Trigger not found')).not.toBeInTheDocument();
  });

  it('still shows the fatal screen when the very first load fails', async () => {
    mocks.getTrigger.mockRejectedValueOnce(new Error('Boom'));
    renderDetail();

    await waitFor(() => {
      expect(screen.getByText('Boom')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /back to triggers/i })).toBeInTheDocument();
  });

  /**
   * The `if (!triggerId) return;` guard sat BEFORE the try/finally that clears
   * `loading`, so a missing route param left a spinner running forever with no
   * error and no way to recover.
   */
  it('reports a missing trigger id instead of spinning forever', async () => {
    renderDetail('/projects/proj-1/triggers');

    await waitFor(() => {
      expect(screen.getByText(/missing trigger id/i)).toBeInTheDocument();
    });
    expect(mocks.getTrigger).not.toHaveBeenCalled();
  });
});
