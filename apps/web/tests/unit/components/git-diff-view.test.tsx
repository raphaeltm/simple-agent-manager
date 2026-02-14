import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  getGitDiff: vi.fn(),
  getGitFile: vi.fn(),
}));

vi.mock('../../../src/lib/api', () => ({
  getGitDiff: mocks.getGitDiff,
  getGitFile: mocks.getGitFile,
}));

import { GitDiffView } from '../../../src/components/GitDiffView';

const defaultProps = {
  workspaceUrl: 'https://ws-test.example.com',
  workspaceId: 'ws-123',
  token: 'test-token',
  filePath: 'src/main.ts',
  staged: false,
  isMobile: false,
  onBack: vi.fn(),
  onClose: vi.fn(),
};

const sampleDiff = `diff --git a/src/main.ts b/src/main.ts
index abc1234..def5678 100644
--- a/src/main.ts
+++ b/src/main.ts
@@ -1,3 +1,4 @@
 import { app } from './app';
+import { logger } from './logger';

 app.listen(3000);`;

describe('GitDiffView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows spinner while loading', () => {
    mocks.getGitDiff.mockReturnValue(new Promise(() => {}));
    render(<GitDiffView {...defaultProps} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows error message on fetch failure', async () => {
    mocks.getGitDiff.mockRejectedValue(new Error('Diff fetch failed'));
    render(<GitDiffView {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('Diff fetch failed')).toBeInTheDocument();
    });
  });

  it('shows "No diff available" when diff is empty', async () => {
    mocks.getGitDiff.mockResolvedValue({ diff: '' });
    render(<GitDiffView {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('No diff available')).toBeInTheDocument();
    });
  });

  it('renders diff content with colored lines', async () => {
    mocks.getGitDiff.mockResolvedValue({ diff: sampleDiff });
    render(<GitDiffView {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText(/import \{ logger \}/)).toBeInTheDocument();
    });
  });

  it('displays file path in header', async () => {
    mocks.getGitDiff.mockResolvedValue({ diff: sampleDiff });
    render(<GitDiffView {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('src/main.ts')).toBeInTheDocument();
    });
  });

  it('calls onBack when back button is clicked', async () => {
    mocks.getGitDiff.mockResolvedValue({ diff: sampleDiff });
    render(<GitDiffView {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText(/import \{ logger \}/)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText('Back to file list'));
    expect(defaultProps.onBack).toHaveBeenCalled();
  });

  it('calls onClose when close button is clicked', async () => {
    mocks.getGitDiff.mockResolvedValue({ diff: sampleDiff });
    render(<GitDiffView {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText(/import \{ logger \}/)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText('Close'));
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('calls onClose when Escape key is pressed', async () => {
    mocks.getGitDiff.mockResolvedValue({ diff: sampleDiff });
    render(<GitDiffView {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText(/import \{ logger \}/)).toBeInTheDocument();
    });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('shows Diff/Full toggle buttons', async () => {
    mocks.getGitDiff.mockResolvedValue({ diff: sampleDiff });
    render(<GitDiffView {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('Diff')).toBeInTheDocument();
    });
    expect(screen.getByText('Full')).toBeInTheDocument();
  });

  it('switches to full file view when Full button is clicked', async () => {
    mocks.getGitDiff.mockResolvedValue({ diff: sampleDiff });
    mocks.getGitFile.mockResolvedValue({
      content: `import { app } from './app';
import { logger } from './logger';

app.listen(3000);`,
    });
    render(<GitDiffView {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('Diff')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Full'));
    await waitFor(() => {
      expect(mocks.getGitFile).toHaveBeenCalledWith(
        defaultProps.workspaceUrl,
        defaultProps.workspaceId,
        defaultProps.token,
        defaultProps.filePath,
      );
    });
  });

  it('falls back to diff view if full file fetch fails', async () => {
    mocks.getGitDiff.mockResolvedValue({ diff: sampleDiff });
    mocks.getGitFile.mockRejectedValue(new Error('File not found'));
    render(<GitDiffView {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('Diff')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Full'));
    // Should still show diff content as fallback
    await waitFor(() => {
      expect(screen.getByText(/import \{ logger \}/)).toBeInTheDocument();
    });
  });

  it('passes staged flag to getGitDiff', async () => {
    mocks.getGitDiff.mockResolvedValue({ diff: sampleDiff });
    render(<GitDiffView {...defaultProps} staged={true} />);
    await waitFor(() => {
      expect(mocks.getGitDiff).toHaveBeenCalledWith(
        defaultProps.workspaceUrl,
        defaultProps.workspaceId,
        defaultProps.token,
        defaultProps.filePath,
        true,
      );
    });
  });
});
