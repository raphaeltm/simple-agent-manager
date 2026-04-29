import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { ProjectSummary } from '@simple-agent-manager/shared';

import { SidebarProjectList } from '../../src/components/SidebarProjectList';

function makeProject(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: overrides.id ?? 'p1',
    name: overrides.name ?? 'Test Project',
    repository: overrides.repository ?? 'user/test-project',
    githubRepoId: null,
    defaultBranch: 'main',
    repoProvider: 'github',
    status: 'active',
    activeWorkspaceCount: 0,
    activeSessionCount: overrides.activeSessionCount ?? 0,
    lastActivityAt: overrides.lastActivityAt ?? new Date().toISOString(),
    createdAt: new Date().toISOString(),
    taskCountsByStatus: {},
    linkedWorkspaces: 0,
    ...overrides,
  };
}

const MOCK_PROJECTS: ProjectSummary[] = [
  makeProject({ id: 'p1', name: 'SAM', repository: 'raphaeltm/simple-agent-manager', activeSessionCount: 2 }),
  makeProject({ id: 'p2', name: 'sam-website', repository: 'raphaeltm/sam-website', activeSessionCount: 1 }),
  makeProject({ id: 'p3', name: 'My Portfolio', repository: 'raphaeltm/portfolio', activeSessionCount: 0 }),
  makeProject({ id: 'p4', name: 'API Client SDK', repository: 'raphaeltm/api-client-sdk', activeSessionCount: 0 }),
];

describe('SidebarProjectList', () => {
  it('renders all projects', () => {
    const onNavigate = vi.fn();
    render(
      <SidebarProjectList
        projects={MOCK_PROJECTS}
        loading={false}
        onNavigate={onNavigate}
      />,
    );

    expect(screen.getByText('SAM')).toBeInTheDocument();
    expect(screen.getByText('sam-website')).toBeInTheDocument();
    expect(screen.getByText('My Portfolio')).toBeInTheDocument();
    expect(screen.getByText('API Client SDK')).toBeInTheDocument();
  });

  it('filters projects by name', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(
      <SidebarProjectList
        projects={MOCK_PROJECTS}
        loading={false}
        onNavigate={onNavigate}
      />,
    );

    const input = screen.getByLabelText('Filter projects');
    await user.type(input, 'sam');

    expect(screen.getByText('SAM')).toBeInTheDocument();
    expect(screen.getByText('sam-website')).toBeInTheDocument();
    expect(screen.queryByText('My Portfolio')).not.toBeInTheDocument();
    expect(screen.queryByText('API Client SDK')).not.toBeInTheDocument();
  });

  it('filters projects by repository name', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(
      <SidebarProjectList
        projects={MOCK_PROJECTS}
        loading={false}
        onNavigate={onNavigate}
      />,
    );

    const input = screen.getByLabelText('Filter projects');
    await user.type(input, 'portfolio');

    expect(screen.getByText('My Portfolio')).toBeInTheDocument();
    expect(screen.queryByText('SAM')).not.toBeInTheDocument();
  });

  it('shows empty state when filter yields no results', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(
      <SidebarProjectList
        projects={MOCK_PROJECTS}
        loading={false}
        onNavigate={onNavigate}
      />,
    );

    const input = screen.getByLabelText('Filter projects');
    await user.type(input, 'nonexistent');

    expect(screen.getByText(/No projects match "nonexistent"/)).toBeInTheDocument();
  });

  it('shows empty state when no projects exist', () => {
    const onNavigate = vi.fn();
    render(
      <SidebarProjectList
        projects={[]}
        loading={false}
        onNavigate={onNavigate}
      />,
    );

    expect(screen.getByText('No projects yet')).toBeInTheDocument();
  });

  it('navigates to project chat on click', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(
      <SidebarProjectList
        projects={MOCK_PROJECTS}
        loading={false}
        onNavigate={onNavigate}
      />,
    );

    await user.click(screen.getByText('SAM'));
    expect(onNavigate).toHaveBeenCalledWith('/projects/p1/chat');
  });

  it('marks current project as active', () => {
    const onNavigate = vi.fn();
    render(
      <SidebarProjectList
        projects={MOCK_PROJECTS}
        loading={false}
        currentProjectId="p2"
        onNavigate={onNavigate}
      />,
    );

    const samWebsite = screen.getByText('sam-website').closest('button');
    expect(samWebsite).toHaveAttribute('aria-current', 'page');

    const sam = screen.getByText('SAM').closest('button');
    expect(sam).not.toHaveAttribute('aria-current');
  });

  it('has accessible activity dot labels', () => {
    const onNavigate = vi.fn();
    render(
      <SidebarProjectList
        projects={MOCK_PROJECTS}
        loading={false}
        onNavigate={onNavigate}
      />,
    );

    const activeDots = screen.getAllByLabelText('Active sessions');
    const inactiveDots = screen.getAllByLabelText('No active sessions');

    // SAM and sam-website have active sessions
    expect(activeDots).toHaveLength(2);
    // My Portfolio and API Client SDK have no active sessions
    expect(inactiveDots).toHaveLength(2);
  });

  it('collapses and expands the section', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(
      <SidebarProjectList
        projects={MOCK_PROJECTS}
        loading={false}
        onNavigate={onNavigate}
      />,
    );

    const toggle = screen.getByRole('button', { name: /Recent Projects/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('SAM')).toBeInTheDocument();

    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('SAM')).not.toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('SAM')).toBeInTheDocument();
  });

  it('clears filter when clear button is clicked', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(
      <SidebarProjectList
        projects={MOCK_PROJECTS}
        loading={false}
        onNavigate={onNavigate}
      />,
    );

    const input = screen.getByLabelText('Filter projects');
    await user.type(input, 'sam');

    expect(screen.queryByText('My Portfolio')).not.toBeInTheDocument();

    const clearButton = screen.getByLabelText('Clear filter');
    await user.click(clearButton);

    expect(input).toHaveValue('');
    expect(screen.getByText('My Portfolio')).toBeInTheDocument();
  });

  it('shows filter count when filter is active', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(
      <SidebarProjectList
        projects={MOCK_PROJECTS}
        loading={false}
        onNavigate={onNavigate}
      />,
    );

    const input = screen.getByLabelText('Filter projects');
    await user.type(input, 'sam');

    expect(screen.getByText('2 of 4 projects')).toBeInTheDocument();
  });

  it('shows loading state', () => {
    const onNavigate = vi.fn();
    render(
      <SidebarProjectList
        projects={[]}
        loading={true}
        onNavigate={onNavigate}
      />,
    );

    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });
});
