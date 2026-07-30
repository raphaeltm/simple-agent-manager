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
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    await waitFor(() => expect(toggleButton()).not.toHaveAttribute('aria-busy'));
  });

  it('marks the pressed button busy and disabled while in flight', async () => {
    const pending = deferred<typeof PAUSED_TRIGGER>();
    vi.mocked(updateTrigger).mockReturnValue(pending.promise as never);

    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Nightly Tests');

    await user.click(toggleButton());

    // aria-disabled, not native disabled — see the focus test below.
    expect(toggleButton()).toHaveAttribute('aria-disabled', 'true');
    expect(toggleButton()).toHaveAttribute('aria-busy', 'true');
    // A spinner replaces the icon so the press is visible, not just inert. It is
    // aria-hidden so it does not pollute the button's accessible name.
    const spinner = toggleButton().querySelector('[data-slot="spinner"]');
    expect(spinner).toBeTruthy();
    expect(spinner).toHaveAttribute('aria-hidden', 'true');

    pending.resolve({ ...PAUSED_TRIGGER, status: 'active' as const });
    await waitFor(() => expect(toggleButton()).not.toHaveAttribute('aria-busy'));
  });

  it('keeps keyboard focus on the pressed button while it is busy', async () => {
    // Native `disabled` on a focused element blurs it to <body> and never
    // restores it, so a keyboard user would lose their place on every press.
    // The busy button must be aria-disabled, not natively disabled.
    const pending = deferred<typeof PAUSED_TRIGGER>();
    vi.mocked(updateTrigger).mockReturnValue(pending.promise as never);

    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Nightly Tests');

    const toggle = toggleButton();
    toggle.focus();
    expect(toggle).toHaveFocus();

    await user.click(toggle);

    expect(toggleButton()).toHaveAttribute('aria-disabled', 'true');
    expect(toggleButton()).not.toHaveAttribute('disabled');
    expect(toggleButton()).toHaveFocus();
    expect(document.body).not.toHaveFocus();

    pending.resolve({ ...PAUSED_TRIGGER, status: 'active' as const });
    await waitFor(() => expect(toggleButton()).not.toHaveAttribute('aria-disabled'));
    expect(toggleButton()).toHaveFocus();
  });

  it('still natively disables the sibling actions of a busy one', async () => {
    // Siblings are genuinely unavailable rather than busy, and none of them
    // holds focus, so the native attribute is the correct mechanism there.
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
    await waitFor(() => expect(toggleButton()).not.toHaveAttribute('aria-busy'));

    expect(screen.queryByTestId('toast-success')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Status: Active')).toBeInTheDocument();
  });

  it('announces the change to assistive tech even though no toast is shown', async () => {
    // Dropping the success toast removed the app's only live region for this
    // action. A status dot's aria-label is static and aria-busy is not
    // reliably announced, so without an explicit live region a VoiceOver user
    // would be worse off after this fix than before it.
    const pending = deferred<typeof PAUSED_TRIGGER>();
    vi.mocked(updateTrigger).mockReturnValue(pending.promise as never);

    const user = userEvent.setup();
    const { container } = renderPage();
    await screen.findByText('Nightly Tests');

    const liveRegion = container.querySelector('[aria-live="polite"].sr-only');
    expect(liveRegion).toBeTruthy();
    expect(liveRegion).toHaveTextContent('');

    await user.click(toggleButton());
    expect(liveRegion).toHaveTextContent('Resuming "Nightly Tests"');

    pending.resolve({ ...PAUSED_TRIGGER, status: 'active' as const });
    await waitFor(() => expect(liveRegion).toHaveTextContent('"Nightly Tests" resumed'));
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

    renderPage();
    await screen.findByText('Nightly Tests');

    const runBtn = screen.getByRole('button', { name: 'Run trigger now' });

    // Three rapid presses used to spawn three real agent tasks. This asserts
    // the end-to-end guarantee only; it does NOT isolate the ref-based guard,
    // because RTL wraps fireEvent in act(), so React re-renders and applies
    // `disabled` between clicks and the handler is never re-entered. The guard
    // itself is covered discriminatingly in tests/unit/hooks/use-trigger-actions.test.tsx,
    // which calls the actions twice inside one tick.
    fireEvent.click(runBtn);
    fireEvent.click(runBtn);
    fireEvent.click(runBtn);

    expect(runTrigger).toHaveBeenCalledTimes(1);

    pending.resolve({ executionId: 'exec-1', taskId: 'task-1' });
    await waitFor(() => expect(runBtn).not.toHaveAttribute('aria-busy'));
  });

  it('re-reads the list after a run so "Last triggered" is not stale', async () => {
    // The server bumps lastTriggeredAt/triggerCount before responding, and the
    // card renders them. Without a refresh the row still reads "Last: 3 days
    // ago" after a successful run — the same "nothing happened" symptom.
    vi.mocked(runTrigger).mockResolvedValue({
      executionId: 'exec-1',
      taskId: 'task-1',
    } as never);

    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Nightly Tests');
    expect(listTriggers).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Run trigger now' }));

    await waitFor(() => expect(listTriggers).toHaveBeenCalledTimes(2));
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
