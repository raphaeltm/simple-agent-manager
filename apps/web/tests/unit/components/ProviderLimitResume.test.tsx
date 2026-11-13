import type { DashboardTask } from '@simple-agent-manager/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

const mocks = vi.hoisted(() => ({
  resume: vi.fn(),
  startAnyway: vi.fn(),
  invalidate: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock('react-router', async (original) => ({
  ...(await original<typeof import('react-router')>()),
  useNavigate: () => mocks.navigate,
}));
vi.mock('../../../src/lib/api/tasks', () => ({
  resumeProviderLimitTask: mocks.resume,
  startProviderLimitTaskAnyway: mocks.startAnyway,
}));
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
  it('exposes sibling native controls and supports keyboard open and resume without navigating twice', async () => {
    const user = userEvent.setup();
    mocks.resume.mockResolvedValue({ status: 'waking', taskId: task.id });
    render(
      <MemoryRouter>
        <ActiveTaskCard task={task} />
      </MemoryRouter>
    );
    const open = screen.getByRole('button', { name: `Open task: ${task.title}` });
    const resume = screen.getByRole('button', { name: 'Resume task' });
    expect(open.tagName).toBe('BUTTON');
    expect(open.contains(resume)).toBe(false);
    expect(resume.closest('[role="button"]')).toBeNull();
    await user.tab();
    expect(open).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
    await user.tab();
    expect(resume).toHaveFocus();
    await user.keyboard(' ');
    expect(mocks.resume).toHaveBeenCalledWith('project-1', 'task-1');
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
  });

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

  it('offers Start anyway to the owner of a waiting, never-started task and calls its endpoint', async () => {
    mocks.startAnyway.mockResolvedValue({ status: 'starting', taskId: task.id });
    const waiting = {
      ...lifecycle(),
      resumeError: null,
      taskEmbed: {
        ...task,
        providerLimitReason: 'Waiting for provider limit reset at 06:58 UTC (2026-11-11).',
        providerLimitCanStartAnyway: true,
      },
    } as unknown as UseSessionLifecycleResult;
    render(<SessionStatusBanners lc={waiting} projectId="project-1" />);
    expect(screen.getByText('Waiting for provider limit reset')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume task' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start anyway' }));
    expect(mocks.startAnyway).toHaveBeenCalledWith('project-1', 'task-1');
    expect(mocks.resume).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled());
  });

  it('withholds Start anyway from readers and when the server does not allow it', () => {
    const embed = {
      ...task,
      providerLimitReason: 'Waiting for provider limit reset at 06:58 UTC (2026-11-11).',
    };
    const reader = {
      ...lifecycle(false),
      resumeError: null,
      taskEmbed: { ...embed, providerLimitCanStartAnyway: true },
    } as unknown as UseSessionLifecycleResult;
    const notAllowed = {
      ...lifecycle(),
      resumeError: null,
      taskEmbed: { ...embed, providerLimitCanStartAnyway: false },
    } as unknown as UseSessionLifecycleResult;
    for (const lc of [reader, notAllowed]) {
      const view = render(<SessionStatusBanners lc={lc} projectId="project-1" />);
      // Liveness: the waiting notice itself rendered.
      expect(screen.getByText('Waiting for provider limit reset')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Start anyway' })).not.toBeInTheDocument();
      view.unmount();
    }
  });
});

describe('saved waiting callback force-resume notice', () => {
  function held(owner = true, eligible = true) {
    const lc = lifecycle(owner);
    return {
      ...lc,
      resumeError: null,
      taskEmbed: {
        ...lc.taskEmbed!,
        providerLimitReason: 'Waiting until 19:10 UTC',
        providerLimitCanStartAnyway: false,
        providerLimitCanResumeAnyway: eligible,
      },
    };
  }
  it('resumes the same task and remains disabled while accepted state is stale', async () => {
    let finish!: () => void;
    mocks.startAnyway.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const view = render(<SessionStatusBanners lc={held()} projectId="project-1" />);
    expect(screen.getByText(/same account/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resume anyway' }));
    expect(screen.getByRole('button', { name: 'Resuming…' })).toBeDisabled();
    expect(mocks.startAnyway).toHaveBeenCalledWith('project-1', 'task-1');
    finish();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Waking…' })).toBeDisabled());
    view.rerender(<SessionStatusBanners lc={held()} projectId="project-1" />);
    expect(screen.getByRole('button', { name: 'Waking…' })).toBeDisabled();
    expect(mocks.startAnyway).toHaveBeenCalledTimes(1);
  });
  it('shows errors and supports a safe retry', async () => {
    mocks.startAnyway.mockRejectedValueOnce(new Error('Selected account changed'));
    render(<SessionStatusBanners lc={held()} projectId="project-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Resume anyway' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Selected account changed');
    expect(screen.getByRole('button', { name: 'Resume anyway' })).toBeEnabled();
  });
  it.each([
    [false, true],
    [true, false],
  ])('withholds the action (owner=%s eligible=%s)', (owner, eligible) => {
    render(<SessionStatusBanners lc={held(owner, eligible)} projectId="project-1" />);
    expect(screen.queryByRole('button', { name: 'Resume anyway' })).not.toBeInTheDocument();
  });
});
