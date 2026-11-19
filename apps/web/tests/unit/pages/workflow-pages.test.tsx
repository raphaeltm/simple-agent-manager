/**
 * The Workflows pages driven the way a person uses them: the real routes, real clicks and the
 * real overview, with the API mocked at `lib/api`. Assertions check what reached the API and
 * where the app navigated, not only what rendered.
 */
import type {
  WorkflowRunDetail,
  WorkflowRunSummary,
  WorkflowStepDetail,
} from '@simple-agent-manager/shared';
import { focusManager, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter, Outlet, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  listWorkflowRuns: vi.fn(),
  getWorkflowRun: vi.fn(),
  getProjectMembers: vi.fn(),
  listTriggers: vi.fn(),
  listTriggerExecutions: vi.fn(),
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
import { ApiClientError } from '../../../src/lib/api/client';
import { AUTOMATION_POLL_MS, WORKFLOW_RUN_POLL_MS } from '../../../src/lib/poll-intervals';
import { AutomationOverview } from '../../../src/pages/automation/AutomationOverview';
import { WorkflowRunPage } from '../../../src/pages/automation/workflows/WorkflowRunPage';
import { WorkflowRuns } from '../../../src/pages/automation/workflows/WorkflowRuns';
import { ProjectContext } from '../../../src/pages/ProjectContext';
import { createTestQueryClient } from '../../test-utils/query-test-utils';

const NOW = Date.now();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (offset: number) => new Date(NOW + offset).toISOString();

function step(
  overrides: Partial<WorkflowStepDetail> & Pick<WorkflowStepDetail, 'key'>
): WorkflowStepDetail {
  return {
    title: overrides.key,
    kind: 'agent',
    status: 'waiting',
    reason: null,
    ordinal: 0,
    after: [],
    instructions: `Do ${overrides.key}`,
    agent: { profileId: 'prof', profileName: 'Writer', agentType: 'claude-code', model: null },
    attemptId: `att-${overrides.key}`,
    taskId: null,
    sessionId: null,
    taskStatus: null,
    launchAttempts: 0,
    startedAt: null,
    finishedAt: null,
    updatedAt: iso(-HOUR),
    output: null,
    wait: null,
    ...overrides,
  };
}

function run(
  overrides: Partial<WorkflowRunDetail> & Pick<WorkflowRunDetail, 'id'>
): WorkflowRunDetail {
  return {
    title: `Run ${overrides.id}`,
    goal: 'Get it done',
    status: 'active',
    startedByUserId: 'owner',
    createdAt: iso(-2 * HOUR),
    updatedAt: iso(-HOUR),
    deadlineAt: iso(DAY),
    startedFrom: { taskId: 'task-root', sessionId: 'chat-root', title: 'Plan it' },
    maxParallelSteps: 2,
    steps: [],
    activity: [],
    ...overrides,
  };
}

const summary = (detail: WorkflowRunDetail): WorkflowRunSummary => ({
  id: detail.id,
  title: detail.title,
  status: detail.status,
  startedByUserId: detail.startedByUserId,
  createdAt: detail.createdAt,
  updatedAt: detail.updatedAt,
  deadlineAt: detail.deadlineAt,
  steps: detail.steps.map(({ key, title, kind, status, reason }) => ({
    key,
    title,
    kind,
    status,
    reason,
  })),
});

const FAILED = run({
  id: 'run-flaky',
  title: 'Fix the flaky test',
  status: 'needs_attention',
  updatedAt: iso(-HOUR),
  steps: [
    step({
      key: 'find',
      title: 'Find the cause',
      status: 'completed',
      ordinal: 0,
      taskId: 't-find',
      sessionId: 'chat-find',
      taskStatus: 'completed',
      output: {
        summary: 'The upload races the mock.',
        branch: 'sam/flaky',
        prUrl: null,
        evidence: null,
        handoffs: [
          { id: 'h1', artifactRefs: [{ type: 'library_file', ref: '01M5H0Z9X1Y2Z3A4B5C6D7E8F9' }] },
        ],
      },
    }),
    step({
      key: 'fix',
      title: 'Fix it',
      status: 'failed',
      ordinal: 1,
      after: ['find'],
      reason: 'Agent process exited with code 1',
      taskId: 't-fix',
      sessionId: 'chat-fix',
      taskStatus: 'failed',
    }),
    step({
      key: 'ship',
      title: 'Ship it',
      status: 'blocked',
      ordinal: 2,
      after: ['fix'],
      reason: 'Blocked: fix did not succeed',
    }),
  ],
});
const ACTIVE = run({
  id: 'run-active',
  title: 'Write the notes',
  createdAt: iso(-HOUR),
  steps: [
    step({
      key: 'draft',
      title: 'Draft',
      status: 'running',
      taskId: 't-draft',
      sessionId: 'chat-draft',
      taskStatus: 'in_progress',
    }),
    step({ key: 'review', title: 'Review', ordinal: 1, after: ['draft'] }),
  ],
});
const OLD_FAILURE = run({
  id: 'run-old',
  title: 'Old failure',
  status: 'needs_attention',
  createdAt: iso(-6 * DAY),
  updatedAt: iso(-5 * DAY),
  steps: [step({ key: 'x', title: 'X', status: 'failed', reason: 'Gone' })],
});
const DONE = run({
  id: 'run-done',
  title: 'Weekly review',
  status: 'completed',
  createdAt: iso(-3 * DAY),
  steps: [step({ key: 'a', title: 'A', status: 'completed' })],
});

let runs: WorkflowRunDetail[] = [];
let pageSize = 20;

function serveList() {
  api.listWorkflowRuns.mockImplementation(
    async (
      _projectId: string,
      options: { status?: string | null; cursor?: string | null; limit?: number }
    ) => {
      const limit = options.limit ?? pageSize;
      const start = Number(options.cursor ?? 0) || 0;
      const matching = runs
        .filter((r) => !options.status || r.status === options.status)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return {
        runs: matching.slice(start, start + limit).map(summary),
        nextCursor: start + limit < matching.length ? String(start + limit) : null,
      };
    }
  );
  api.getWorkflowRun.mockImplementation(async (_projectId: string, runId: string) => {
    const found = runs.find((r) => r.id === runId);
    if (!found) throw new ApiClientError('NOT_FOUND', 'Workflow run not found', 404);
    return { run: found };
  });
}

function Where() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

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
      <Where />
    </ProjectContext.Provider>
  );
}

