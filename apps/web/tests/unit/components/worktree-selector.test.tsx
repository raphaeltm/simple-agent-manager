import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorktreeSelector } from '../../../src/components/WorktreeSelector';

describe('WorktreeSelector', () => {
  const baseWorktrees = [
    {
      path: '/workspaces/repo',
      branch: 'main',
      headCommit: 'abc1234',
      isPrimary: true,
      isDirty: false,
      dirtyFileCount: 0,
    },
    {
      path: '/workspaces/repo-wt-feature-auth',
      branch: 'feature/auth',
      headCommit: 'def5678',
      isPrimary: false,
      isDirty: true,
      dirtyFileCount: 3,
    },
  ];

  const props = {
    worktrees: baseWorktrees,
    activeWorktree: null as string | null,
    onSelect: vi.fn(),
    onCreate: vi.fn().mockResolvedValue(undefined),
    onRemove: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('renders current active worktree label', () => {
    render(<WorktreeSelector {...props} />);
    expect(screen.getByRole('button', { name: /Switch worktree \(main\)/i })).toBeInTheDocument();
  });

  it('calls onSelect with worktree path for non-primary entry', async () => {
    render(<WorktreeSelector {...props} activeWorktree="/workspaces/repo-wt-feature-auth" />);

    fireEvent.click(screen.getByRole('button', { name: /Switch worktree \(feature\/auth\)/i }));
    fireEvent.click(screen.getByRole('button', { name: /^feature\/auth/i }));

    expect(props.onSelect).toHaveBeenCalledWith('/workspaces/repo-wt-feature-auth');
  });

  it('calls onCreate with branch and createBranch option', async () => {
    render(<WorktreeSelector {...props} />);

    fireEvent.click(screen.getByRole('button', { name: /Switch worktree \(main\)/i }));
    fireEvent.change(screen.getByPlaceholderText('branch name'), {
      target: { value: 'feature/new-panel' },
    });
    fireEvent.click(screen.getByLabelText('Create new branch'));
    fireEvent.click(screen.getByRole('button', { name: 'New Worktree' }));

    await waitFor(() => {
      expect(props.onCreate).toHaveBeenCalledWith({
        branch: 'feature/new-panel',
        createBranch: true,
      });
    });
  });

  it('calls onRemove with force=true for dirty non-primary worktree', async () => {
    render(<WorktreeSelector {...props} />);

    fireEvent.click(screen.getByRole('button', { name: /Switch worktree \(main\)/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      expect(props.onRemove).toHaveBeenCalledWith('/workspaces/repo-wt-feature-auth', true);
    });
  });

  it('shows commit hash for detached-head worktree labels', () => {
    render(
      <WorktreeSelector
        {...props}
        worktrees={[
          {
            path: '/workspaces/repo',
            branch: '',
            headCommit: '7f9aa21',
            isPrimary: true,
            isDirty: false,
            dirtyFileCount: 0,
          },
        ]}
      />
    );

    expect(screen.getByRole('button', { name: /Switch worktree \(7f9aa21\)/i })).toBeInTheDocument();
  });

  it('uses compact icon trigger and mobile sheet when isMobile=true', () => {
    render(<WorktreeSelector {...props} isMobile />);

    const trigger = screen.getByRole('button', { name: /Switch worktree \(main\)/i });
    expect(trigger).toBeInTheDocument();
    expect(trigger).not.toHaveTextContent('Worktree:');

    fireEvent.click(trigger);

    expect(screen.getByRole('button', { name: 'Close worktree menu' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^feature\/auth/i })).toBeInTheDocument();
  });
});
