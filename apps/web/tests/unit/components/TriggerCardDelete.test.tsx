import type { TriggerResponse } from '@simple-agent-manager/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  deleteTrigger: vi.fn(),
}));

vi.mock('../../../src/lib/api/triggers', () => ({
  deleteTrigger: mocks.deleteTrigger,
}));

import { TriggerCard } from '../../../src/components/triggers/TriggerCard';

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

const noopHandlers = {
  onEdit: vi.fn(),
  onRunNow: vi.fn(),
  onTogglePause: vi.fn(),
  onViewHistory: vi.fn(),
};

function renderCard(props: { trigger?: TriggerResponse; onDelete?: (t: TriggerResponse) => void } = {}) {
  const trigger = props.trigger ?? makeTrigger({ id: 't-1', name: 'Daily Backup' });
  const onDelete = props.onDelete ?? vi.fn();
  return {
    trigger,
    onDelete,
    ...render(
      <TriggerCard
        trigger={trigger}
        {...noopHandlers}
        onDelete={onDelete}
      />,
    ),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TriggerCard — Delete action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows Delete item in the overflow menu', async () => {
    const user = userEvent.setup();
    renderCard();

    const menuBtn = screen.getByRole('button', { name: 'Trigger actions' });
    await user.click(menuBtn);

    expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
  });

  it('does not show Delete when onDelete is not provided', async () => {
    const user = userEvent.setup();
    const trigger = makeTrigger({ id: 't-1', name: 'Daily Backup' });
    render(
      <TriggerCard
        trigger={trigger}
        {...noopHandlers}
      />,
    );

    const menuBtn = screen.getByRole('button', { name: 'Trigger actions' });
    await user.click(menuBtn);

    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  });

  it('calls onDelete with the trigger when Delete is clicked', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    const { trigger } = renderCard({ onDelete });

    const menuBtn = screen.getByRole('button', { name: 'Trigger actions' });
    await user.click(menuBtn);

    const deleteBtn = screen.getByRole('button', { name: /delete/i });
    await user.click(deleteBtn);

    expect(onDelete).toHaveBeenCalledWith(trigger);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('closes the menu after clicking Delete', async () => {
    const user = userEvent.setup();
    renderCard();

    const menuBtn = screen.getByRole('button', { name: 'Trigger actions' });
    await user.click(menuBtn);

    const deleteBtn = screen.getByRole('button', { name: /delete/i });
    await user.click(deleteBtn);

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
    });
  });

  it('renders Delete with danger styling', async () => {
    const user = userEvent.setup();
    renderCard();

    const menuBtn = screen.getByRole('button', { name: 'Trigger actions' });
    await user.click(menuBtn);

    const deleteBtn = screen.getByRole('button', { name: /delete/i });
    expect(deleteBtn.className).toContain('text-danger');
  });
});
