/**
 * Behavioral tests for the SettingsNotifications page.
 *
 * Focus areas (CTO remediation item 5):
 *   - Loading status is announced accessibly.
 *   - Toggles reflect resolved preference state (global type pref > wildcard > default-on).
 *   - Only global in-app prefs (projectId === null) drive the toggles; project-scoped
 *     rows are ignored, and a null projectId is handled explicitly (no truthiness bugs).
 *   - A save failure surfaces an accessible alert AND does not optimistically flip the
 *     switch to a value the server rejected.
 *   - A load failure surfaces an accessible alert with a working Retry control.
 */
import type { NotificationPreference } from '@simple-agent-manager/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getNotificationPreferences: vi.fn(),
  updateNotificationPreference: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  getNotificationPreferences: mocks.getNotificationPreferences,
  updateNotificationPreference: mocks.updateNotificationPreference,
}));

import { SettingsNotifications } from '../../../src/pages/SettingsNotifications';

function globalPref(
  notificationType: NotificationPreference['notificationType'],
  enabled: boolean
): NotificationPreference {
  return { notificationType, projectId: null, channel: 'in_app', enabled };
}

describe('SettingsNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getNotificationPreferences.mockResolvedValue({ preferences: [] });
    mocks.updateNotificationPreference.mockResolvedValue(undefined);
  });

  it('announces loading state accessibly', () => {
    mocks.getNotificationPreferences.mockReturnValue(new Promise(() => {})); // never resolves
    render(<SettingsNotifications />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Loading preferences...');
  });

  it('defaults every type switch to enabled when no preferences exist', async () => {
    render(<SettingsNotifications />);
    await waitFor(() => {
      expect(screen.getByText('Task Complete')).toBeInTheDocument();
    });
    const switches = screen.getAllByRole('switch');
    expect(switches).toHaveLength(6);
    for (const sw of switches) {
      expect(sw).toHaveAttribute('aria-checked', 'true');
    }
  });

  it('reflects a global type-specific disable', async () => {
    mocks.getNotificationPreferences.mockResolvedValue({
      preferences: [globalPref('task_complete', false)],
    });
    render(<SettingsNotifications />);

    const taskCompleteSwitch = await screen.findByRole('switch', {
      name: /Task Complete/i,
    });
    expect(taskCompleteSwitch).toHaveAttribute('aria-checked', 'false');
  });

  it('ignores project-scoped rows when resolving the global toggle', async () => {
    const projectScoped: NotificationPreference = {
      notificationType: 'task_complete',
      projectId: 'proj-9',
      channel: 'in_app',
      enabled: false,
    };
    mocks.getNotificationPreferences.mockResolvedValue({ preferences: [projectScoped] });
    render(<SettingsNotifications />);

    const taskCompleteSwitch = await screen.findByRole('switch', {
      name: /Task Complete/i,
    });
    // A project-scoped disable must NOT turn off the global toggle (defaults on).
    expect(taskCompleteSwitch).toHaveAttribute('aria-checked', 'true');
  });

  it('commits the toggle only after the server confirms', async () => {
    render(<SettingsNotifications />);
    const taskCompleteSwitch = await screen.findByRole('switch', {
      name: /Task Complete/i,
    });
    expect(taskCompleteSwitch).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(taskCompleteSwitch);

    await waitFor(() => {
      expect(mocks.updateNotificationPreference).toHaveBeenCalledWith({
        notificationType: 'task_complete',
        channel: 'in_app',
        enabled: false,
      });
    });
    await waitFor(() => {
      expect(
        screen.getByRole('switch', { name: /Task Complete/i })
      ).toHaveAttribute('aria-checked', 'false');
    });
  });

  it('surfaces a save failure accessibly and does not flip the switch', async () => {
    mocks.updateNotificationPreference.mockRejectedValue(new Error('boom'));
    render(<SettingsNotifications />);
    const taskCompleteSwitch = await screen.findByRole('switch', {
      name: /Task Complete/i,
    });

    fireEvent.click(taskCompleteSwitch);

    // Error is announced
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Task Complete/);

    // Switch state did NOT optimistically change to the rejected value
    expect(
      screen.getByRole('switch', { name: /Task Complete/i })
    ).toHaveAttribute('aria-checked', 'true');
  });

  it('surfaces a load failure with a working Retry control', async () => {
    mocks.getNotificationPreferences.mockRejectedValueOnce(new Error('network'));
    render(<SettingsNotifications />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Could not load notification preferences/i);

    // Retry succeeds on the second call
    mocks.getNotificationPreferences.mockResolvedValueOnce({
      preferences: [globalPref('error', false)],
    });
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }));

    const errorSwitch = await screen.findByRole('switch', { name: /Error/i });
    expect(errorSwitch).toHaveAttribute('aria-checked', 'false');
  });
});