function renderAt(path: string) {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/projects/:id" element={<Shell />}>
              <Route path="automation" element={<AutomationOverview />} />
              <Route path="automation/workflows" element={<WorkflowRuns />} />
              <Route path="automation/workflows/:runId" element={<WorkflowRunPage />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}

const location = () => screen.getByTestId('location').textContent;

/** Make the run page lay out as on a wide screen (side column), or as on a phone. */
function wideScreen(wide: boolean) {
  vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
    matches: wide && query.includes('min-width: 1024px'),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

beforeEach(() => {
  runs = [FAILED, ACTIVE, DONE];
  pageSize = 20;
  serveList();
  wideScreen(false);
  api.getProjectMembers.mockResolvedValue({
    members: [
      {
        projectId: 'p1',
        userId: 'owner',
        role: 'owner',
        status: 'active',
        user: { id: 'owner', name: 'Owner' },
      },
    ],
  });
  api.listTriggers.mockResolvedValue({ triggers: [] });
  api.listTriggerExecutions.mockResolvedValue({ executions: [], nextCursor: null });
  api.listChatSessions.mockResolvedValue({ sessions: [], total: 0 });
  api.listAgentProfiles.mockResolvedValue([]);
  api.listSkills.mockResolvedValue([]);
  events.listSchedules.mockResolvedValue({ schedules: [], nextCursor: null });
  events.listStandingWatches.mockResolvedValue({ watches: [], nextCursor: null });
  events.listEventSubscriptions.mockResolvedValue({ subscriptions: [], hasMore: false });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('Workflows list', () => {
  it('groups runs problems first and opens a run', async () => {
    renderAt('/projects/p1/automation/workflows');
    const rows = await screen.findAllByTestId('workflow-run-row');
    expect(rows.map((row) => within(row).getAllByText(/.+/)[0]?.textContent)).toEqual([
      'Fix the flaky test',
      'Write the notes',
      'Weekly review',
    ]);
    expect(
      within(rows[0]!).getByText('“Fix it” failed · 1 step did not start')
    ).toBeInTheDocument();
    expect(within(rows[0]!).getByText(/Started by you/)).toBeInTheDocument();
    await userEvent.click(rows[0]!);
    expect(location()).toBe('/projects/p1/automation/workflows/run-flaky');
  });

  it('asks the API for one status when a chip is chosen, and keeps it in the URL', async () => {
    renderAt('/projects/p1/automation/workflows');
    await screen.findAllByTestId('workflow-run-row');
    await userEvent.click(screen.getByRole('radio', { name: 'Done' }));
    await waitFor(() =>
      expect(api.listWorkflowRuns).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ status: 'completed' })
      )
    );
    expect(location()).toBe('/projects/p1/automation/workflows?status=completed');
    expect(await screen.findAllByTestId('workflow-run-row')).toHaveLength(1);
  });

  it('pages older runs in with the cursor the API returned', async () => {
    runs = Array.from({ length: 23 }, (_, i) =>
      run({ id: `r${i}`, title: `Run number ${i}`, createdAt: iso(-i * HOUR) })
    );
    renderAt('/projects/p1/automation/workflows');
    expect(await screen.findAllByTestId('workflow-run-row')).toHaveLength(20);
    await userEvent.click(screen.getByRole('button', { name: 'Show older workflows' }));
    await waitFor(() => expect(screen.getAllByTestId('workflow-run-row')).toHaveLength(23));
    expect(api.listWorkflowRuns).toHaveBeenLastCalledWith(
      'p1',
      expect.objectContaining({ cursor: '20' })
    );
    expect(screen.queryByRole('button', { name: 'Show older workflows' })).not.toBeInTheDocument();
  });

  it('explains how to start a workflow when there is none, and offers no create button', async () => {
    runs = [];
    renderAt('/projects/p1/automation/workflows');
    expect(await screen.findByRole('heading', { name: 'No workflows yet' })).toBeInTheDocument();
    expect(screen.getByText(/Plan this as a workflow/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('Workflow run page on a phone', () => {
  it('opens a step in place of the list, with its inputs and chat, and goes back with All steps', async () => {
    renderAt('/projects/p1/automation/workflows/run-flaky');
    const cards = await screen.findAllByTestId('workflow-step-card');
    await userEvent.click(cards.find((card) => card.dataset.step === 'fix')!);
    expect(location()).toBe('/projects/p1/automation/workflows/run-flaky?step=fix');
    const detail = await screen.findByTestId('workflow-step-detail');
    expect(screen.queryByTestId('workflow-steps')).not.toBeInTheDocument();
    expect(within(detail).getByTestId('workflow-step-explanation')).toHaveTextContent(
      'Agent process exited with code 1'
    );
    // What it received from "Find the cause", including the Library file it published.
    expect(within(detail).getByText('The upload races the mock.')).toBeInTheDocument();
    expect(within(detail).getByRole('link', { name: /Library file/ })).toHaveAttribute(
      'href',
      '/projects/p1/library?preview=01M5H0Z9X1Y2Z3A4B5C6D7E8F9'
    );
    expect(within(detail).getByRole('link', { name: 'Open the chat' })).toHaveAttribute(
      'href',
      '/projects/p1/chat/chat-fix'
    );
    await userEvent.click(screen.getByRole('button', { name: 'All steps' }));
    await waitFor(() => expect(location()).toBe('/projects/p1/automation/workflows/run-flaky'));
    expect(screen.getByTestId('workflow-steps')).toBeInTheDocument();
  });

  it('returns to the list from a step reached through another step', async () => {
    renderAt('/projects/p1/automation/workflows/run-flaky');
    const cards = await screen.findAllByTestId('workflow-step-card');
    await userEvent.click(cards.find((card) => card.dataset.step === 'ship')!);
    expect(location()).toBe('/projects/p1/automation/workflows/run-flaky?step=ship');
    await userEvent.click(await screen.findByRole('button', { name: 'See the step that failed' }));
    expect(location()).toBe('/projects/p1/automation/workflows/run-flaky?step=fix');
    // One step back is the list, not the step this one was opened from.
    await userEvent.click(screen.getByRole('button', { name: 'All steps' }));
    await waitFor(() => expect(location()).toBe('/projects/p1/automation/workflows/run-flaky'));
    expect(screen.getByTestId('workflow-steps')).toBeInTheDocument();
  });

  it('leaves a deep-linked step for the list without leaving the run', async () => {
    renderAt('/projects/p1/automation/workflows/run-flaky?step=ship');
    expect(await screen.findByTestId('workflow-step-explanation')).toHaveTextContent(
      'Did not start because “Fix it” did not succeed.'
    );
    await userEvent.click(screen.getByRole('button', { name: 'See the step that failed' }));
    expect(location()).toBe('/projects/p1/automation/workflows/run-flaky?step=fix');
    await userEvent.click(screen.getByRole('button', { name: 'All steps' }));
    await waitFor(() => expect(location()).toBe('/projects/p1/automation/workflows/run-flaky'));
    expect(screen.getByTestId('workflow-steps')).toBeInTheDocument();
  });

  it('shows the failure honestly and only offers real next steps', async () => {
    renderAt('/projects/p1/automation/workflows/run-flaky');
    const callout = await screen.findByTestId('workflow-attention');
    expect(callout).toHaveTextContent('“Fix it” failed: Agent process exited with code 1');
    expect(callout).toHaveTextContent('1 step did not start');
    expect(
      within(callout).getByRole('link', { name: 'Open the chat that started it' })
    ).toHaveAttribute('href', '/projects/p1/chat/chat-root');
    expect(
      screen.queryByRole('button', { name: /retry|cancel|pause|skip/i })
    ).not.toBeInTheDocument();
    await userEvent.click(within(callout).getByRole('button', { name: 'See the failed step' }));
    expect(location()).toBe('/projects/p1/automation/workflows/run-flaky?step=fix');
  });

  it('tells a missing run from a failed read', async () => {
    renderAt('/projects/p1/automation/workflows/run-gone');
    expect(await screen.findByText('This workflow run is not here')).toBeInTheDocument();
    cleanup();
    api.getWorkflowRun.mockRejectedValue(new ApiClientError('INTERNAL_ERROR', 'D1 timed out', 500));
    renderAt('/projects/p1/automation/workflows/run-flaky');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load this workflow. D1 timed out'
    );
  });
  it('moves between views with Home, End and the arrow keys, one tab stop at a time', async () => {
    renderAt('/projects/p1/automation/workflows/run-active');
    const steps = await screen.findByRole('tab', { name: 'Steps' });
    expect(steps).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', steps.id);
    steps.focus();
    await userEvent.keyboard('{End}');
    const activity = screen.getByRole('tab', { name: 'Activity' });
    expect(activity).toHaveAttribute('aria-selected', 'true');
    expect(activity).toHaveFocus();
    expect(activity).toHaveAttribute('aria-controls', screen.getByRole('tabpanel').id);
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', activity.id);
    expect(activity).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'Steps' })).toHaveAttribute('tabindex', '-1');
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Steps' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Steps' })).toHaveFocus();
  });
});

