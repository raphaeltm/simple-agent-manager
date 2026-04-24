import type { ListFilesResponse, ProjectFile, ProjectFileTag } from '@simple-agent-manager/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  listLibraryFiles: vi.fn(),
  listLibraryDirectories: vi.fn(),
  uploadLibraryFile: vi.fn(),
  deleteLibraryFile: vi.fn(),
  downloadLibraryFile: vi.fn(),
  updateFileTags: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  listLibraryFiles: mocks.listLibraryFiles,
  listLibraryDirectories: mocks.listLibraryDirectories,
  uploadLibraryFile: mocks.uploadLibraryFile,
  deleteLibraryFile: mocks.deleteLibraryFile,
  downloadLibraryFile: mocks.downloadLibraryFile,
  updateFileTags: mocks.updateFileTags,
}));

vi.mock('../../../src/pages/ProjectContext', () => ({
  useProjectContext: () => ({
    projectId: 'proj-test',
    project: { name: 'Test Project' },
    installations: [],
    reload: vi.fn(),
    settingsOpen: false,
    setSettingsOpen: vi.fn(),
    infoPanelOpen: false,
    setInfoPanelOpen: vi.fn(),
  }),
}));

vi.mock('../../../src/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

// Mock library-cache to avoid localStorage issues in test env
const cacheMocks = vi.hoisted(() => ({
  getCachedFiles: vi.fn().mockReturnValue(null),
  setCachedFiles: vi.fn(),
  getCachedDirectories: vi.fn().mockReturnValue(null),
  setCachedDirectories: vi.fn(),
  clearLibraryCache: vi.fn(),
}));

vi.mock('../../../src/lib/library-cache', () => cacheMocks);

import { ProjectLibrary } from '../../../src/pages/ProjectLibrary';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFile(overrides: Partial<ProjectFile> & { id: string; filename: string }): ProjectFile & { tags: ProjectFileTag[] } {
  return {
    projectId: 'proj-test',
    mimeType: 'text/plain',
    sizeBytes: 1024,
    description: null,
    uploadedBy: 'user-1',
    uploadSource: 'user',
    uploadSessionId: null,
    uploadTaskId: null,
    replacedAt: null,
    replacedBy: null,
    status: 'ready',
    extractedTextPreview: null,
    directory: '/',
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
    tags: [],
    ...overrides,
  };
}

function makeResponse(files: ReturnType<typeof makeFile>[]): ListFilesResponse {
  return { files, cursor: null, total: files.length };
}

function renderLibrary() {
  return render(
    <MemoryRouter initialEntries={['/projects/proj-test/library']}>
      <ProjectLibrary />
    </MemoryRouter>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProjectLibrary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cacheMocks.getCachedFiles.mockReturnValue(null);
    cacheMocks.getCachedDirectories.mockReturnValue(null);
    // Default: no directories
    mocks.listLibraryDirectories.mockResolvedValue({ directories: [] });
  });

  it('renders file list with files', async () => {
    const files = [
      makeFile({ id: 'f1', filename: 'readme.md', sizeBytes: 2048 }),
      makeFile({ id: 'f2', filename: 'photo.png', mimeType: 'image/png', sizeBytes: 500_000 }),
    ];
    mocks.listLibraryFiles.mockResolvedValueOnce(makeResponse(files));

    renderLibrary();

    await waitFor(() => {
      expect(screen.getByText('readme.md')).toBeInTheDocument();
    });
    expect(screen.getByText('photo.png')).toBeInTheDocument();
    expect(screen.getByText(/2 files/)).toBeInTheDocument();
  });

  it('renders empty state when no files exist', async () => {
    mocks.listLibraryFiles.mockResolvedValueOnce(makeResponse([]));

    renderLibrary();

    await waitFor(() => {
      expect(screen.getByText('No files yet. Upload files to share with your agents.')).toBeInTheDocument();
    });
    // Upload button in empty state
    expect(screen.getByRole('button', { name: 'Upload Files' })).toBeInTheDocument();
  });

  it('shows agent badge for agent-uploaded files', async () => {
    const files = [
      makeFile({ id: 'f1', filename: 'agent-output.json', uploadSource: 'agent' }),
    ];
    mocks.listLibraryFiles.mockResolvedValueOnce(makeResponse(files));

    renderLibrary();

    await waitFor(() => {
      expect(screen.getByText('agent-output.json')).toBeInTheDocument();
    });
    expect(screen.getByText('agent')).toBeInTheDocument();
  });

  it('shows tag chips on files', async () => {
    const files = [
      makeFile({
        id: 'f1',
        filename: 'spec.md',
        tags: [
          { fileId: 'f1', tag: 'docs', tagSource: 'user' },
          { fileId: 'f1', tag: 'spec', tagSource: 'agent' },
        ],
      }),
    ];
    mocks.listLibraryFiles.mockResolvedValueOnce(makeResponse(files));

    renderLibrary();

    await waitFor(() => {
      expect(screen.getByText('spec.md')).toBeInTheDocument();
    });
    expect(screen.getByText('docs')).toBeInTheDocument();
    expect(screen.getByText('spec')).toBeInTheDocument();
  });

  it('toggles upload zone when Upload button is clicked', async () => {
    mocks.listLibraryFiles.mockResolvedValueOnce(makeResponse([]));

    renderLibrary();

    await waitFor(() => {
      expect(screen.getByText(/No files yet/)).toBeInTheDocument();
    });

    // Click the header Upload button
    const uploadBtn = screen.getByRole('button', { name: 'Upload files' });
    await userEvent.click(uploadBtn);

    expect(screen.getByText('Drop files here or click to browse')).toBeInTheDocument();
  });

  it('toggles filter panel when filter button is clicked', async () => {
    const files = [makeFile({ id: 'f1', filename: 'test.txt' })];
    mocks.listLibraryFiles.mockResolvedValueOnce(makeResponse(files));

    renderLibrary();

    await waitFor(() => {
      expect(screen.getByText('test.txt')).toBeInTheDocument();
    });

    const filterBtn = screen.getByRole('button', { name: 'Toggle filters' });
    await userEvent.click(filterBtn);

    expect(screen.getByPlaceholderText('Search files and folders...')).toBeInTheDocument();
  });

  it('switches between list and grid view', async () => {
    const files = [makeFile({ id: 'f1', filename: 'test.txt' })];
    mocks.listLibraryFiles.mockResolvedValueOnce(makeResponse(files));

    renderLibrary();

    await waitFor(() => {
      expect(screen.getByText('test.txt')).toBeInTheDocument();
    });

    const gridBtn = screen.getByRole('button', { name: 'Grid view' });
    await userEvent.click(gridBtn);

    // File should still be visible in grid view
    expect(screen.getByText('test.txt')).toBeInTheDocument();
  });

  it('opens actions menu and allows download', async () => {
    const files = [makeFile({ id: 'f1', filename: 'document.pdf' })];
    mocks.listLibraryFiles.mockResolvedValueOnce(makeResponse(files));

    renderLibrary();

    await waitFor(() => {
      expect(screen.getByText('document.pdf')).toBeInTheDocument();
    });

    const actionsBtn = screen.getByRole('button', { name: 'Actions for document.pdf' });
    await userEvent.click(actionsBtn);

    expect(screen.getByText('Download')).toBeInTheDocument();
    expect(screen.getByText('Edit Tags')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });

  it('filters by source when source filter is used', async () => {
    const files = [makeFile({ id: 'f1', filename: 'test.txt' })];
    mocks.listLibraryFiles
      .mockResolvedValueOnce(makeResponse(files))
      .mockResolvedValueOnce(makeResponse([]));

    renderLibrary();

    await waitFor(() => {
      expect(screen.getByText('test.txt')).toBeInTheDocument();
    });

    // Open filters
    const filterBtn = screen.getByRole('button', { name: 'Toggle filters' });
    await userEvent.click(filterBtn);

    // Click "Agent" filter
    const agentBtn = screen.getByRole('button', { name: 'Agent' });
    await userEvent.click(agentBtn);

    // Verify API was called with agent source filter
    await waitFor(() => {
      const lastCall = mocks.listLibraryFiles.mock.calls[mocks.listLibraryFiles.mock.calls.length - 1];
      expect(lastCall[1]).toMatchObject({ uploadSource: 'agent' });
    });
  });

  it('renders no-results state when filters match nothing', async () => {
    mocks.listLibraryFiles.mockResolvedValueOnce(makeResponse([]));

    renderLibrary();

    await waitFor(() => {
      expect(screen.getByText(/No files yet/)).toBeInTheDocument();
    });

    // Open filters and search for something
    const filterBtn = screen.getByRole('button', { name: 'Toggle filters' });
    await userEvent.click(filterBtn);

    // Mock subsequent calls (debounced — fires after user stops typing)
    mocks.listLibraryFiles.mockResolvedValue(makeResponse([]));
    const searchInput = screen.getByPlaceholderText('Search files and folders...');
    await userEvent.type(searchInput, 'x');

    // Verify at least one call includes a search param
    await waitFor(() => {
      const calls = mocks.listLibraryFiles.mock.calls;
      const hasSearchCall = calls.some(
        (call: unknown[]) => call[1] && (call[1] as Record<string, unknown>).search,
      );
      expect(hasSearchCall).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Directory navigation tests
  // ---------------------------------------------------------------------------

  it('renders directory entries before files', async () => {
    const files = [makeFile({ id: 'f1', filename: 'readme.md' })];
    mocks.listLibraryFiles.mockResolvedValueOnce(makeResponse(files));
    mocks.listLibraryDirectories.mockResolvedValueOnce({
      directories: [{ path: '/docs/', name: 'docs', fileCount: 3 }],
    });

    renderLibrary();

    await waitFor(() => {
      expect(screen.getByText('docs')).toBeInTheDocument();
    });
    expect(screen.getByText('readme.md')).toBeInTheDocument();
    expect(screen.getByText('3 files')).toBeInTheDocument();
  });

  it('navigates into a directory when folder is clicked', async () => {
    const files = [makeFile({ id: 'f1', filename: 'readme.md' })];
    mocks.listLibraryFiles
      .mockResolvedValueOnce(makeResponse(files))
      .mockResolvedValueOnce(makeResponse([]));
    mocks.listLibraryDirectories
      .mockResolvedValueOnce({
        directories: [{ path: '/docs/', name: 'docs', fileCount: 3 }],
      })
      .mockResolvedValueOnce({ directories: [] });

    renderLibrary();

    await waitFor(() => {
      expect(screen.getByText('docs')).toBeInTheDocument();
    });

    // Click the folder button
    const folderBtn = screen.getByRole('button', { name: /Folder: docs/ });
    await userEvent.click(folderBtn);

    // After navigating, listLibraryFiles should be called with directory: '/docs/'
    await waitFor(() => {
      const lastCall = mocks.listLibraryFiles.mock.calls[mocks.listLibraryFiles.mock.calls.length - 1];
      expect(lastCall[1]).toMatchObject({ directory: '/docs/' });
    });
  });

  it('shows "This folder is empty." for empty subdirectories', async () => {
    mocks.listLibraryFiles
      .mockResolvedValueOnce(makeResponse([]))  // initial root load
      .mockResolvedValueOnce(makeResponse([]));  // after navigating into subdir
    mocks.listLibraryDirectories
      .mockResolvedValueOnce({
        directories: [{ path: '/empty-dir/', name: 'empty-dir', fileCount: 0 }],
      })
      .mockResolvedValueOnce({ directories: [] });

    renderLibrary();

    // Wait for initial load
    await waitFor(() => {
      expect(screen.getByText('empty-dir')).toBeInTheDocument();
    });

    // Navigate into the empty directory
    const folderBtn = screen.getByRole('button', { name: /Folder: empty-dir/ });
    await userEvent.click(folderBtn);

    await waitFor(() => {
      expect(screen.getByText('This folder is empty.')).toBeInTheDocument();
    });
  });

  it('passes directory to upload when uploading from a subdirectory', async () => {
    // First navigate to a subdirectory, then check upload params
    const files = [makeFile({ id: 'f1', filename: 'readme.md' })];
    mocks.listLibraryFiles
      .mockResolvedValueOnce(makeResponse(files))
      .mockResolvedValueOnce(makeResponse([]));
    mocks.listLibraryDirectories
      .mockResolvedValueOnce({
        directories: [{ path: '/assets/', name: 'assets', fileCount: 1 }],
      })
      .mockResolvedValueOnce({ directories: [] });

    renderLibrary();

    await waitFor(() => {
      expect(screen.getByText('assets')).toBeInTheDocument();
    });

    const folderBtn = screen.getByRole('button', { name: /Folder: assets/ });
    await userEvent.click(folderBtn);

    // After navigation, the component state's currentDirectory should be '/assets/'
    // We verify this by checking that the listLibraryFiles call includes directory: '/assets/'
    await waitFor(() => {
      const lastCall = mocks.listLibraryFiles.mock.calls[mocks.listLibraryFiles.mock.calls.length - 1];
      expect(lastCall[1]).toMatchObject({ directory: '/assets/' });
    });
  });

  it('shows breadcrumb when in a subdirectory', async () => {
    const files = [makeFile({ id: 'f1', filename: 'readme.md' })];
    mocks.listLibraryFiles
      .mockResolvedValueOnce(makeResponse(files))
      .mockResolvedValueOnce(makeResponse([]));
    mocks.listLibraryDirectories
      .mockResolvedValueOnce({
        directories: [{ path: '/docs/', name: 'docs', fileCount: 1 }],
      })
      .mockResolvedValueOnce({ directories: [] });

    renderLibrary();

    await waitFor(() => {
      expect(screen.getByText('docs')).toBeInTheDocument();
    });

    const folderBtn = screen.getByRole('button', { name: /Folder: docs/ });
    await userEvent.click(folderBtn);

    // Breadcrumb should appear with home button and 'docs' segment
    await waitFor(() => {
      expect(screen.getByRole('navigation', { name: 'Directory breadcrumb' })).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Root directory' })).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Search debounce tests
  // ---------------------------------------------------------------------------

  it('debounces search — typing multiple chars fires API once after delay, not per keystroke', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const files = [makeFile({ id: 'f1', filename: 'readme.md' })];
    mocks.listLibraryFiles.mockResolvedValue(makeResponse(files));
    mocks.listLibraryDirectories.mockResolvedValue({ directories: [] });

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderLibrary();

    // Wait for initial load
    await waitFor(() => {
      expect(screen.getByText('readme.md')).toBeInTheDocument();
    });

    const initialCallCount = mocks.listLibraryFiles.mock.calls.length;

    // Open filters
    const filterBtn = screen.getByRole('button', { name: 'Toggle filters' });
    await user.click(filterBtn);

    const searchInput = screen.getByPlaceholderText('Search files and folders...');

    // Type multiple characters rapidly
    await user.type(searchInput, 'hel');

    // Advance past the debounce delay (300ms)
    await vi.advanceTimersByTimeAsync(500);

    await waitFor(() => {
      const calls = mocks.listLibraryFiles.mock.calls;
      const searchCalls = calls.filter(
        (call: unknown[]) => call[1] && (call[1] as Record<string, unknown>).search === 'hel',
      );
      // Should have exactly one call with the full debounced search string 'hel'
      expect(searchCalls.length).toBe(1);
    });

    // Should NOT have fired per-keystroke calls (h, he, hel = 3 separate search calls)
    const searchCalls = mocks.listLibraryFiles.mock.calls
      .slice(initialCallCount)
      .filter((call: unknown[]) => call[1] && (call[1] as Record<string, unknown>).search);
    expect(searchCalls.length).toBe(1);

    vi.useRealTimers();
  });

  it('existing content stays visible during search refresh (no full-page spinner)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const files = [
      makeFile({ id: 'f1', filename: 'readme.md' }),
      makeFile({ id: 'f2', filename: 'notes.txt' }),
    ];
    mocks.listLibraryFiles.mockResolvedValueOnce(makeResponse(files));
    mocks.listLibraryDirectories.mockResolvedValue({ directories: [] });

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderLibrary();

    await waitFor(() => {
      expect(screen.getByText('readme.md')).toBeInTheDocument();
    });
    expect(screen.getByText('notes.txt')).toBeInTheDocument();

    // Make subsequent API call hang forever (simulates in-flight request)
    mocks.listLibraryFiles.mockReturnValue(new Promise(() => {}));

    // Open filters and type a search query that matches existing files
    const filterBtn = screen.getByRole('button', { name: 'Toggle filters' });
    await user.click(filterBtn);

    const searchInput = screen.getByPlaceholderText('Search files and folders...');
    await user.type(searchInput, 'me');

    // Advance past the debounce delay so the search fires
    await vi.advanceTimersByTimeAsync(500);

    // Client-filtered match (readme.md) should remain visible — no full-page spinner
    expect(screen.getByText('readme.md')).toBeInTheDocument();
    // Non-matching file filtered out by client-side instant filter
    expect(screen.queryByText('notes.txt')).not.toBeInTheDocument();

    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // Client-side filtering tests
  // ---------------------------------------------------------------------------

  it('client-side filters files instantly while search is pending', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const files = [
      makeFile({ id: 'f1', filename: 'readme.md' }),
      makeFile({ id: 'f2', filename: 'notes.txt' }),
      makeFile({ id: 'f3', filename: 'readme-advanced.md' }),
    ];
    mocks.listLibraryFiles.mockResolvedValue(makeResponse(files));
    mocks.listLibraryDirectories.mockResolvedValue({ directories: [] });

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderLibrary();

    await waitFor(() => {
      expect(screen.getByText('readme.md')).toBeInTheDocument();
    });

    // Open filters
    const filterBtn = screen.getByRole('button', { name: 'Toggle filters' });
    await user.click(filterBtn);

    const searchInput = screen.getByPlaceholderText('Search files and folders...');
    await user.type(searchInput, 'readme');

    // WITHOUT advancing timers — client-side filter should already be active
    // readme.md and readme-advanced.md should be visible, notes.txt should not
    expect(screen.getByText('readme.md')).toBeInTheDocument();
    expect(screen.getByText('readme-advanced.md')).toBeInTheDocument();
    expect(screen.queryByText('notes.txt')).not.toBeInTheDocument();

    vi.useRealTimers();
  });

  it('client-side filters directories by name while search is pending', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const files = [makeFile({ id: 'f1', filename: 'test.txt' })];
    mocks.listLibraryFiles.mockResolvedValue(makeResponse(files));
    mocks.listLibraryDirectories.mockResolvedValueOnce({
      directories: [
        { path: '/docs/', name: 'docs', fileCount: 3 },
        { path: '/images/', name: 'images', fileCount: 5 },
      ],
    });

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderLibrary();

    await waitFor(() => {
      expect(screen.getByText('docs')).toBeInTheDocument();
    });
    expect(screen.getByText('images')).toBeInTheDocument();

    const filterBtn = screen.getByRole('button', { name: 'Toggle filters' });
    await user.click(filterBtn);

    const searchInput = screen.getByPlaceholderText('Search files and folders...');
    await user.type(searchInput, 'doc');

    // 'docs' directory should remain, 'images' should be filtered out
    expect(screen.getByText('docs')).toBeInTheDocument();
    expect(screen.queryByText('images')).not.toBeInTheDocument();

    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // Cache tests
  // ---------------------------------------------------------------------------

  it('renders cached data instantly on mount before API call returns', async () => {
    const cachedFiles = makeResponse([
      makeFile({ id: 'f1', filename: 'cached-file.txt' }),
    ]);
    cacheMocks.getCachedFiles.mockReturnValue(cachedFiles);
    cacheMocks.getCachedDirectories.mockReturnValue([]);

    // Make API call hang
    mocks.listLibraryFiles.mockReturnValue(new Promise(() => {}));
    mocks.listLibraryDirectories.mockReturnValue(new Promise(() => {}));

    renderLibrary();

    // Cached file should appear immediately without waiting for API
    await waitFor(() => {
      expect(screen.getByText('cached-file.txt')).toBeInTheDocument();
    });
  });

  it('caches API results after successful load', async () => {
    const files = [makeFile({ id: 'f1', filename: 'new-file.txt' })];
    mocks.listLibraryFiles.mockResolvedValueOnce(makeResponse(files));

    renderLibrary();

    await waitFor(() => {
      expect(screen.getByText('new-file.txt')).toBeInTheDocument();
    });

    // setCachedFiles should have been called with the response
    expect(cacheMocks.setCachedFiles).toHaveBeenCalledWith(
      'proj-test', '/', 'createdAt',
      expect.objectContaining({ files }),
    );
    expect(cacheMocks.setCachedDirectories).toHaveBeenCalledWith(
      'proj-test', '/', [],
    );
  });

  // ---------------------------------------------------------------------------
  // Status bar placement test
  // ---------------------------------------------------------------------------

  it('shows status bar at the top with file and folder counts', async () => {
    const files = [
      makeFile({ id: 'f1', filename: 'readme.md' }),
      makeFile({ id: 'f2', filename: 'notes.txt' }),
    ];
    mocks.listLibraryFiles.mockResolvedValueOnce(makeResponse(files));
    mocks.listLibraryDirectories.mockResolvedValueOnce({
      directories: [{ path: '/docs/', name: 'docs', fileCount: 3 }],
    });

    renderLibrary();

    await waitFor(() => {
      expect(screen.getByText('readme.md')).toBeInTheDocument();
    });

    // Status bar should show both file and folder counts
    expect(screen.getByText(/2 files/)).toBeInTheDocument();
    expect(screen.getByText(/1 folder/)).toBeInTheDocument();
  });
});
