import type { TriggerResponse } from '@simple-agent-manager/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TriggerForm } from '../../../src/components/triggers/TriggerForm';
import { ToastProvider } from '../../../src/hooks/useToast';
import { ProjectContext, type ProjectContextValue } from '../../../src/pages/ProjectContext';

vi.mock('../../../src/lib/api', () => ({
  createTrigger: vi.fn().mockResolvedValue({}),
  updateTrigger: vi.fn().mockResolvedValue({}),
  listAgentProfiles: vi.fn().mockResolvedValue({ items: [] }),
  listSkills: vi.fn().mockResolvedValue({ items: [] }),
}));


// `useQueryScope()` reads the authenticated identity, and every migrated query
// is keyed by it. Without a provider `useAuth` throws, so supply a stable identity.
vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'user@example.com', name: 'Test User' } }),
}));

import { updateTrigger } from '../../../src/lib/api';
import { QueryTestWrapper } from '../../test-utils/query-test-utils';

function makeTrigger(overrides: Partial<TriggerResponse> = {}): TriggerResponse {
  return {
    id: 'trig-1',
    projectId: 'proj-1',
    userId: 'user-1',
    name: 'Nightly Tests',
    description: 'Runs at half past two',
    status: 'active',
    sourceType: 'cron',
    // 02:30 — deliberately NOT the 09:00 default a fresh form starts from.
    cronExpression: '30 2 * * *',
    cronTimezone: 'UTC',
    cronHumanReadable: 'At 2:30 AM',
    skipIfRunning: true,
    promptTemplate: 'Run the tests',
    agentProfileId: null,
    taskMode: 'task',
    vmSizeOverride: null,
    maxConcurrent: 1,
    nextFireAt: null,
    lastTriggeredAt: null,
    triggerCount: 0,
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
    ...overrides,
  } as TriggerResponse;
}

const PROJECT_CONTEXT: ProjectContextValue = {
  projectId: 'proj-1',
  project: null,
  installations: [],
  reload: vi.fn().mockResolvedValue(undefined),
};

function renderForm(editTrigger: TriggerResponse | null) {
  return render(
    <ProjectContext.Provider value={PROJECT_CONTEXT}>
      <ToastProvider>
        <TriggerForm open onClose={vi.fn()} editTrigger={editTrigger} onSaved={vi.fn()} />
      </ToastProvider>
    </ProjectContext.Provider>
  , { wrapper: QueryTestWrapper });
}

/**
 * Regression coverage for the schedule the edit drawer displays.
 *
 * `SchedulePicker` seeded its internal state from `value` once at mount and
 * never reconciled. `TriggerForm` renders before its reset effect runs, so the
 * picker mounted against the previous/default cron: opening "edit" on a 02:30
 * trigger showed "Daily at 9:00 AM", and touching ANY schedule control emitted
 * that fabricated cron back — silently rescheduling the user's trigger.
 *
 * These assert the user-visible contract, so they fail if the reconciliation is
 * removed regardless of how it is implemented.
 */
describe('TriggerForm — schedule shown when editing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the trigger’s real schedule, not the new-trigger default', async () => {
    renderForm(makeTrigger());

    await waitFor(() => {
      expect(screen.getByText('Daily at 2:30 AM')).toBeInTheDocument();
    });
    expect(screen.queryByText('Daily at 9:00 AM')).not.toBeInTheDocument();
  });

  it('preserves the hour and minute when the user switches schedule mode', async () => {
    const user = userEvent.setup();
    renderForm(makeTrigger());

    await waitFor(() => {
      expect(screen.getByText('Daily at 2:30 AM')).toBeInTheDocument();
    });

    // Switching to Weekly must carry 02:30 across, not reset to 09:00.
    await user.click(screen.getByRole('tab', { name: 'Weekly' }));

    await waitFor(() => {
      expect(screen.getByText(/at 2:30 AM/)).toBeInTheDocument();
    });
  });

  it('submits the unchanged schedule when the picker is never touched', async () => {
    const user = userEvent.setup();
    renderForm(makeTrigger());

    await waitFor(() => {
      expect(screen.getByText('Daily at 2:30 AM')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /save|update/i }));

    await waitFor(() => {
      expect(updateTrigger).toHaveBeenCalled();
    });
    const payload = vi.mocked(updateTrigger).mock.calls[0]?.[2];
    expect(payload).toMatchObject({ cronExpression: '30 2 * * *' });
  });

  it('shows the default schedule for a brand-new trigger', async () => {
    renderForm(null);

    await waitFor(() => {
      expect(screen.getByText('Daily at 9:00 AM')).toBeInTheDocument();
    });
  });
});
