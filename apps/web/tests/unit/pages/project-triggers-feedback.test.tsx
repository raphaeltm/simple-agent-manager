/**
 * Regression tests for the trigger action feedback gap.
 *
 * Symptom that motivated these: pressing "Resume" on a paused trigger produced
 * zero visible change for the whole request duration — no optimistic status
 * flip, no disabled state, no spinner, and the only feedback (a toast) arrived
 * ~1-2s later once the round trip finished. Repeated presses each fired their
 * own request.
 *
 * Each test below is written to FAIL against the pre-fix implementation.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '../../../src/hooks/useToast';
import { listTriggers, runTrigger, updateTrigger } from '../../../src/lib/api';
import { ProjectContext, type ProjectContextValue } from '../../../src/pages/ProjectContext';
import { ProjectTriggers } from '../../../src/pages/ProjectTriggers';

const PAUSED_TRIGGER = {
  id: 'trig-paused',
  projectId: 'proj-test',
  userId: 'user-1',
  name: 'Nightly Tests',
  description: 'Run full test suite every night',
  status: 'paused' as const,
  sourceType: 'cron' as const,
  cronExpression: '0 2 * * *',
  cronHumanReadable: 'Daily at 2:00 AM',
  cronTimezone: 'UTC',
  skipIfRunning: false,
  promptTemplate: 'Run tests',
  agentProfileId: null,
  taskMode: 'task' as const,
  vmSizeOverride: null,
  maxConcurrent: 1,
  lastTriggeredAt: null,
  triggerCount: 15,
  nextFireAt: '2026-06-01T00:00:00Z',
  createdAt: '2026-05-01T00:00:00Z',
  updatedAt: '2026-05-01T00:00:00Z',
};

vi.mock('../../../src/lib/api', () => ({
  listTriggers: vi.fn(),
  updateTrigger: vi.fn(),
  runTrigger: vi.fn(),
  deleteTrigger: vi.fn(),
  listAgentProfiles: vi.fn().mockResolvedValue({ profiles: [] }),
  listSkills: vi.fn().mockResolvedValue({ skills: [] }),
}));

const projectContextValue = {
  projectId: 'proj-test',
  project: null,
  loading: false,
  error: null,
  reload: vi.fn(),
} as unknown as ProjectContextValue;

function renderPage() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <ProjectContext.Provider value={projectContextValue}>
          <ProjectTriggers />
        </ProjectContext.Provider>
      </ToastProvider>
    </MemoryRouter>
  );
}

/** Creates a promise plus the handles to settle it, so a request can be held open. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The pause/resume toggle, located by a name that survives the optimistic flip. */
function toggleButton() {
  return screen.getByRole('button', { name: /^(Resume|Pause) trigger$/ });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listTriggers).mockResolvedValue({ triggers: [PAUSED_TRIGGER] });
});

describe('ProjectTriggers — resume/pause feedback', () => {
  it('flips status optimistically before the request resolves', async () => {
    const pending = deferred<typeof PAUSED_TRIGGER>();
    vi.mocked(updateTrigger).mockReturnValue(pending.promise as never);

    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Nightly Tests');

    expect(screen.getByLabelText('Status: Paused')).toBeInTheDocument();
    expect(toggleButton()).toHaveTextContent('Resume');

    await user.click(toggleButton());

    // Request is still in flight — this is the window that used to be dead.
    expect(updateTrigger).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Status: Active')).toBeInTheDocument();
    expect(toggleButton()).toHaveTextContent('Pause');

    pending.resolve({ ...PAUSED_TRIGGER, status: 'active' as const });
    await waitFor(() => expect(toggleButton()).toBeEnabled());
  });

  it('marks the pressed button busy and disabled while in flight', async () => {
    const pending = deferred<typeof PAUSED_TRIGGER>();
    vi.mocked(updateTrigger).mockReturnValue(pending.promise as never);

    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Nightly Tests');

    await user.click(toggleButton());

    expect(toggleButton()).toBeDisabled();
    expect(toggleButton()).toHaveAttribute('aria-busy', 'true');
    // A spinner replaces the icon so the press is visible, not just inert. It is
    // aria-hidden so it does not pollute the button's accessible name.
    const spinner = toggleButton().querySelector('[data-slot="spinner"]');
    expect(spinner).toBeTruthy();
    expect(spinner).toHaveAttribute('aria-hidden', 'true');

    pending.resolve({ ...PAUSED_TRIGGER, status: 'active' as const });
    await waitFor(() => expect(toggleButton()).toBeEnabled());
    expect(toggleButton()).not.toHaveAttribute('aria-busy');
  });

  it('rolls the status back and shows an error toast when the request fails', async () => {
    const pending = deferred<typeof PAUSED_TRIGGER>();
    vi.mocked(updateTrigger).mockReturnValue(pending.promise as never);

    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Nightly Tests');

    await user.click(toggleButton());
    expect(screen.getByLabelText('Status: Active')).toBeInTheDocument();

    pending.reject(new Error('Scheduler unavailable'));

    await waitFor(() => {
      expect(screen.getByLabelText('Status: Paused')).toBeInTheDocument();
    });
    expect(toggleButton()).toHaveTextContent('Resume');
    expect(await screen.findByText('Scheduler unavailable')).toBeInTheDocument();
  });

  it('stays silent on success — the optimistic change is the feedback', async () => {
    vi.mocked(updateTrigger).mockResolvedValue({
      ...PAUSED_TRIGGER,
      status: 'active' as const,
    } as never);

    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Nightly Tests');

    await user.click(toggleButton());
    await waitFor(() => expect(toggleButton()).toBeEnabled());

    expect(screen.queryByTestId('toast-success')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Status: Active')).toBeInTheDocument();
  });

  it('shows the action the press performs, not the current state', async () => {
    renderPage();
    await screen.findByText('Nightly Tests');

    // Pre-fix this rendered a Pause icon next to the word "Resume".
    const toggle = toggleButton();
    expect(toggle).toHaveTextContent('Resume');
    expect(toggle.querySelector('.lucide-play')).toBeTruthy();
    expect(toggle.querySelector('.lucide-pause')).toBeFalsy();
  });
});

describe('ProjectTriggers — re-entrancy guard', () => {
  it('ignores repeated presses of Run Now while a run is in flight', async () => {
    const pending = deferred<{ executionId: string; taskId: string }>();
    vi.mocked(runTrigger).mockReturnValue(pending.promise as never);

    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Nightly Tests');

    const runBtn = screen.getByRole('button', { name: 'Run trigger now' });
    await user.click(runBtn);

    // Each of these used to spawn a real agent task.
    await user.click(runBtn, { pointerEventsCheck: 0 });
    await user.click(runBtn, { pointerEventsCheck: 0 });

    expect(runTrigger).toHaveBeenCalledTimes(1);

    pending.resolve({ executionId: 'exec-1', taskId: 'task-1' });
    await waitFor(() => expect(runBtn).toBeEnabled());
  });

  it('locks sibling actions on the same trigger while one is in flight', async () => {
    const pending = deferred<typeof PAUSED_TRIGGER>();
    vi.mocked(updateTrigger).mockReturnValue(pending.promise as never);

    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Nightly Tests');

    await user.click(toggleButton());

    expect(screen.getByRole('button', { name: 'Run trigger now' })).toBeDisabled();

    pending.resolve({ ...PAUSED_TRIGGER, status: 'active' as const });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Run trigger now' })).toBeEnabled()
    );
  });
});
