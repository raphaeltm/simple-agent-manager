import type { ProjectDetailResponse, ProjectSummary } from '@simple-agent-manager/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectSummaryCard } from '../../src/components/ProjectSummaryCard';
import { SidebarProjectList } from '../../src/components/SidebarProjectList';
import { queryClient } from '../../src/lib/query-client';
import { projectDetailQueryOptions, projectQueryKeys } from '../../src/lib/query-options';

const mocks = vi.hoisted(() => ({
  getProject: vi.fn(),
}));

vi.mock('../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api')>()),
  getProject: mocks.getProject,
}));

const PROJECT = {
  id: 'project-1',
  name: 'Prefetched project',
  repository: 'acme/prefetched-project',
  githubRepoId: 101,
  defaultBranch: 'main',
  repoProvider: 'github',
  status: 'active',
  activeWorkspaceCount: 0,
  activeSessionCount: 0,
  lastActivityAt: '2026-08-07T20:00:00.000Z',
  taskCountsByStatus: {},
  linkedWorkspaces: 0,
  createdAt: '2026-08-07T19:00:00.000Z',
} satisfies ProjectSummary;

const PROJECT_DETAIL = {
  id: PROJECT.id,
  userId: 'user-1',
  name: PROJECT.name,
  description: null,
  installationId: 'installation-1',
  repository: PROJECT.repository,
  defaultBranch: PROJECT.defaultBranch,
  repoProvider: 'github',
  status: 'active',
  createdAt: PROJECT.createdAt,
  updatedAt: '2026-08-07T20:00:00.000Z',
  summary: {
    repoProvider: 'github',
    activeWorkspaceCount: 0,
    activeSessionCount: 0,
    lastActivityAt: '2026-08-07T20:00:00.000Z',
    taskCountsByStatus: {},
    linkedWorkspaces: 0,
  },
} satisfies ProjectDetailResponse;

function renderWithQuery(ui: ReactElement) {
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('project detail intent prefetch', () => {
  beforeEach(() => {
    queryClient.clear();
    mocks.getProject.mockReset();
    mocks.getProject.mockResolvedValue(PROJECT_DETAIL);
  });

  afterEach(() => {
    queryClient.clear();
  });

  it('prefetches the exact destination query from a project-card hover', async () => {
    renderWithQuery(
      <MemoryRouter>
        <ProjectSummaryCard project={PROJECT} queryScope="user-1" />
      </MemoryRouter>,
    );

    const projectCard = screen.getByText('Prefetched project').closest('[role="button"]');
    if (!projectCard) throw new Error('Project card was not rendered');
    fireEvent.mouseEnter(projectCard);

    await waitFor(() => expect(mocks.getProject).toHaveBeenCalledWith('project-1'));
    expect(queryClient.getQueryData(projectQueryKeys.detail('user-1', 'project-1'))).toEqual(PROJECT_DETAIL);

    await queryClient.fetchQuery(projectDetailQueryOptions('user-1', 'project-1'));
    expect(mocks.getProject).toHaveBeenCalledTimes(1);
  });

  it('prefetches on keyboard focus from the sidebar destination', async () => {
    renderWithQuery(
      <SidebarProjectList
        projects={[PROJECT]}
        loading={false}
        onNavigate={vi.fn()}
        queryScope="user-1"
      />,
    );

    fireEvent.focus(screen.getByRole('button', { name: /Prefetched project/ }));

    await waitFor(() => expect(mocks.getProject).toHaveBeenCalledWith('project-1'));
  });

  it('prefetches on touch intent from a project card', async () => {
    renderWithQuery(
      <MemoryRouter>
        <ProjectSummaryCard project={PROJECT} queryScope="user-1" />
      </MemoryRouter>,
    );

    const projectCard = screen.getByText('Prefetched project').closest('[role="button"]');
    if (!projectCard) throw new Error('Project card was not rendered');
    fireEvent.touchStart(projectCard);

    await waitFor(() => expect(mocks.getProject).toHaveBeenCalledWith('project-1'));
  });

  it('cancels speculative hover when the pointer only sweeps across a card', async () => {
    renderWithQuery(
      <MemoryRouter>
        <ProjectSummaryCard project={PROJECT} queryScope="user-1" />
      </MemoryRouter>,
    );

    const projectCard = screen.getByText('Prefetched project').closest('[role="button"]');
    if (!projectCard) throw new Error('Project card was not rendered');
    fireEvent.mouseEnter(projectCard);
    fireEvent.mouseLeave(projectCard);

    await new Promise((resolve) => window.setTimeout(resolve, 150));
    expect(mocks.getProject).not.toHaveBeenCalled();
  });
});
