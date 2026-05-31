import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '../../../src/hooks/useToast';
import { createTrigger } from '../../../src/lib/api';
import { ProjectContext, type ProjectContextValue } from '../../../src/pages/ProjectContext';
import { ProjectTriggers } from '../../../src/pages/ProjectTriggers';

// ---------------------------------------------------------------------------
// Mocks — inline data to avoid hoisting issues with vi.mock
// ---------------------------------------------------------------------------

vi.mock('../../../src/lib/api', () => ({
  listTriggers: vi.fn().mockResolvedValue({
    triggers: [
      {
        id: 'trig-1', projectId: 'proj-test', userId: 'user-1', name: 'Daily Sync',
        description: 'Sync data every day', status: 'active', sourceType: 'cron',
        cronExpression: '0 0 * * *', cronTimezone: 'UTC', skipIfRunning: false,
        promptTemplate: 'Run sync', agentProfileId: null, taskMode: 'task',
        vmSizeOverride: null, maxConcurrent: 1, lastTriggeredAt: null,
        triggerCount: 0, nextFireAt: '2026-06-01T00:00:00Z',
        createdAt: '2026-05-01T00:00:00Z', updatedAt: '2026-05-01T00:00:00Z',
      },
      {
        id: 'trig-2', projectId: 'proj-test', userId: 'user-1', name: 'Weekly Report',
        description: 'Generate weekly report', status: 'active', sourceType: 'cron',
        cronExpression: '0 9 * * 1', cronTimezone: 'UTC', skipIfRunning: false,
        promptTemplate: 'Run report', agentProfileId: null, taskMode: 'task',
        vmSizeOverride: null, maxConcurrent: 1, lastTriggeredAt: null,
        triggerCount: 0, nextFireAt: '2026-06-02T09:00:00Z',
        createdAt: '2026-05-01T00:00:00Z', updatedAt: '2026-05-01T00:00:00Z',
      },
    ],
  }),
  runTrigger: vi.fn().mockResolvedValue(undefined),
  updateTrigger: vi.fn().mockResolvedValue(undefined),
  createTrigger: vi.fn().mockResolvedValue(undefined),
  listAgentProfiles: vi.fn().mockResolvedValue([]),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const projectCtx: ProjectContextValue = {
  projectId: 'proj-test',
  project: null,
  installations: [],
  reload: vi.fn().mockResolvedValue(undefined),
};

function renderTriggers(initialRoute = '/projects/proj-test/triggers') {
  return render(
    <MemoryRouter initialEntries={[initialRoute]}>
      <ProjectContext.Provider value={projectCtx}>
        <ToastProvider>
          <ProjectTriggers />
        </ToastProvider>
      </ProjectContext.Provider>
    </MemoryRouter>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProjectTriggers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders trigger list', async () => {
    renderTriggers();
    await waitFor(() => {
      expect(screen.getByText('Daily Sync')).toBeInTheDocument();
      expect(screen.getByText('Weekly Report')).toBeInTheDocument();
    });
  });

  describe('URL-driven edit modal', () => {
    it('opens edit form when ?edit=<triggerId> is in the URL', async () => {
      renderTriggers('/projects/proj-test/triggers?edit=trig-1');
      await waitFor(() => {
        expect(screen.getByText('Daily Sync')).toBeInTheDocument();
      });
      // TriggerForm shows "Edit Trigger" as heading when editing
      await waitFor(() => {
        expect(screen.getByText('Edit Trigger')).toBeInTheDocument();
      });
    });

    it('opens create form when ?edit=new is in the URL', async () => {
      renderTriggers('/projects/proj-test/triggers?edit=new');
      await waitFor(() => {
        expect(screen.getByText('Daily Sync')).toBeInTheDocument();
      });
      // The form dialog should be open (aria-label="Create trigger")
      await waitFor(() => {
        expect(screen.getByRole('dialog', { name: /create trigger/i })).toBeInTheDocument();
      });
    });

    it('does not open form when no ?edit param is present', async () => {
      renderTriggers();
      await waitFor(() => {
        expect(screen.getByText('Daily Sync')).toBeInTheDocument();
      });
      expect(screen.queryByText('Edit Trigger')).not.toBeInTheDocument();
    });

    it('clicking header New Trigger button opens form', async () => {
      const user = userEvent.setup();
      renderTriggers();
      await waitFor(() => {
        expect(screen.getByText('Daily Sync')).toBeInTheDocument();
      });
      // Click the header "New Trigger" button (first one in the page header)
      const buttons = screen.getAllByRole('button', { name: /new trigger/i });
      await user.click(buttons[0]);
      await waitFor(() => {
        // The form heading "New Trigger" should now appear
        expect(screen.getByRole('heading', { name: /new trigger/i })).toBeInTheDocument();
      });
    });

    it('creates a GitHub event trigger from the form', async () => {
      const user = userEvent.setup();
      renderTriggers();
      await waitFor(() => {
        expect(screen.getByText('Daily Sync')).toBeInTheDocument();
      });

      await user.click(screen.getAllByRole('button', { name: /new trigger/i })[0]);
      await user.type(screen.getByLabelText(/^name$/i), 'SAM comment command');
      await user.click(screen.getByRole('button', { name: /github event/i }));
      await user.clear(screen.getByLabelText(/prompt template/i));
      await user.type(screen.getByLabelText(/prompt template/i), 'Handle GitHub comment');
      await user.click(screen.getByRole('button', { name: /create trigger/i }));

      await waitFor(() => {
        expect(createTrigger).toHaveBeenCalledWith('proj-test', expect.objectContaining({
          name: 'SAM comment command',
          sourceType: 'github',
          promptTemplate: 'Handle GitHub comment',
          githubConfig: {
            eventType: 'issue_comment',
            filters: {
              actions: ['created'],
              commandPrefix: '/sam',
              ignoreActors: ['dependabot[bot]'],
            },
          },
        }));
      });
    });
  });
});
