/**
 * Behavioral tests for the file search feature in ChatFilePanel.
 *
 * These tests verify:
 * 1. Clicking "Search files" renders the search bar and triggers getSessionFileIndex
 * 2. The file index is cached (not re-fetched on second activation)
 * 3. Typing into the search input filters results via fuzzyFilterFiles
 * 4. Pressing Escape clears search and hides the search bar
 * 5. Pressing Enter opens the top result
 * 6. "No files matching" empty state renders when index loaded but no matches
 * 7. Error state renders when getSessionFileIndex rejects
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatFilePanel } from '../../../../src/components/chat/ChatFilePanel';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetSessionFileList = vi.fn();
const mockGetSessionFileIndex = vi.fn();
const mockGetSessionFileContent = vi.fn();
const mockGetSessionGitStatus = vi.fn();
const mockGetSessionGitDiff = vi.fn();
const mockDownloadSessionFile = vi.fn();
const mockGetSessionFileRawUrl = vi.fn().mockReturnValue('https://example.com/raw');

vi.mock('../../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/lib/api')>()),
  getSessionFileList: (...args: unknown[]) => mockGetSessionFileList(...args),
  getSessionFileIndex: (...args: unknown[]) => mockGetSessionFileIndex(...args),
  getSessionFileContent: (...args: unknown[]) => mockGetSessionFileContent(...args),
  getSessionGitStatus: (...args: unknown[]) => mockGetSessionGitStatus(...args),
  getSessionGitDiff: (...args: unknown[]) => mockGetSessionGitDiff(...args),
  downloadSessionFile: (...args: unknown[]) => mockDownloadSessionFile(...args),
  getSessionFileRawUrl: (...args: unknown[]) => mockGetSessionFileRawUrl(...args),
}));

// Minimal mock for components that import heavy deps
vi.mock('../../../../src/components/MarkdownRenderer', () => ({
  RenderedMarkdown: ({ content }: { content: string }) => <div data-testid="rendered-md">{content}</div>,
  SyntaxHighlightedCode: ({ content }: { content: string }) => <pre data-testid="syntax-code">{content}</pre>,
}));

vi.mock('../../../../src/components/shared-file-viewer', () => ({
  DiffRenderer: ({ diff }: { diff: string }) => <pre data-testid="diff-renderer">{diff}</pre>,
  ImageViewer: ({ src, fileName }: { src: string; fileName: string }) => (
    <img data-testid="image-viewer" src={src} alt={fileName} />
  ),
}));

const FILE_INDEX = [
  'src/components/App.tsx',
  'src/components/Button.tsx',
  'src/lib/api/client.ts',
  'src/lib/utils.ts',
  'package.json',
  'README.md',
];

const DEFAULT_ENTRIES = [
  { name: 'src', type: 'dir' as const, size: 0 },
  { name: 'package.json', type: 'file' as const, size: 1234 },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSessionFileList.mockResolvedValue({ path: '.', entries: DEFAULT_ENTRIES });
  mockGetSessionFileIndex.mockResolvedValue(FILE_INDEX);
});

function renderPanel(props?: Partial<React.ComponentProps<typeof ChatFilePanel>>) {
  const defaultProps = {
    projectId: 'proj-1',
    sessionId: 'sess-1',
    initialMode: 'browse' as const,
    onClose: vi.fn(),
  };
  return render(<ChatFilePanel {...defaultProps} {...props} />);
}

describe('ChatFilePanel search', () => {
  it('clicking Search button shows search bar and fetches file index', async () => {
    renderPanel();

    // Wait for initial browse load
    await waitFor(() => expect(mockGetSessionFileList).toHaveBeenCalled());

    // Click the search button
    const searchBtn = screen.getByLabelText('Search files');
    fireEvent.click(searchBtn);

    // Search input should appear
    const input = screen.getByPlaceholderText('Search files by name...');
    expect(input).toBeTruthy();

    // File index should be fetched
    await waitFor(() => expect(mockGetSessionFileIndex).toHaveBeenCalledWith('proj-1', 'sess-1'));
  });

  it('caches file index on second activation (does not re-fetch)', async () => {
    renderPanel();
    await waitFor(() => expect(mockGetSessionFileList).toHaveBeenCalled());

    // First activation
    fireEvent.click(screen.getByLabelText('Search files'));
    await waitFor(() => expect(mockGetSessionFileIndex).toHaveBeenCalledTimes(1));

    // Close search via Escape
    fireEvent.keyDown(screen.getByPlaceholderText('Search files by name...'), { key: 'Escape' });

    // Second activation
    fireEvent.click(screen.getByLabelText('Search files'));

    // Should NOT call getSessionFileIndex again
    expect(mockGetSessionFileIndex).toHaveBeenCalledTimes(1);
  });

  it('typing into search input filters results', async () => {
    renderPanel();
    await waitFor(() => expect(mockGetSessionFileList).toHaveBeenCalled());

    fireEvent.click(screen.getByLabelText('Search files'));
    await waitFor(() => expect(mockGetSessionFileIndex).toHaveBeenCalled());

    const input = screen.getByPlaceholderText('Search files by name...');
    fireEvent.change(input, { target: { value: 'Button' } });

    // Should show the Button.tsx result
    await waitFor(() => {
      expect(screen.getByText('src/components/Button.tsx')).toBeTruthy();
    });
  });

  it('pressing Escape clears search and hides search bar', async () => {
    renderPanel();
    await waitFor(() => expect(mockGetSessionFileList).toHaveBeenCalled());

    fireEvent.click(screen.getByLabelText('Search files'));
    await waitFor(() => expect(mockGetSessionFileIndex).toHaveBeenCalled());

    const input = screen.getByPlaceholderText('Search files by name...');
    fireEvent.change(input, { target: { value: 'App' } });

    // Escape should close search
    fireEvent.keyDown(input, { key: 'Escape' });

    // Search input should be gone
    expect(screen.queryByPlaceholderText('Search files by name...')).toBeNull();
  });

  it('pressing Enter opens the top result', async () => {
    renderPanel();
    await waitFor(() => expect(mockGetSessionFileList).toHaveBeenCalled());

    fireEvent.click(screen.getByLabelText('Search files'));
    await waitFor(() => expect(mockGetSessionFileIndex).toHaveBeenCalled());

    const input = screen.getByPlaceholderText('Search files by name...');
    fireEvent.change(input, { target: { value: 'utils' } });

    // Wait for results to render
    await waitFor(() => {
      expect(screen.getByText('src/lib/utils.ts')).toBeTruthy();
    });

    // Mock the file content response for when we navigate to the file
    mockGetSessionFileContent.mockResolvedValue({ content: 'export const x = 1;' });

    // Press Enter to open top result
    fireEvent.keyDown(input, { key: 'Enter' });

    // Should switch to view mode — search bar should disappear
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('Search files by name...')).toBeNull();
    });

    // Should have called loadFile for the result
    await waitFor(() => {
      expect(mockGetSessionFileContent).toHaveBeenCalled();
    });
  });

  it('shows "No files matching" when index is loaded but no matches', async () => {
    renderPanel();
    await waitFor(() => expect(mockGetSessionFileList).toHaveBeenCalled());

    fireEvent.click(screen.getByLabelText('Search files'));
    await waitFor(() => expect(mockGetSessionFileIndex).toHaveBeenCalled());

    const input = screen.getByPlaceholderText('Search files by name...');
    fireEvent.change(input, { target: { value: 'zzzzzzz' } });

    await waitFor(() => {
      expect(screen.getByText(/No files matching/)).toBeTruthy();
    });
  });

  it('shows error when getSessionFileIndex rejects', async () => {
    mockGetSessionFileIndex.mockRejectedValue(new Error('Network failure'));

    renderPanel();
    await waitFor(() => expect(mockGetSessionFileList).toHaveBeenCalled());

    fireEvent.click(screen.getByLabelText('Search files'));

    // Wait for the fetch to fail
    await waitFor(() => expect(mockGetSessionFileIndex).toHaveBeenCalled());

    // Type a query so the search results area renders (error shows inside the results area)
    const input = screen.getByPlaceholderText('Search files by name...');
    fireEvent.change(input, { target: { value: 'test' } });

    await waitFor(() => {
      expect(screen.getByText('Network failure')).toBeTruthy();
    });
  });

  it('clear button resets search query', async () => {
    renderPanel();
    await waitFor(() => expect(mockGetSessionFileList).toHaveBeenCalled());

    fireEvent.click(screen.getByLabelText('Search files'));
    await waitFor(() => expect(mockGetSessionFileIndex).toHaveBeenCalled());

    const input = screen.getByPlaceholderText('Search files by name...');
    fireEvent.change(input, { target: { value: 'App' } });

    // Clear button should appear
    const clearBtn = screen.getByLabelText('Clear search');
    fireEvent.click(clearBtn);

    // Input value should be cleared
    expect((input as HTMLInputElement).value).toBe('');
  });
});
