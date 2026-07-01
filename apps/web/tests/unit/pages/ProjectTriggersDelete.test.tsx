import type { TriggerResponse } from '@simple-agent-manager/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  listTriggers: vi.fn(),
  deleteTrigger: vi.fn(),
  runTrigger: vi.fn(),
  updateTrigger: vi.fn(),
  navigate: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  projectId: 'proj-1',
}));

vi.mock('../../../src/lib/api/triggers', () => ({
  listTriggers: mocks.listTriggers,
  deleteTrigger: mocks.deleteTrigger,
  runTrigger: mocks.runTrigger,
  updateTrigger: mocks.updateTrigger,
}));

vi.mock('../../../src/lib/api', () => ({
  listTriggers: mocks.listTriggers,
  deleteTrigger: mocks.deleteTrigger,
  runTrigger: mocks.runTrigger,
  updateTrigger: mocks.updateTrigger,
}));

vi.mock('react-router', async () => {
  const actual = await vi.importActual('react-router');
  return { ...actual, useNavigate: () => mocks.navigate };
});

vi.mock('../../../src/hooks/useToast', () => ({
  useToast: () => mocks.toast,
}));

vi.mock('../../../src/pages/ProjectContext', () => ({
  useProjectContext: () => ({ projectId: mocks.projectId }),
}));

vi.mock('../../../src/components/triggers/TriggerForm', () => ({
  TriggerForm: () => null,
}));

import { ProjectTriggers } from '../../../src/pages/ProjectTriggers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTrigger(overrides: Partial<TriggerResponse> & { id: string; name: string }): TriggerResponse {
  return {
    projectId: 'proj-1',
    userId: 'user-1',
    description: null,
    status: 'active',
    sourceType: 'cron',
    cronExpression: '0 9 * * *',
    cronTimezone: 'UTC',
    cronHumanReadable: 'Every day at 9:00 AM',
    skipIfRunning: true,
    promptTemplate: 'Do something',
    agentProfileId: null,
    taskMode: 'task',
    vmSizeOverride: null,
    maxConcurrent: 1,
    nextFireAt: new Date(Date.now() + 3600_000).toISOString(),
    lastTriggeredAt: null,
    triggerCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const TRIGGERS = [
  makeTrigger({ id: 't-1', name: 'Daily Backup' }),
  makeTrigger({ id: 't-2', name: 'Weekly Report', status: 'paused' }),
];

function renderPage() {
  return render(
    <MemoryRouter>
      <ProjectTriggers />
    </MemoryRouter>,
  );
}

async function openDeleteMenu(user: ReturnType<typeof userEvent.setup>) {
  // Wait for triggers to load
  await screen.findByText('Daily Backup');

  // Open the first card's overflow menu
  const menuBtns = screen.getAllByRole('button', { name: 'Trigger actions' });
  await user.click(menuBtns[0]);

  // Click Delete
  const deleteBtn = screen.getByRole('button', { name: /delete/i });
  await user.click(deleteBtn);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProjectTriggers — Delete flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listTriggers.mockResolvedValue({ triggers: TRIGGERS });
    mocks.deleteTrigger.mockResolvedValue(undefined);
  });

  it('opens confirmation dialog when Delete is clicked from the overflow menu', async () => {
    const user = userEvent.setup();
    renderPage();

    await openDeleteMenu(user);

    // Confirm dialog appears
    expect(screen.getByRole('alertdialog', { name: 'Confirm delete' })).toBeInTheDocument();
    expect(screen.getByText(/permanently delete/i)).toBeInTheDocument();
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent(/Daily Backup/);
  });

  it('closes the dialog and does nothing when Cancel is clicked', async () => {
    const user = userEvent.setup();
    renderPage();

    await openDeleteMenu(user);

    // Click Cancel
    const cancelBtn = screen.getByRole('button', { name: 'Cancel' });
    await user.click(cancelBtn);

    // Dialog gone
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    // deleteTrigger never called
    expect(mocks.deleteTrigger).not.toHaveBeenCalled();
  });

  it('closes the dialog on backdrop click without deleting', async () => {
    const user = userEvent.setup();
    renderPage();

    await openDeleteMenu(user);

    // Click the backdrop (aria-hidden div)
    const backdrop = document.querySelector('.glass-backdrop-dim');
    expect(backdrop).toBeTruthy();
    await user.click(backdrop!);

    // Dialog gone
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    expect(mocks.deleteTrigger).not.toHaveBeenCalled();
  });

  it('calls deleteTrigger and shows success toast when confirmed', async () => {
    const user = userEvent.setup();
    renderPage();

    await openDeleteMenu(user);

    // Click the Delete confirmation button
    const confirmBtn = screen.getByRole('button', { name: 'Delete' });
    await user.click(confirmBtn);

    // Dialog closes
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    // API called
    expect(mocks.deleteTrigger).toHaveBeenCalledWith('proj-1', 't-1');
    expect(mocks.deleteTrigger).toHaveBeenCalledTimes(1);

    // Success toast
    expect(mocks.toast.success).toHaveBeenCalledWith('"Daily Backup" deleted');

    // Triggers are refreshed
    expect(mocks.listTriggers).toHaveBeenCalledTimes(2); // initial + refresh
  });

  it('shows error toast when deletion fails', async () => {
    mocks.deleteTrigger.mockRejectedValueOnce(new Error('Not authorized'));
    const user = userEvent.setup();
    renderPage();

    await openDeleteMenu(user);

    const confirmBtn = screen.getByRole('button', { name: 'Delete' });
    await user.click(confirmBtn);

    await waitFor(() => {
      expect(mocks.toast.error).toHaveBeenCalledWith('Not authorized');
    });
  });

  it('refreshes via loadTriggers (not page reload) after deletion', async () => {
    const user = userEvent.setup();
    renderPage();

    await openDeleteMenu(user);

    const confirmBtn = screen.getByRole('button', { name: 'Delete' });
    await user.click(confirmBtn);

    await waitFor(() => {
      expect(mocks.deleteTrigger).toHaveBeenCalled();
    });

    // listTriggers called again (initial load + refresh after delete)
    expect(mocks.listTriggers).toHaveBeenCalledTimes(2);
  });
});
