import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  getGitFile: vi.fn(),
}));

vi.mock('../../../src/lib/api', () => ({
  getGitFile: mocks.getGitFile,
}));

import { FileViewerPanel } from '../../../src/components/FileViewerPanel';

const defaultProps = {
  workspaceUrl: 'https://ws-test.example.com',
  workspaceId: 'ws-123',
  token: 'test-token',
  filePath: 'src/main.ts',
  isMobile: false,
  onBack: vi.fn(),
  onClose: vi.fn(),
};

describe('FileViewerPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('shows spinner while loading', () => {
    mocks.getGitFile.mockReturnValue(new Promise(() => {}));
    render(<FileViewerPanel {...defaultProps} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows error message on fetch failure', async () => {
    mocks.getGitFile.mockRejectedValue(new Error('File not found'));
    render(<FileViewerPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('File not found')).toBeInTheDocument();
    });
  });

  it('displays file name in header', async () => {
    mocks.getGitFile.mockResolvedValue({ content: 'const x = 1;' });
    render(<FileViewerPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('main.ts')).toBeInTheDocument();
    });
  });

  it('renders file content with syntax highlighting', async () => {
    mocks.getGitFile.mockResolvedValue({ content: 'const x = 1;\nconst y = 2;' });
    render(<FileViewerPanel {...defaultProps} />);
    await waitFor(() => {
      // Check that code tokens are rendered (prism splits into spans)
      expect(screen.getAllByText('const').length).toBeGreaterThanOrEqual(2);
    });
  });

  it('shows binary file placeholder for binary content', async () => {
    mocks.getGitFile.mockResolvedValue({ content: 'binary\0data' });
    render(<FileViewerPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText(/Binary file/)).toBeInTheDocument();
    });
  });

  it('calls onBack when back button is clicked', async () => {
    mocks.getGitFile.mockResolvedValue({ content: 'hello' });
    render(<FileViewerPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('main.ts')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText('Back to file list'));
    expect(defaultProps.onBack).toHaveBeenCalled();
  });

  it('calls onClose when close button is clicked', async () => {
    mocks.getGitFile.mockResolvedValue({ content: 'hello' });
    render(<FileViewerPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('main.ts')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText('Close'));
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('calls onClose when Escape key is pressed', async () => {
    mocks.getGitFile.mockResolvedValue({ content: 'hello' });
    render(<FileViewerPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('main.ts')).toBeInTheDocument();
    });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('shows "View Diff" button when hasGitChanges is true', async () => {
    const onViewDiff = vi.fn();
    mocks.getGitFile.mockResolvedValue({ content: 'hello' });
    render(
      <FileViewerPanel
        {...defaultProps}
        hasGitChanges
        isStaged={false}
        onViewDiff={onViewDiff}
      />
    );
    await waitFor(() => {
      expect(screen.getByText('View Diff')).toBeInTheDocument();
    });
  });

  it('does not show "View Diff" button when hasGitChanges is false', async () => {
    mocks.getGitFile.mockResolvedValue({ content: 'hello' });
    render(<FileViewerPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('main.ts')).toBeInTheDocument();
    });
    expect(screen.queryByText('View Diff')).not.toBeInTheDocument();
  });

  it('calls onViewDiff when "View Diff" button is clicked', async () => {
    const onViewDiff = vi.fn();
    mocks.getGitFile.mockResolvedValue({ content: 'hello' });
    render(
      <FileViewerPanel
        {...defaultProps}
        hasGitChanges
        isStaged={false}
        onViewDiff={onViewDiff}
      />
    );
    await waitFor(() => {
      expect(screen.getByText('View Diff')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('View Diff'));
    expect(onViewDiff).toHaveBeenCalledWith('src/main.ts', false);
  });

  it('shows markdown render/source toggle for markdown files', async () => {
    mocks.getGitFile.mockResolvedValue({ content: '# Title\n\nSome text.' });
    render(<FileViewerPanel {...defaultProps} filePath="README.md" />);

    await waitFor(() => {
      expect(screen.getByLabelText('Show rendered markdown')).toBeInTheDocument();
      expect(screen.getByLabelText('Show markdown source')).toBeInTheDocument();
    });
  });

  it('renders markdown by default and can switch to source view', async () => {
    mocks.getGitFile.mockResolvedValue({ content: '# Heading' });
    render(<FileViewerPanel {...defaultProps} filePath="README.md" />);

    await waitFor(() => {
      expect(screen.getByTestId('rendered-markdown')).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Heading' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText('Show markdown source'));

    await waitFor(() => {
      expect(screen.queryByTestId('rendered-markdown')).not.toBeInTheDocument();
      expect(screen.getByText('#')).toBeInTheDocument();
      expect(screen.getByText('Heading')).toBeInTheDocument();
    });
  });

  it('persists markdown mode preference in localStorage', async () => {
    mocks.getGitFile.mockResolvedValue({ content: '# Heading' });
    render(<FileViewerPanel {...defaultProps} filePath="README.md" />);

    await waitFor(() => {
      expect(screen.getByLabelText('Show markdown source')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText('Show markdown source'));
    expect(localStorage.getItem('sam:md-render-mode')).toBe('source');
  });
});
