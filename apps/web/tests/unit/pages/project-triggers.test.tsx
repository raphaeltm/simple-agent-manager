import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '../../../src/hooks/useToast';
import { createTrigger, listAgentProfiles } from '../../../src/lib/api';
import { ProjectContext, type ProjectContextValue } from '../../../src/pages/ProjectContext';
import { ProjectTriggers } from '../../../src/pages/ProjectTriggers';

// ---------------------------------------------------------------------------
// Mocks — inline data to avoid hoisting issues with vi.mock
// ---------------------------------------------------------------------------

vi.mock('../../../src/lib/api', () => ({
  listTriggers: vi.fn().mockResolvedValue({
    triggers: [
      {
        id: 'trig-1',
        projectId: 'proj-test',
        userId: 'user-1',
        name: 'Daily Sync',
        description: 'Sync data every day',
        status: 'active',
        sourceType: 'cron',
        cronExpression: '0 0 * * *',
        cronTimezone: 'UTC',
        skipIfRunning: false,
        promptTemplate: 'Run sync',
        agentProfileId: null,
        taskMode: 'task',
        vmSizeOverride: null,
        maxConcurrent: 1,
        lastTriggeredAt: null,
        triggerCount: 0,
        nextFireAt: '2026-06-01T00:00:00Z',
        createdAt: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-01T00:00:00Z',
      },
      {
        id: 'trig-2',
        projectId: 'proj-test',
        userId: 'user-1',
        name: 'Weekly Report',
        description: 'Generate weekly report',
        status: 'active',
        sourceType: 'cron',
        cronExpression: '0 9 * * 1',
        cronTimezone: 'UTC',
        skipIfRunning: false,
        promptTemplate: 'Run report',
        agentProfileId: null,
        taskMode: 'task',
        vmSizeOverride: null,
        maxConcurrent: 1,
        lastTriggeredAt: null,
        triggerCount: 0,
        nextFireAt: '2026-06-02T09:00:00Z',
        createdAt: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-01T00:00:00Z',
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
    </MemoryRouter>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProjectTriggers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createTrigger).mockResolvedValue({} as never);
    vi.mocked(listAgentProfiles).mockResolvedValue([
      {
        id: 'profile-webhook',
        projectId: 'proj-test',
        userId: 'user-1',
        name: 'Webhook Worker',
        description: 'Runs incoming webhook tasks',
        agentType: 'opencode',
        model: 'openai/gpt-5.2',
        effort: 'auto',
        permissionMode: null,
        systemPromptAppend: null,
        maxTurns: null,
        timeoutMinutes: 30,
        vmSizeOverride: null,
        provider: null,
        vmLocation: null,
        workspaceProfile: null,
        taskMode: 'task',
        runtime: null,
        isBuiltin: false,
        createdAt: '2026-07-13T00:00:00Z',
        updatedAt: '2026-07-13T00:00:00Z',
      },
    ]);
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
      expect(screen.queryByRole('dialog', { name: /create trigger/i })).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/^name$/i)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/prompt template/i)).not.toBeInTheDocument();
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

    it('removes the form from the accessibility tree and returns focus on close', async () => {
      const user = userEvent.setup();
      renderTriggers();
      await waitFor(() => {
        expect(screen.getByText('Daily Sync')).toBeInTheDocument();
      });

      const newTriggerButton = screen.getAllByRole('button', { name: /new trigger/i })[0];
      await user.click(newTriggerButton);
      expect(await screen.findByRole('dialog', { name: /create trigger/i })).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /close/i }));

      await waitFor(() => {
        expect(screen.queryByRole('dialog', { name: /create trigger/i })).not.toBeInTheDocument();
      });
      expect(screen.queryByLabelText(/^name$/i)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/prompt template/i)).not.toBeInTheDocument();
      expect(newTriggerButton).toHaveFocus();
    });

    it('creates a GitHub event trigger from the form', async () => {
      const user = userEvent.setup();
      renderTriggers();
      await waitFor(() => {
        expect(screen.getByText('Daily Sync')).toBeInTheDocument();
      });

      const newTriggerButton = screen.getAllByRole('button', { name: /new trigger/i })[0];
      await user.click(newTriggerButton);
      await user.type(screen.getByLabelText(/^name$/i), 'SAM comment command');
      await user.click(screen.getByRole('button', { name: /github event/i }));
      await user.clear(screen.getByLabelText(/prompt template/i));
      await user.type(screen.getByLabelText(/prompt template/i), 'Handle GitHub comment');
      await user.click(screen.getByRole('button', { name: /create trigger/i }));

      await waitFor(() => {
        expect(createTrigger).toHaveBeenCalledWith(
          'proj-test',
          expect.objectContaining({
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
          })
        );
      });
    });

    it('creates a webhook trigger and presents its credential only until acknowledged', async () => {
      const user = userEvent.setup();
      vi.mocked(createTrigger).mockResolvedValueOnce({
        webhookCredential: {
          endpointUrl: 'https://api.example.test/api/webhooks/ingest',
          token: 'sam_wh_one_time_test_token',
          headerName: 'Authorization',
        },
      } as never);
      renderTriggers();
      await screen.findByText('Daily Sync');

      const newTriggerButton = screen.getAllByRole('button', { name: /new trigger/i })[0];
      await user.click(newTriggerButton);
      await user.type(screen.getByLabelText(/^name$/i), 'Deployment failures');
      await user.click(screen.getByRole('button', { name: /^webhook/i }));
      await user.selectOptions(screen.getByLabelText(/agent profile/i), 'profile-webhook');
      await user.type(screen.getByLabelText(/source label/i), 'Release system');
      await user.type(screen.getByLabelText(/included headers/i), 'x-event-type, x-request-id');
      await user.click(screen.getByRole('button', { name: /add filter/i }));
      await user.type(screen.getByLabelText(/filter 1 path/i), 'deployment.status');
      await user.selectOptions(screen.getByLabelText(/filter 1 operator/i), 'equals');
      await user.type(screen.getByLabelText(/^filter 1 value$/i), 'failed');
      await user.type(
        screen.getByLabelText(/prompt template/i),
        'Investigate the failed deployment'
      );
      await user.click(screen.getByRole('button', { name: /create trigger/i }));

      await waitFor(() =>
        expect(createTrigger).toHaveBeenCalledWith('proj-test', {
          name: 'Deployment failures',
          description: undefined,
          sourceType: 'webhook',
          cronExpression: undefined,
          cronTimezone: undefined,
          promptTemplate: 'Investigate the failed deployment',
          skipIfRunning: true,
          maxConcurrent: 1,
          vmSizeOverride: undefined,
          taskMode: 'task',
          agentProfileId: 'profile-webhook',
          githubConfig: undefined,
          webhookConfig: {
            sourceLabel: 'Release system',
            includedHeaders: ['x-event-type', 'x-request-id'],
            filterMode: 'all',
            filters: [{ path: 'deployment.status', operator: 'equals', value: 'failed' }],
          },
        })
      );

      const credentialDialog = await screen.findByRole('dialog', {
        name: /save your webhook credential/i,
      });
      expect(credentialDialog).toHaveTextContent('sam_wh_one_time_test_token');
      expect(credentialDialog).toHaveTextContent('https://api.example.test/api/webhooks/ingest');
      expect(credentialDialog).not.toHaveTextContent('\n+');
      const acknowledgment = screen.getByRole('checkbox');
      await waitFor(() => expect(acknowledgment).toHaveFocus());
      expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();

      await user.click(acknowledgment);
      await user.tab();
      expect(screen.getByRole('button', { name: 'Done' })).toHaveFocus();
      await user.tab();
      expect(screen.getByRole('button', { name: /copy endpoint/i })).toHaveFocus();
      await user.click(screen.getByRole('button', { name: 'Done' }));
      expect(
        screen.queryByRole('dialog', { name: /save your webhook credential/i })
      ).not.toBeInTheDocument();
      expect(screen.queryByText('sam_wh_one_time_test_token')).not.toBeInTheDocument();
      expect(newTriggerButton).toHaveFocus();
    }, 10_000);
  });
});
