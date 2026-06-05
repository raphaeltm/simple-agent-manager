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
  navigate: vi.fn(),
}));

vi.mock('../../../src/lib/api/triggers', () => ({
  listTriggers: mocks.listTriggers,
}));

vi.mock('react-router', async () => {
  const actual = await vi.importActual('react-router');
  return { ...actual, useNavigate: () => mocks.navigate };
});

import { TriggerDropdown } from '../../../src/components/triggers/TriggerDropdown';

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
    nextFireAt: new Date(Date.now() + 3600_000).toISOString(), // 1 hour from now
    lastTriggeredAt: null,
    triggerCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function renderDropdown(props: { open?: boolean; onToggle?: () => void } = {}) {
  const onToggle = props.onToggle ?? vi.fn();
  return {
    onToggle,
    ...render(
      <MemoryRouter>
        <TriggerDropdown
          projectId="proj-1"
          open={props.open ?? false}
          onToggle={onToggle}
        />
      </MemoryRouter>,
    ),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TriggerDropdown', () => {
  const originalInnerWidth = window.innerWidth;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listTriggers.mockResolvedValue({ triggers: [], total: 0 });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
  });

  it('renders clock button with correct aria-label', () => {
    renderDropdown();
    expect(screen.getByRole('button', { name: 'Automation triggers' })).toBeInTheDocument();
  });

  it('does not fetch triggers when closed', () => {
    renderDropdown({ open: false });
    expect(mocks.listTriggers).not.toHaveBeenCalled();
  });

  it('fetches triggers when opened', () => {
    renderDropdown({ open: true });
    expect(mocks.listTriggers).toHaveBeenCalledWith('proj-1');
  });

  it('shows loading state during fetch', () => {
    // Never resolve the promise to stay in loading state
    mocks.listTriggers.mockReturnValue(new Promise(() => {}));
    renderDropdown({ open: true });
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('shows empty state when no triggers exist', async () => {
    renderDropdown({ open: true });
    expect(await screen.findByText('No triggers configured.')).toBeInTheDocument();
  });

  it('renders active trigger by name', async () => {
    mocks.listTriggers.mockResolvedValue({
      triggers: [makeTrigger({ id: 't-1', name: 'Daily Review' })],
      total: 1,
    });

    renderDropdown({ open: true });
    expect(await screen.findByText('Daily Review')).toBeInTheDocument();
  });

  it('renders paused trigger with Paused label', async () => {
    mocks.listTriggers.mockResolvedValue({
      triggers: [makeTrigger({ id: 't-1', name: 'Paused Trigger', status: 'paused' })],
      total: 1,
    });

    renderDropdown({ open: true });
    expect(await screen.findByText('Paused Trigger')).toBeInTheDocument();
    expect(screen.getByText('Paused')).toBeInTheDocument();
  });

  it('navigates to trigger detail and closes on trigger click', async () => {
    const user = userEvent.setup();
    mocks.listTriggers.mockResolvedValue({
      triggers: [makeTrigger({ id: 't-1', name: 'Daily Review' })],
      total: 1,
    });

    const { onToggle } = renderDropdown({ open: true });
    const item = await screen.findByRole('button', { name: /Daily Review/i });
    await user.click(item);

    expect(mocks.navigate).toHaveBeenCalledWith('/projects/proj-1/triggers/t-1');
    expect(onToggle).toHaveBeenCalled();
  });

  it('navigates to triggers list on New Trigger click', async () => {
    const user = userEvent.setup();
    const { onToggle } = renderDropdown({ open: true });

    const newBtn = await screen.findByRole('button', { name: /New Trigger/i });
    await user.click(newBtn);

    expect(mocks.navigate).toHaveBeenCalledWith('/projects/proj-1/triggers');
    expect(onToggle).toHaveBeenCalled();
  });

  it('navigates to triggers list on Manage click', async () => {
    const user = userEvent.setup();
    const { onToggle } = renderDropdown({ open: true });

    const manageBtn = await screen.findByRole('button', { name: /Manage/i });
    await user.click(manageBtn);

    expect(mocks.navigate).toHaveBeenCalledWith('/projects/proj-1/triggers');
    expect(onToggle).toHaveBeenCalled();
  });

  it('sets aria-expanded based on open prop', () => {
    const { rerender } = render(
      <MemoryRouter>
        <TriggerDropdown projectId="proj-1" open={false} onToggle={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'Automation triggers' })).toHaveAttribute('aria-expanded', 'false');

    rerender(
      <MemoryRouter>
        <TriggerDropdown projectId="proj-1" open={true} onToggle={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'Automation triggers' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Automation triggers' })).toHaveAttribute('aria-haspopup', 'dialog');
  });

  it('closes on Escape and returns focus to the trigger button', async () => {
    const user = userEvent.setup();
    const { onToggle } = renderDropdown({ open: true });
    const triggerButton = screen.getByRole('button', { name: 'Automation triggers' });
    triggerButton.focus();

    await user.keyboard('{Escape}');

    expect(onToggle).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(triggerButton).toHaveFocus());
  });

  it('closes on outside click', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <MemoryRouter>
        <button type="button">Outside</button>
        <TriggerDropdown projectId="proj-1" open={true} onToggle={onToggle} />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'Outside' }));

    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('shows load failure state and retries', async () => {
    const user = userEvent.setup();
    mocks.listTriggers
      .mockRejectedValueOnce(new Error('Unable to load triggers'))
      .mockResolvedValueOnce({ triggers: [], total: 0 });

    renderDropdown({ open: true });

    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load triggers');
    await user.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => {
      expect(mocks.listTriggers).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByText('No triggers configured.')).toBeInTheDocument();
  });

  it('clamps the popover to the right viewport edge', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 });
    const rectSpy = vi
      .spyOn(HTMLButtonElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({
        x: 310,
        y: 12,
        width: 20,
        height: 20,
        top: 12,
        right: 330,
        bottom: 32,
        left: 310,
        toJSON: () => ({}),
      } as DOMRect);

    renderDropdown({ open: true });

    const popover = await screen.findByRole('dialog', { name: /automation triggers/i });
    await waitFor(() => {
      expect(popover).toHaveStyle({ left: '24px' });
    });
    rectSpy.mockRestore();
  });
});
