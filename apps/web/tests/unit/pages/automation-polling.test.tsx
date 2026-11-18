/**
 * The Automation overview keeps schedules and watches fresh on its own, at the configurable
 * cadence, and stops while the tab is hidden (rule 60). Driven through the real page and hooks.
 */
import { focusManager, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  listWorkflowRuns: vi.fn(),
  listTriggers: vi.fn(),
  listTriggerExecutions: vi.fn(),
  getProjectMembers: vi.fn(),
  listChatSessions: vi.fn(),
  listAgentProfiles: vi.fn(),
  listSkills: vi.fn(),
}));
const events = vi.hoisted(() => ({
  listSchedules: vi.fn(),
  listStandingWatches: vi.fn(),
  listEventSubscriptions: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...api,
}));
vi.mock('../../../src/lib/project-events-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...events,
}));
vi.mock('../../../src/hooks/useQueryScope', () => ({ useQueryScope: () => 'owner' }));

import { ToastProvider } from '../../../src/hooks/useToast';
import { AUTOMATION_POLL_MS, DEFAULT_AUTOMATION_POLL_MS } from '../../../src/lib/poll-intervals';
import { AutomationOverview } from '../../../src/pages/automation/AutomationOverview';
import { ProjectContext } from '../../../src/pages/ProjectContext';
import { createTestQueryClient } from '../../test-utils/query-test-utils';

function Shell() {
  const [value] = useState(() => ({
    projectId: 'p1',
    project: { id: 'p1', userId: 'owner', name: 'Project' } as never,
    installations: [],
    reload: async () => undefined,
  }));
  return (
    <ProjectContext.Provider value={value}>
      <Outlet />
    </ProjectContext.Provider>
  );
}

function renderOverview() {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/projects/p1/automation']}>
          <Routes>
            <Route path="/projects/:id" element={<Shell />}>
              <Route path="automation" element={<AutomationOverview />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  api.listWorkflowRuns.mockResolvedValue({ runs: [], nextCursor: null });
  api.listTriggers.mockResolvedValue({ triggers: [] });
  api.listTriggerExecutions.mockResolvedValue({ executions: [], nextCursor: null });
  api.getProjectMembers.mockResolvedValue({ members: [] });
  api.listChatSessions.mockResolvedValue({ sessions: [], total: 0 });
  api.listAgentProfiles.mockResolvedValue([]);
  api.listSkills.mockResolvedValue([]);
  events.listSchedules.mockResolvedValue({ schedules: [], nextCursor: null });
  events.listStandingWatches.mockResolvedValue({ watches: [], nextCursor: null });
  events.listEventSubscriptions.mockResolvedValue({ subscriptions: [], hasMore: false });
});

afterEach(() => {
  cleanup();
  focusManager.setFocused(undefined);
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('automation overview polling', () => {
  it('refreshes schedules and watches every AUTOMATION_POLL_MS while the tab is visible', async () => {
    renderOverview();
    expect(
      await screen.findByRole('heading', { name: 'Nothing runs on its own yet' })
    ).toBeInTheDocument();
    const schedulesBefore = events.listSchedules.mock.calls.length;
    const watchesBefore = events.listStandingWatches.mock.calls.length;
    expect(schedulesBefore).toBeGreaterThan(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOMATION_POLL_MS + 50);
    });
    expect(events.listSchedules.mock.calls.length).toBeGreaterThan(schedulesBefore);
    expect(events.listStandingWatches.mock.calls.length).toBeGreaterThan(watchesBefore);
  });

  it('does not poll while the tab is hidden', async () => {
    renderOverview();
    expect(
      await screen.findByRole('heading', { name: 'Nothing runs on its own yet' })
    ).toBeInTheDocument();
    focusManager.setFocused(false);
    const before = events.listSchedules.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * AUTOMATION_POLL_MS);
    });
    expect(events.listSchedules.mock.calls.length).toBe(before);
  });
});

describe('AUTOMATION_POLL_MS', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('defaults to 30 seconds and honours a VITE_AUTOMATION_POLL_MS override', async () => {
    expect(DEFAULT_AUTOMATION_POLL_MS).toBe(30_000);
    vi.stubEnv('VITE_AUTOMATION_POLL_MS', '5000');
    vi.resetModules();
    const overridden = await import('../../../src/lib/poll-intervals');
    expect(overridden.AUTOMATION_POLL_MS).toBe(5000);

    vi.stubEnv('VITE_AUTOMATION_POLL_MS', 'not-a-number');
    vi.resetModules();
    const invalid = await import('../../../src/lib/poll-intervals');
    expect(invalid.AUTOMATION_POLL_MS).toBe(30_000);
  });
});
