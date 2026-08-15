import type { TriggerResponse } from '@simple-agent-manager/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TriggerCard } from '../../../src/components/triggers/TriggerCard';

function makeTrigger(
  overrides: Partial<TriggerResponse> & { id: string; name: string }
): TriggerResponse {
  return {
    projectId: 'proj-1',
    userId: 'user-1',
    description: null,
    status: 'active',
    sourceType: 'cron',
    cronExpression: '30 3 * * *',
    cronTimezone: 'UTC',
    cronHumanReadable: 'At 3:30 AM',
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
  } as TriggerResponse;
}

function renderCard(trigger: TriggerResponse) {
  const handlers = {
    onEdit: vi.fn(),
    onRunNow: vi.fn(),
    onTogglePause: vi.fn(),
    onViewHistory: vi.fn(),
    onDelete: vi.fn(),
  };
  render(<TriggerCard trigger={trigger} {...handlers} />);
  return handlers;
}

describe('TriggerCard — status is readable without relying on colour', () => {
  it.each([
    ['active', 'Active'],
    ['paused', 'Paused'],
    ['disabled', 'Disabled'],
  ])('renders a visible "%s" label as text', (status, label) => {
    // The status used to be communicated ONLY by a coloured dot plus an
    // aria-label, so a sighted colourblind user had no way to tell an active
    // trigger from a disabled one.
    renderCard(makeTrigger({ id: 't1', name: 'Nightly', status: status as never }));
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});

describe('TriggerCard — actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs the trigger from the primary action', async () => {
    const user = userEvent.setup();
    const trigger = makeTrigger({ id: 't1', name: 'Nightly' });
    const handlers = renderCard(trigger);

    await user.click(screen.getByRole('button', { name: 'Run "Nightly" now' }));

    expect(handlers.onRunNow).toHaveBeenCalledWith(trigger);
  });

  it('disables the run action for a disabled trigger', async () => {
    const user = userEvent.setup();
    const handlers = renderCard(makeTrigger({ id: 't1', name: 'Nightly', status: 'disabled' }));

    const runBtn = screen.getByRole('button', { name: 'Run "Nightly" now' });
    expect(runBtn).toBeDisabled();
    await user.click(runBtn);
    expect(handlers.onRunNow).not.toHaveBeenCalled();
  });

  it('exposes edit, pause and history through the actions menu', async () => {
    const user = userEvent.setup();
    const trigger = makeTrigger({ id: 't1', name: 'Nightly' });
    const handlers = renderCard(trigger);

    await user.click(screen.getByRole('button', { name: 'Actions for "Nightly"' }));

    await user.click(screen.getByRole('menuitem', { name: 'Edit' }));
    expect(handlers.onEdit).toHaveBeenCalledWith(trigger);

    await user.click(screen.getByRole('button', { name: 'Actions for "Nightly"' }));
    await user.click(screen.getByRole('menuitem', { name: 'Pause' }));
    expect(handlers.onTogglePause).toHaveBeenCalledWith(trigger);

    await user.click(screen.getByRole('button', { name: 'Actions for "Nightly"' }));
    await user.click(screen.getByRole('menuitem', { name: 'View history' }));
    expect(handlers.onViewHistory).toHaveBeenCalledWith(trigger);
  });

  it('offers Resume rather than Pause for a paused trigger', async () => {
    const user = userEvent.setup();
    renderCard(makeTrigger({ id: 't1', name: 'Nightly', status: 'paused' }));

    await user.click(screen.getByRole('button', { name: 'Actions for "Nightly"' }));

    expect(screen.getByRole('menuitem', { name: 'Resume' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Pause' })).not.toBeInTheDocument();
  });

  it('closes the menu with Escape and returns focus to the trigger button', async () => {
    const user = userEvent.setup();
    renderCard(makeTrigger({ id: 't1', name: 'Nightly' }));

    const menuBtn = screen.getByRole('button', { name: 'Actions for "Nightly"' });
    await user.click(menuBtn);
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(menuBtn).toHaveFocus();
  });

  it('does not duplicate the menu actions as a second row of buttons', async () => {
    // The card previously rendered Run Now / Pause / View History BOTH in the
    // overflow menu and again as a footer button row — two interaction models
    // for the same three actions.
    renderCard(makeTrigger({ id: 't1', name: 'Nightly' }));

    expect(screen.queryByRole('button', { name: /^Pause$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^View History$/i })).not.toBeInTheDocument();
  });
});

describe('TriggerCard — schedule and metadata', () => {
  it('shows the full schedule rather than truncating it', () => {
    renderCard(
      makeTrigger({
        id: 't1',
        name: 'TTV weekly content and link health',
        cronHumanReadable: 'At 7:00 AM on Wednesday',
      })
    );
    expect(screen.getByText('At 7:00 AM on Wednesday')).toBeInTheDocument();
  });

  it('hides the next-run estimate while a trigger is paused', () => {
    renderCard(
      makeTrigger({
        id: 't1',
        name: 'Nightly',
        status: 'paused',
        nextFireAt: new Date(Date.now() + 3600_000).toISOString(),
      })
    );
    // A paused trigger will not fire, so promising a next run is misleading.
    expect(screen.queryByText(/^Next /)).not.toBeInTheDocument();
  });

  it('does not claim a paused trigger failed', () => {
    // The card used to render "Paused — may be due to consecutive failures" for
    // EVERY paused trigger, including one the user had just paused by hand.
    // There is no backend field distinguishing the two, so the claim was unsafe.
    renderCard(makeTrigger({ id: 't1', name: 'Nightly', status: 'paused' }));
    expect(screen.queryByText(/consecutive failures/i)).not.toBeInTheDocument();
  });
});
