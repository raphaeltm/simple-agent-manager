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

  it('creation form is hidden by default and toggleable', () => {
    render(<WorktreeSelector {...props} />);

    // Open the popover
    fireEvent.click(screen.getByRole('button', { name: /Switch worktree \(main\)/i }));

    // Creation form should be hidden
    expect(screen.queryByPlaceholderText('branch name')).not.toBeInTheDocument();

    // Click the plus button to show creation form
    fireEvent.click(screen.getByRole('button', { name: 'New worktree' }));

    // Creation form should now be visible
    expect(screen.getByPlaceholderText('branch name')).toBeInTheDocument();

    // Click plus again to hide
    fireEvent.click(screen.getByRole('button', { name: 'Cancel new worktree' }));
    expect(screen.queryByPlaceholderText('branch name')).not.toBeInTheDocument();
  });

  it('calls onCreate with branch and createBranch option', async () => {
    render(<WorktreeSelector {...props} />);

    // Open popover
    fireEvent.click(screen.getByRole('button', { name: /Switch worktree \(main\)/i }));

    // Expand creation form
    fireEvent.click(screen.getByRole('button', { name: 'New worktree' }));

    fireEvent.change(screen.getByPlaceholderText('branch name'), {
      target: { value: 'feature/new-panel' },
    });
    fireEvent.click(screen.getByLabelText('Create new branch'));
    fireEvent.click(screen.getByRole('button', { name: 'Create Worktree' }));

    await waitFor(() => {
      expect(props.onCreate).toHaveBeenCalledWith({
        branch: 'feature/new-panel',
        createBranch: true,
      });
    });
  });

  it('collapses creation form after successful creation', async () => {
    render(<WorktreeSelector {...props} />);

    fireEvent.click(screen.getByRole('button', { name: /Switch worktree \(main\)/i }));
    fireEvent.click(screen.getByRole('button', { name: 'New worktree' }));

    fireEvent.change(screen.getByPlaceholderText('branch name'), {
      target: { value: 'feature/test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create Worktree' }));

    await waitFor(() => {
      expect(props.onCreate).toHaveBeenCalled();
    });

    // Form should be collapsed after successful creation
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('branch name')).not.toBeInTheDocument();
    });
  });

  it('calls onRemove with single confirmation for dirty worktree', async () => {
    render(<WorktreeSelector {...props} />);

    fireEvent.click(screen.getByRole('button', { name: /Switch worktree \(main\)/i }));
    fireEvent.click(screen.getByRole('button', { name: /Remove feature\/auth/i }));

    await waitFor(() => {
      expect(props.onRemove).toHaveBeenCalledWith('/workspaces/repo-wt-feature-auth', true);
    });
    // Single confirmation, not double
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining('3 dirty files')
    );
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

  it('shows dirty file count badge for dirty worktrees', () => {
    render(<WorktreeSelector {...props} />);

    fireEvent.click(screen.getByRole('button', { name: /Switch worktree \(main\)/i }));

    // The dirty worktree should show its file count
    expect(screen.getByText('3')).toBeInTheDocument();
  });
});
