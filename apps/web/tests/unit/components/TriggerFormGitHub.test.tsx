import type { TriggerResponse } from '@simple-agent-manager/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TriggerForm } from '../../../src/components/triggers/TriggerForm';
import { ToastProvider } from '../../../src/hooks/useToast';
import { createTrigger, updateTrigger } from '../../../src/lib/api';
import { ProjectContext } from '../../../src/pages/ProjectContext';
import { QueryTestWrapper } from '../../test-utils/query-test-utils';

vi.mock('../../../src/lib/api', () => ({
  createTrigger: vi.fn().mockResolvedValue({}),
  updateTrigger: vi.fn().mockResolvedValue({}),
  listAgentProfiles: vi.fn().mockResolvedValue({ items: [] }),
}));
vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'user', email: 'u@example.com' } }),
}));
function setup(editTrigger?: TriggerResponse) {
  render(
    <ProjectContext.Provider
      value={{ projectId: 'project', project: null, installations: [], reload: vi.fn() }}
    >
      <ToastProvider>
        <TriggerForm open onClose={vi.fn()} editTrigger={editTrigger} />
      </ToastProvider>
    </ProjectContext.Provider>,
    { wrapper: QueryTestWrapper }
  );
}
function change(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
function fillRequired() {
  change('Name', 'Review GitHub Issue');
  change('Prompt template', 'Review {{github.title}}');
}
describe('GitHub trigger actual form submission', () => {
  beforeEach(() => vi.clearAllMocks());
  it('defaults new issues to opened and resets incompatible hidden filters for push', async () => {
    setup();
    fillRequired();
    fireEvent.click(screen.getByRole('button', { name: /GitHub event/ }));
    expect(screen.getByLabelText('Actions')).toHaveValue('created');
    change('GitHub event', 'issues');
    expect(screen.getByLabelText('Actions')).toHaveValue('opened');
    change('Required labels', 'bug');
    change('Text contains', 'critical');
    change('GitHub event', 'pull_request');
    expect(screen.getByLabelText('Actions')).toHaveValue('opened');
    change('Source branches', 'feature/A');
    fireEvent.click(screen.getByLabelText('Ignore draft pull requests'));
    change('GitHub event', 'push');
    expect(screen.getByLabelText('Actions')).toBeDisabled();
    expect(screen.getByLabelText('Actions')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Create Trigger' }));
    await waitFor(() =>
      expect(createTrigger).toHaveBeenCalledWith(
        'project',
        expect.objectContaining({
          githubConfig: {
            eventType: 'push',
            filters: { ignoreActors: ['dependabot[bot]'], branches: ['feature/A'] },
          },
        })
      )
    );
  });
  it('submits opened from the real issue create form and blocks invalid typed actions', async () => {
    setup();
    fillRequired();
    fireEvent.click(screen.getByRole('button', { name: /GitHub event/ }));
    change('GitHub event', 'issues');
    change('Actions', 'created');
    fireEvent.click(screen.getByRole('button', { name: 'Create Trigger' }));
    expect(createTrigger).not.toHaveBeenCalled();
    change('Actions', 'opened');
    fireEvent.click(screen.getByRole('button', { name: 'Create Trigger' }));
    await waitFor(() =>
      expect(createTrigger).toHaveBeenCalledWith(
        'project',
        expect.objectContaining({
          githubConfig: {
            eventType: 'issues',
            filters: { actions: ['opened'], ignoreActors: ['dependabot[bot]'] },
          },
        })
      )
    );
  });
  it('edits GitHub configuration and preserves empty filters and false draft setting', async () => {
    setup({
      id: 'trigger',
      name: 'Review PR',
      sourceType: 'github',
      promptTemplate: 'Review',
      cronTimezone: 'UTC',
      githubConfig: { eventType: 'pull_request', filters: { ignoreDrafts: false } },
      skipIfRunning: true,
      maxConcurrent: 1,
      taskMode: 'task',
    } as TriggerResponse);
    expect(screen.getByLabelText('Actions')).toHaveValue('');
    expect(screen.getByLabelText('Ignore actors')).toHaveValue('');
    expect(screen.getByLabelText('Ignore draft pull requests')).not.toBeChecked();
    change('Actions', 'synchronize');
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() =>
      expect(updateTrigger).toHaveBeenCalledWith(
        'project',
        'trigger',
        expect.objectContaining({
          githubConfig: {
            eventType: 'pull_request',
            filters: { actions: ['synchronize'], ignoreDrafts: false },
          },
        })
      )
    );
  });
  it('omits GitHub config on name-only edits, preserving comma-bearing arrays and raw text', async () => {
    const config = {
      eventType: 'pull_request' as const,
      filters: {
        actions: ['opened'],
        labels: ['UI, UX'],
        branches: ['feature,a'],
        bodyContains: ' padded text ',
      },
    };
    setup({
      id: 'trigger',
      name: 'Original',
      sourceType: 'github',
      promptTemplate: 'Review',
      cronTimezone: 'UTC',
      githubConfig: config,
      skipIfRunning: true,
      maxConcurrent: 1,
      taskMode: 'task',
    } as TriggerResponse);
    change('Name', 'Renamed');
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(updateTrigger).toHaveBeenCalled());
    expect(vi.mocked(updateTrigger).mock.calls[0]![2]).not.toHaveProperty('githubConfig');
  });

  it('preserves untouched PR labels, branches, raw body text and absent draft option on actions-only edit', async () => {
    const filters = {
      actions: ['opened'],
      labels: ['UI, UX'],
      branches: ['feature,a'],
      bodyContains: ' padded text ',
    };
    setup({
      id: 'trigger',
      name: 'Review PR',
      sourceType: 'github',
      promptTemplate: 'Review',
      cronTimezone: 'UTC',
      githubConfig: { eventType: 'pull_request', filters },
      skipIfRunning: true,
      maxConcurrent: 1,
      taskMode: 'task',
    } as TriggerResponse);
    change('Actions', 'synchronize');
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() =>
      expect(updateTrigger).toHaveBeenCalledWith(
        'project',
        'trigger',
        expect.objectContaining({
          githubConfig: {
            eventType: 'pull_request',
            filters: { ...filters, actions: ['synchronize'] },
          },
        })
      )
    );
  });

  it('keeps a whitespace-sensitive command prefix and comment label on actions-only edit', async () => {
    const filters = {
      actions: ['created'],
      labels: ['UI, UX'],
      commandPrefix: '/sam ',
      bodyContains: ' padded text ',
    };
    setup({
      id: 'trigger',
      name: 'Review comment',
      sourceType: 'github',
      promptTemplate: 'Review',
      cronTimezone: 'UTC',
      githubConfig: { eventType: 'issue_comment', filters },
      skipIfRunning: true,
      maxConcurrent: 1,
      taskMode: 'task',
    } as TriggerResponse);
    change('Actions', 'edited');
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() =>
      expect(updateTrigger).toHaveBeenCalledWith(
        'project',
        'trigger',
        expect.objectContaining({
          githubConfig: {
            eventType: 'issue_comment',
            filters: { ...filters, actions: ['edited'] },
          },
        })
      )
    );
  });
});
