import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  getGitStatus: vi.fn(),
}));

vi.mock('../../../src/lib/api', () => ({
  getGitStatus: mocks.getGitStatus,
}));

import { GitChangesPanel } from '../../../src/components/GitChangesPanel';

const defaultProps = {
  workspaceUrl: 'https://ws-test.example.com',
  workspaceId: 'ws-123',
  token: 'test-token',
  isMobile: false,
  onClose: vi.fn(),
  onSelectFile: vi.fn(),
};

describe('GitChangesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows spinner while loading', () => {
    mocks.getGitStatus.mockReturnValue(new Promise(() => {})); // never resolves
    render(<GitChangesPanel {...defaultProps} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows error message on fetch failure', async () => {
    mocks.getGitStatus.mockRejectedValue(new Error('Network error'));
    render(<GitChangesPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
  });

  it('shows "No changes detected" when status is clean', async () => {
    mocks.getGitStatus.mockResolvedValue({
      staged: [],
      unstaged: [],
      untracked: [],
    });
    render(<GitChangesPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('No changes detected')).toBeInTheDocument();
    });
  });

  it('shows staged files section', async () => {
    mocks.getGitStatus.mockResolvedValue({
      staged: [{ path: 'src/index.ts', status: 'M' }],
      unstaged: [],
      untracked: [],
    });
    render(<GitChangesPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('Staged')).toBeInTheDocument();
    });
    expect(screen.getByText('src/')).toBeInTheDocument();
    expect(screen.getByText('index.ts')).toBeInTheDocument();
  });

  it('shows unstaged files section', async () => {
    mocks.getGitStatus.mockResolvedValue({
      staged: [],
      unstaged: [{ path: 'README.md', status: 'M' }],
      untracked: [],
    });
    render(<GitChangesPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('Unstaged')).toBeInTheDocument();
    });
    expect(screen.getByText('README.md')).toBeInTheDocument();
  });

  it('shows untracked files section', async () => {
    mocks.getGitStatus.mockResolvedValue({
      staged: [],
      unstaged: [],
      untracked: [{ path: 'newfile.txt', status: '??' }],
    });
    render(<GitChangesPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('Untracked')).toBeInTheDocument();
    });
    expect(screen.getByText('newfile.txt')).toBeInTheDocument();
  });

  it('calls onSelectFile with path and staged=true for staged files', async () => {
    mocks.getGitStatus.mockResolvedValue({
      staged: [{ path: 'src/app.ts', status: 'A' }],
      unstaged: [],
      untracked: [],
    });
    render(<GitChangesPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('app.ts')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('app.ts'));
    expect(defaultProps.onSelectFile).toHaveBeenCalledWith('src/app.ts', true);
  });

  it('calls onSelectFile with path and staged=false for unstaged files', async () => {
    mocks.getGitStatus.mockResolvedValue({
      staged: [],
      unstaged: [{ path: 'lib/utils.ts', status: 'M' }],
      untracked: [],
    });
    render(<GitChangesPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('utils.ts')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('utils.ts'));
    expect(defaultProps.onSelectFile).toHaveBeenCalledWith('lib/utils.ts', false);
  });

  it('calls onClose when close button is clicked', async () => {
    mocks.getGitStatus.mockResolvedValue({ staged: [], unstaged: [], untracked: [] });
    render(<GitChangesPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('No changes detected')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText('Close'));
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('calls onClose when Escape key is pressed', async () => {
    mocks.getGitStatus.mockResolvedValue({ staged: [], unstaged: [], untracked: [] });
    render(<GitChangesPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('No changes detected')).toBeInTheDocument();
    });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('shows total change count in header', async () => {
    mocks.getGitStatus.mockResolvedValue({
      staged: [{ path: 'a.ts', status: 'M' }],
      unstaged: [{ path: 'b.ts', status: 'M' }],
      untracked: [{ path: 'c.ts', status: '??' }],
    });
    render(<GitChangesPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('(3)')).toBeInTheDocument();
    });
  });

  it('collapses sections when header is clicked', async () => {
    mocks.getGitStatus.mockResolvedValue({
      staged: [{ path: 'a.ts', status: 'M' }],
      unstaged: [],
      untracked: [],
    });
    render(<GitChangesPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('a.ts')).toBeInTheDocument();
    });
    // Click the Staged section header to collapse
    fireEvent.click(screen.getByText('Staged'));
    expect(screen.queryByText('a.ts')).not.toBeInTheDocument();
  });

  it('propagates status updates to parent callback on success', async () => {
    const onStatusChange = vi.fn();
    const status = {
      staged: [{ path: 'a.ts', status: 'M' }],
      unstaged: [],
      untracked: [],
    };
    mocks.getGitStatus.mockResolvedValue(status);

    render(<GitChangesPanel {...defaultProps} onStatusChange={onStatusChange} />);

    await waitFor(() => {
      expect(onStatusChange).toHaveBeenCalledWith(status);
    });
  });

  it('notifies parent when status refresh fails', async () => {
    const onStatusFetchError = vi.fn();
    mocks.getGitStatus.mockRejectedValue(new Error('Network error'));

    render(<GitChangesPanel {...defaultProps} onStatusFetchError={onStatusFetchError} />);

    await waitFor(() => {
      expect(onStatusFetchError).toHaveBeenCalled();
    });
  });
});