describe('Workflow run page on a wide screen', () => {
  it('opens on the graph with the run details beside it, and shows a step there', async () => {
    wideScreen(true);
    renderAt('/projects/p1/automation/workflows/run-flaky');
    expect(await screen.findByRole('tab', { name: 'Graph' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(await screen.findByTestId('workflow-run-about')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Steps' }));
    await userEvent.click(screen.getByRole('button', { name: /Find the cause/ }));
    expect(location()).toBe('/projects/p1/automation/workflows/run-flaky?view=steps&step=find');
    // The steps stay; the step opens beside them instead of the run's details.
    expect(screen.getByTestId('workflow-steps')).toBeInTheDocument();
    expect(await screen.findByTestId('workflow-step-detail')).toBeInTheDocument();
    expect(screen.queryByTestId('workflow-run-about')).not.toBeInTheDocument();
  });
});

describe('refreshing', () => {
  it('polls a running workflow and leaves a finished one alone', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderAt('/projects/p1/automation/workflows/run-active');
    await screen.findByTestId('workflow-run');
    expect(api.getWorkflowRun).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKFLOW_RUN_POLL_MS + 50);
    });
    expect(api.getWorkflowRun).toHaveBeenCalledTimes(2);
    cleanup();
    api.getWorkflowRun.mockClear();
    renderAt('/projects/p1/automation/workflows/run-done');
    await screen.findByTestId('workflow-run');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKFLOW_RUN_POLL_MS * 3);
    });
    expect(api.getWorkflowRun).toHaveBeenCalledTimes(1);
  });

  it('pauses while the tab is hidden, on the run page and the list', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderAt('/projects/p1/automation/workflows/run-active');
    await screen.findByTestId('workflow-run');
    focusManager.setFocused(false);
    let listCalls = 0;
    try {
      const runCalls = api.getWorkflowRun.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WORKFLOW_RUN_POLL_MS * 3);
      });
      expect(api.getWorkflowRun.mock.calls.length).toBe(runCalls);

      cleanup();
      renderAt('/projects/p1/automation/workflows');
      await screen.findAllByTestId('workflow-run-row');
      listCalls = api.listWorkflowRuns.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(AUTOMATION_POLL_MS * 3);
      });
      expect(api.listWorkflowRuns.mock.calls.length).toBe(listCalls);
    } finally {
      focusManager.setFocused(undefined);
    }
    // Back in front, the list with a running workflow refreshes again: the pause came from the
    // hidden tab, not from a query that stopped for good.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOMATION_POLL_MS + 50);
    });
    expect(api.listWorkflowRuns.mock.calls.length).toBeGreaterThan(listCalls);
  });
});

