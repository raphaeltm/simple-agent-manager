import { cleanup, render, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the API module before importing the component
vi.mock('../../src/lib/api', () => ({
  getSessionFileList: vi.fn().mockResolvedValue({
    path: '.',
    entries: [{ name: 'hello.ts', type: 'file', size: 42, modifiedAt: '2026-01-01T00:00:00Z' }],
  }),
  getSessionFileContent: vi.fn().mockResolvedValue('file content'),
  getSessionFileIndex: vi.fn().mockResolvedValue([]),
  getSessionFileRawUrl: vi.fn().mockReturnValue('http://localhost/file.png'),
  getSessionGitDiff: vi.fn().mockResolvedValue('diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new'),
  getSessionGitStatus: vi.fn().mockResolvedValue({
    staged: [{ path: 'staged.ts', status: 'modified' }],
    unstaged: [{ path: 'unstaged.ts', status: 'modified' }],
    untracked: [],
  }),
  downloadSessionFile: vi.fn(),
}));

// Mock DiffRenderer and ImageViewer to avoid parsing issues in jsdom
vi.mock('../../src/components/shared-file-viewer', () => ({
  DiffRenderer: ({ diff }: { diff: string }) => <pre data-testid="diff-renderer">{diff}</pre>,
  ImageViewer: () => null,
}));

// Mock MarkdownRenderer exports used by ChatFilePanel
vi.mock('../../src/components/MarkdownRenderer', () => ({
  CODE_THEME_BG: '#1a1b26',
  RenderedMarkdown: ({ content }: { content: string }) => <div>{content}</div>,
  SyntaxHighlightedCode: ({ content }: { content: string }) => <pre>{content}</pre>,
}));

import { ChatFilePanel } from '../../src/components/chat/ChatFilePanel';

// ChatFilePanel renders via createPortal to document.body, so we query there
const body = () => within(document.body);

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('ChatFilePanel back navigation', () => {
  it('returns to git-status after viewing a diff opened from git-status', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(
      <ChatFilePanel
        projectId="proj-1"
        sessionId="sess-1"
        initialMode="git-status"
        onClose={onClose}
      />,
    );

    // Wait for git status to load — the "Staged" section should appear
    await waitFor(() => {
      expect(body().getByText('Staged (1)')).toBeInTheDocument();
    });

    // Click the "Diff" button for the staged file
    const diffButtons = body().getAllByText('Diff');
    await user.click(diffButtons[0]);

    // Should now be in diff mode — the header shows "Diff: staged.ts"
    await waitFor(() => {
      expect(body().getByText(/Diff: staged\.ts/)).toBeInTheDocument();
    });

    // Click the back arrow
    const backButton = body().getByLabelText('Back');
    await user.click(backButton);

    // Should return to git-status mode, NOT browse mode
    await waitFor(() => {
      expect(body().getByText('Git Changes')).toBeInTheDocument();
    });

    // onClose should NOT have been called
    expect(onClose).not.toHaveBeenCalled();
  });

  it('returns to browse after viewing a file opened from browse', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(
      <ChatFilePanel
        projectId="proj-1"
        sessionId="sess-1"
        initialMode="browse"
        onClose={onClose}
      />,
    );

    // Wait for file listing to load — 'hello.ts' comes from the default mock
    await waitFor(() => {
      expect(body().getByText('hello.ts')).toBeInTheDocument();
    });

    // Click the file to open it
    await user.click(body().getByText('hello.ts'));

    // Should be in view mode — back button is now visible
    await waitFor(() => {
      expect(body().getByLabelText('Back')).toBeInTheDocument();
    });

    // Click back
    await user.click(body().getByLabelText('Back'));

    // Should return to browse mode — header shows "Files" text
    await waitFor(() => {
      const dialog = body().getByRole('dialog');
      // The header span shows "Files" when in browse mode
      expect(within(dialog).getByText('Files', { selector: 'span' })).toBeInTheDocument();
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('calls onClose when pressing close from git-status (top level)', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(
      <ChatFilePanel
        projectId="proj-1"
        sessionId="sess-1"
        initialMode="git-status"
        onClose={onClose}
      />,
    );

    // Wait for git status to load
    await waitFor(() => {
      expect(body().getByText('Git Changes')).toBeInTheDocument();
    });

    // Press the close button (X)
    const closeButton = body().getByLabelText('Close file panel');
    await user.click(closeButton);

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
