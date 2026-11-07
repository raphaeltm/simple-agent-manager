import type { DashboardTask } from '@simple-agent-manager/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ActiveTaskCard } from '../../../src/components/ActiveTaskCard';
import {
  sessionStateLabel,
  sessionStateTone,
} from '../../../src/components/project-message-view/SessionHeaderChips';
import {
  SessionStatusBanners,
  SessionStatusCapsules,
} from '../../../src/components/project-message-view/SessionStatusBanners';
import type { UseSessionLifecycleResult } from '../../../src/components/project-message-view/useSessionLifecycle.types';

const mocks = vi.hoisted(() => ({ resume: vi.fn(), invalidate: vi.fn(), navigate: vi.fn() }));
vi.mock('react-router', async (original) => ({
  ...(await original<typeof import('react-router')>()),
  useNavigate: () => mocks.navigate,
}));
vi.mock('../../../src/lib/api/tasks', () => ({ resumeProviderLimitTask: mocks.resume }));
vi.mock('../../../src/lib/query-client', () => ({
  queryClient: { invalidateQueries: mocks.invalidate },
}));
const task = {
  id: 'task-1',
  projectId: 'project-1',
  title: 'Recover saved work',
  projectName: 'Project',
  status: 'queued',
  executionStep: null,
  providerLimitReason: 'Blocked: wait budget exhausted',
  providerLimitVersion: 'window-1',
  createdAt: Date.now(),
} as DashboardTask;
const lifecycle = (isMine = true) =>
  ({
    session: { isMine },
    taskEmbed: task,
    messages: [],
    resumeError: 'Old wake failed',
    sessionState: 'sleeping',
    isWaking: true,
    agentActivity: 'working',
  }) as unknown as UseSessionLifecycleResult;

beforeEach(() => vi.clearAllMocks());
describe('provider limit owner recovery', () => {
  it('uses one coherent blocked or waiting state in both header layouts', () => {
    const embed = lifecycle().taskEmbed;
    expect(sessionStateLabel('sleeping', embed)).toBe('Needs you');
    expect(sessionStateTone('sleeping', embed)).toBe('warning');
    const waiting = { ...embed!, providerLimitReason: 'Waiting until 19:10 UTC' };
    expect(sessionStateLabel('sleeping', waiting)).toBe('Waiting');
    expect(sessionStateTone('sleeping', waiting)).toBe('info');
  });
  it('resumes from the dashboard without opening the chat; remains waking on a stale rerender', async () => {
    let finish!: () => void;
    mocks.resume.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const view = render(
      <MemoryRouter>
        <ActiveTaskCard task={task} />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Resume task' }));
    expect(mocks.resume).toHaveBeenCalledWith('project-1', 'task-1');
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Resuming…' })).toBeDisabled();
    finish();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Waking…' })).toBeDisabled());
    view.rerender(
      <MemoryRouter>
        <ActiveTaskCard task={{ ...task }} />
      </MemoryRouter>
    );
    expect(screen.getByRole('button', { name: 'Waking…' })).toBeDisabled();
    expect(mocks.invalidate).toHaveBeenCalledOnce();
  });

  it('reenables identical-reason reblocks with a fresh wait generation on both owner surfaces', async () => {
    mocks.resume.mockResolvedValue({ status: 'waking', taskId: task.id });
    const blocked = lifecycle();
    const view = render(
      <>
        <MemoryRouter>
          <ActiveTaskCard task={task} />
        </MemoryRouter>
        <SessionStatusBanners lc={blocked} projectId="project-1" />
      </>
    );
    for (const button of screen.getAllByRole('button', { name: 'Resume task' }))
      fireEvent.click(button);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Waking…' })).toHaveLength(2));
    const reblocked = { ...task, providerLimitVersion: 'window-2' };
    view.rerender(
      <>
        <MemoryRouter>
          <ActiveTaskCard task={reblocked} />
        </MemoryRouter>
        <SessionStatusBanners
          lc={{
            ...blocked,
            taskEmbed: { ...blocked.taskEmbed!, providerLimitVersion: 'window-2' },
          }}
          projectId="project-1"
        />
      </>
    );
    const buttons = screen.getAllByRole('button', { name: 'Resume task' });
    expect(buttons).toHaveLength(2);
    buttons.forEach((button) => expect(button).toBeEnabled());
    fireEvent.click(buttons[1]!);
    await waitFor(() => expect(mocks.resume).toHaveBeenCalledTimes(3));
  });

  it('shows retryable API errors inline in chat and suppresses contradictory wake status', async () => {
    mocks.resume.mockRejectedValueOnce(new Error('Snapshot not ready'));
    render(
      <>
        <SessionStatusBanners lc={lifecycle()} projectId="project-1" />
        <SessionStatusCapsules lc={lifecycle()} />
      </>
    );
    expect(screen.getByText('Needs you')).toBeInTheDocument();
    expect(screen.queryByText('Old wake failed')).not.toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Wake progress' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('wake-progress-banner')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resume task' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Snapshot not ready');
    expect(screen.getByRole('button', { name: 'Resume task' })).toBeEnabled();
  });

  it('shows the blocked reason to readers without granting the owner action', () => {
    render(<SessionStatusBanners lc={lifecycle(false)} projectId="project-1" />);
    expect(screen.getByText(task.providerLimitReason!)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume task' })).not.toBeInTheDocument();
  });
});
