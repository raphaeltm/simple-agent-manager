import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  listWorkspaces: vi.fn(),
  listProjectTasks: vi.fn(),
}));

vi.mock('../../../../src/lib/api', () => ({
  listWorkspaces: mocks.listWorkspaces,
  listProjectTasks: mocks.listProjectTasks,
}));

import { ProjectInfoPanel } from '../../../../src/components/project/ProjectInfoPanel';

function renderPanel(props: { open: boolean; onClose?: () => void }) {
  return render(
    <MemoryRouter>
      <ProjectInfoPanel
        projectId="proj-1"
        open={props.open}
        onClose={props.onClose ?? vi.fn()}
      />
    </MemoryRouter>
  );
}

describe('ProjectInfoPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listWorkspaces.mockResolvedValue([]);
    mocks.listProjectTasks.mockResolvedValue({ tasks: [], total: 0 });
  });

  it('renders nothing when closed', () => {
    const { container } = renderPanel({ open: false });
    expect(container.innerHTML).toBe('');
  });

  it('renders dialog with title when open', async () => {
    renderPanel({ open: true });

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: 'Project Status' })).toBeInTheDocument();
    });
  });

  it('shows loading spinner while fetching data', () => {
    mocks.listWorkspaces.mockReturnValue(new Promise(() => {})); // never resolves
    mocks.listProjectTasks.mockReturnValue(new Promise(() => {}));

    renderPanel({ open: true });

    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('shows empty state when no workspaces or tasks', async () => {
    renderPanel({ open: true });

    await waitFor(() => {
      expect(screen.getByText('No workspaces for this project.')).toBeInTheDocument();
    });
    expect(screen.getByText('No tasks yet.')).toBeInTheDocument();
  });

  it('displays workspaces with status badges', async () => {
    mocks.listWorkspaces.mockResolvedValue([
      { id: 'ws-1', name: 'ws-one', displayName: 'Workspace One', branch: 'main', status: 'running' },
      { id: 'ws-2', name: 'ws-two', displayName: 'Workspace Two', branch: 'dev', status: 'stopped' },
    ]);

    renderPanel({ open: true });

    await waitFor(() => {
      expect(screen.getByText('Workspace One')).toBeInTheDocument();
    });
    expect(screen.getByText('Workspace Two')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText('Stopped')).toBeInTheDocument();
  });

  it('shows Open button only for running workspaces', async () => {
    mocks.listWorkspaces.mockResolvedValue([
      { id: 'ws-1', name: 'ws-one', displayName: 'Running WS', branch: 'main', status: 'running' },
      { id: 'ws-2', name: 'ws-two', displayName: 'Stopped WS', branch: 'dev', status: 'stopped' },
    ]);

    renderPanel({ open: true });

    await waitFor(() => {
      expect(screen.getByText('Running WS')).toBeInTheDocument();
    });

    // Only one "Open" button (for running workspace)
    const openButtons = screen.getAllByText('Open');
    expect(openButtons).toHaveLength(1);
  });

  it('displays tasks with status and links', async () => {
    mocks.listProjectTasks.mockResolvedValue({
      tasks: [
        {
          id: 'task-1',
          projectId: 'proj-1',
          userId: 'user-1',
          title: 'Add dark mode',
          status: 'in_progress',
          outputBranch: 'sam/add-dark-mode',
          updatedAt: new Date().toISOString(),
        },
        {
          id: 'task-2',
          projectId: 'proj-1',
          userId: 'user-1',
          title: 'Fix login bug',
          status: 'completed',
          outputBranch: null,
          updatedAt: new Date().toISOString(),
        },
      ],
      total: 2,
    });

    renderPanel({ open: true });

    await waitFor(() => {
      expect(screen.getByText('Add dark mode')).toBeInTheDocument();
    });
    expect(screen.getByText('Fix login bug')).toBeInTheDocument();
    expect(screen.getByText('In Progress')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.getByText(/sam\/add-dark-mode/)).toBeInTheDocument();
  });

  it('closes when backdrop is clicked', async () => {
    const onClose = vi.fn();
    renderPanel({ open: true, onClose });

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    // Click the backdrop (the element before the dialog panel)
    const backdrop = screen.getByRole('dialog').previousElementSibling;
    if (backdrop) fireEvent.click(backdrop);

    expect(onClose).toHaveBeenCalled();
  });

  it('closes when Escape is pressed', async () => {
    const onClose = vi.fn();
    renderPanel({ open: true, onClose });

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalled();
  });

  it('handles API failures gracefully', async () => {
    mocks.listWorkspaces.mockRejectedValue(new Error('Network error'));
    mocks.listProjectTasks.mockRejectedValue(new Error('Network error'));

    renderPanel({ open: true });

    // Should show empty state, not crash
    await waitFor(() => {
      expect(screen.getByText('No workspaces for this project.')).toBeInTheDocument();
    });
    expect(screen.getByText('No tasks yet.')).toBeInTheDocument();
  });

  it('sorts active workspaces before stopped ones', async () => {
    mocks.listWorkspaces.mockResolvedValue([
      { id: 'ws-1', name: 'ws-stopped', displayName: 'Stopped First', branch: 'a', status: 'stopped' },
      { id: 'ws-2', name: 'ws-running', displayName: 'Running Second', branch: 'b', status: 'running' },
    ]);

    renderPanel({ open: true });

    await waitFor(() => {
      expect(screen.getByText('Running Second')).toBeInTheDocument();
    });

    // Active workspace should appear before stopped
    const names = screen.getAllByText(/First|Second/).map((el) => el.textContent);
    expect(names.indexOf('Running Second')).toBeLessThan(names.indexOf('Stopped First'));
  });

  it('prevents body scroll when open', () => {
    renderPanel({ open: true });
    expect(document.body.style.overflow).toBe('hidden');
  });
});