describe('Automation overview', () => {
  it('adds recent workflow failures to Needs your attention, but not old ones', async () => {
    runs = [FAILED, ACTIVE, OLD_FAILURE];
    renderAt('/projects/p1/automation');
    const attention = await screen.findByTestId('automation-attention');
    const panels = await within(attention).findAllByTestId('workflow-attention-panel');
    expect(panels).toHaveLength(1);
    expect(panels[0]).toHaveTextContent('“Fix it” failed · 1 step did not start');
    expect(within(panels[0]!).getByRole('link', { name: 'See what went wrong' })).toHaveAttribute(
      'href',
      '/projects/p1/automation/workflows/run-flaky?step=fix'
    );
    // The old failure is still listed with the other runs, just not as a fresh problem.
    const panel = screen.getByTestId('automation-workflows');
    expect(within(panel).getAllByTestId('workflow-run-row')).toHaveLength(3);
    expect(within(panel).getByRole('link', { name: 'All' })).toHaveAttribute(
      'href',
      '/projects/p1/automation/workflows'
    );
  });

  it('links to the rest when more runs need attention than it reads', async () => {
    runs = Array.from({ length: 7 }, (_, i) =>
      run({
        id: `f${i}`,
        title: `Failure ${i}`,
        status: 'needs_attention',
        createdAt: iso(-i * HOUR),
        updatedAt: iso(-i * HOUR),
        steps: [step({ key: 'a', status: 'failed', reason: 'x' })],
      })
    );
    renderAt('/projects/p1/automation');
    const attention = await screen.findByTestId('automation-attention');
    await waitFor(() =>
      expect(within(attention).getAllByTestId('workflow-attention-panel')).toHaveLength(5)
    );
    expect(
      within(attention).getByRole('link', { name: /More workflows need attention/ })
    ).toHaveAttribute('href', '/projects/p1/automation/workflows?status=needs_attention');
  });

  it('shows where workflows live in a project with nothing yet', async () => {
    runs = [];
    renderAt('/projects/p1/automation');
    const panel = await screen.findByTestId('automation-workflows');
    expect(await within(panel).findByRole('link', { name: /No workflows yet/ })).toHaveAttribute(
      'href',
      '/projects/p1/automation/workflows'
    );
    expect(screen.queryByTestId('automation-attention')).not.toBeInTheDocument();
  });
});
