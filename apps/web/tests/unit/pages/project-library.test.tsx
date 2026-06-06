import type { ListFilesResponse, ProjectFile, ProjectFileTag } from '@simple-agent-manager/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
//
// The client-side index hook (useLibraryIndex) imports `listLibraryFiles`
// directly from `../lib/api/library`, while ProjectLibrary imports the same
// functions from the `../lib/api` barrel (which re-exports them from
// `./library`). Mocking the underlying `./library` module therefore controls
// BOTH the hook's sweep and the page's directory/server-fallback calls with a
// single mock.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  listLibraryFiles: vi.fn(),
  listLibraryDirectories: vi.fn(),
  uploadLibraryFile: vi.fn(),
  deleteLibraryFile: vi.fn(),
  downloadLibraryFile: vi.fn(),
  getLibraryFilePreviewUrl: vi.fn(() => 'https://example.com/preview'),
  updateFileTags: vi.fn(),
  moveLibraryFile: vi.fn(),
}));

vi.mock('../../../src/lib/api/library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api/library')>()),
  listLibraryFiles: mocks.listLibraryFiles,
  listLibraryDirectories: mocks.listLibraryDirectories,
  uploadLibraryFile: mocks.uploadLibraryFile,
  deleteLibraryFile: mocks.deleteLibraryFile,
  downloadLibraryFile: mocks.downloadLibraryFile,
  getLibraryFilePreviewUrl: mocks.getLibraryFilePreviewUrl,
  updateFileTags: mocks.updateFileTags,
  moveLibraryFile: mocks.moveLibraryFile,
}));

vi.mock('../../../src/pages/ProjectContext', () => ({
  useProjectContext: () => ({
    projectId: 'proj-test',
    project: { name: 'Test Project' },
    installations: [],
    reload: vi.fn(),
  }),
}));

vi.mock('../../../src/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

// Mock library-cache to avoid localStorage in the test env. Must include the
// global-index helpers used by the sweep hook in addition to the per-directory
// helpers used by the page.
const cacheMocks = vi.hoisted(() => ({
  getCachedFiles: vi.fn().mockReturnValue(null),
  setCachedFiles: vi.fn(),
  getCachedDirectories: vi.fn().mockReturnValue(null),
  setCachedDirectories: vi.fn(),
  clearLibraryCache: vi.fn(),
  getCachedIndex: vi.fn().mockReturnValue(null),
  setCachedIndex: vi.fn().mockReturnValue(true),
  clearCachedIndex: vi.fn(),
}));

vi.mock('../../../src/lib/library-cache', () => cacheMocks);

import { ProjectLibrary } from '../../../src/pages/ProjectLibrary';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFile(
  overrides: Partial<ProjectFile> & { id: string; filename: string },
): ProjectFile & { tags: ProjectFileTag[] } {
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

/** A single, terminal sweep page (cursor null). total defaults to files.length. */
function page(files: ReturnType<typeof makeFile>[], total?: number): ListFilesResponse {
  return { files, cursor: null, total: total ?? files.length } as ListFilesResponse;
}

function renderLibrary(initialRoute = '/projects/proj-test/library') {
  return render(
    <MemoryRouter initialEntries={[initialRoute]}>
      <ProjectLibrary />
    </MemoryRouter>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProjectLibrary (client-side index)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cacheMocks.getCachedFiles.mockReturnValue(null);
    cacheMocks.getCachedDirectories.mockReturnValue(null);
    cacheMocks.getCachedIndex.mockReturnValue(null);
    cacheMocks.setCachedIndex.mockReturnValue(true);
    mocks.listLibraryDirectories.mockResolvedValue({ directories: [] });
  });

  // --- Basic rendering ------------------------------------------------------

  it('renders the swept file list', async () => {
    mocks.listLibraryFiles.mockResolvedValue(
      page([
        makeFile({ id: 'f1', filename: 'readme.md', sizeBytes: 2048 }),
        makeFile({ id: 'f2', filename: 'photo.png', mimeType: 'image/png', sizeBytes: 500_000 }),
      ]),
    );

    renderLibrary();

    await waitFor(() => expect(screen.getByText('readme.md')).toBeInTheDocument());
    expect(screen.getByText('photo.png')).toBeInTheDocument();
    expect(screen.getAllByText(/2 files/).length).toBeGreaterThan(0);
  });

  it('renders the empty state when no files exist', async () => {
    mocks.listLibraryFiles.mockResolvedValue(page([]));

    renderLibrary();

    await waitFor(() =>
      expect(
        screen.getByText('No files yet. Upload files to share with your agents.'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Upload Files' })).toBeInTheDocument();
  });

  it('shows the agent badge for agent-uploaded files', async () => {
    mocks.listLibraryFiles.mockResolvedValue(
      page([makeFile({ id: 'f1', filename: 'agent-output.json', uploadSource: 'agent' })]),
    );

    renderLibrary();

    await waitFor(() => expect(screen.getByText('agent-output.json')).toBeInTheDocument());
    expect(screen.getByText('agent')).toBeInTheDocument();
  });

  it('shows tag chips on files', async () => {
    mocks.listLibraryFiles.mockResolvedValue(
      page([
        makeFile({
          id: 'f1',
          filename: 'spec.md',
          tags: [
            { fileId: 'f1', tag: 'docs', tagSource: 'user' },
            { fileId: 'f1', tag: 'spec', tagSource: 'agent' },
          ],
        }),
      ]),
    );

    renderLibrary();

    await waitFor(() => expect(screen.getByText('spec.md')).toBeInTheDocument());
    expect(screen.getByText('docs')).toBeInTheDocument();
    expect(screen.getByText('spec')).toBeInTheDocument();
  });

  it('toggles the upload zone when the Upload button is clicked', async () => {
    mocks.listLibraryFiles.mockResolvedValue(page([]));

    renderLibrary();

    await waitFor(() => expect(screen.getByText(/No files yet/)).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Upload files' }));
    expect(screen.getByText('Drop files here or click to browse')).toBeInTheDocument();
  });

  it('toggles the filter panel', async () => {
    mocks.listLibraryFiles.mockResolvedValue(page([makeFile({ id: 'f1', filename: 'test.txt' })]));

    renderLibrary();

    await waitFor(() => expect(screen.getByText('test.txt')).toBeInTheDocument());

    // Source filter buttons live inside the (collapsed) filter panel.
    expect(
      screen.queryByRole('button', { name: 'Show only agent-uploaded files' }),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Toggle filters' }));
    expect(
      screen.getByRole('button', { name: 'Show only agent-uploaded files' }),
    ).toBeInTheDocument();
  });

  it('switches between list and grid view', async () => {
    mocks.listLibraryFiles.mockResolvedValue(page([makeFile({ id: 'f1', filename: 'test.txt' })]));

    renderLibrary();

    await waitFor(() => expect(screen.getByText('test.txt')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Grid view' }));
    expect(screen.getByText('test.txt')).toBeInTheDocument();
  });

  it('opens the actions menu', async () => {
    mocks.listLibraryFiles.mockResolvedValue(
      page([makeFile({ id: 'f1', filename: 'document.pdf' })]),
    );

    renderLibrary();

    await waitFor(() => expect(screen.getByText('document.pdf')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Actions for document.pdf' }));
    expect(screen.getByText('Download')).toBeInTheDocument();
    expect(screen.getByText('Edit Tags')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });

  it('renders directory cards and folder/file counts', async () => {
    mocks.listLibraryFiles.mockResolvedValue(
      page([
        makeFile({ id: 'f1', filename: 'readme.md' }),
        makeFile({ id: 'f2', filename: 'notes.txt' }),
      ]),
    );
    mocks.listLibraryDirectories.mockResolvedValue({
      directories: [{ path: '/docs/', name: 'docs', fileCount: 3 }],
    });

    renderLibrary();

    await waitFor(() => expect(screen.getByText('docs')).toBeInTheDocument());
    expect(screen.getByText('readme.md')).toBeInTheDocument();
    expect(screen.getAllByText(/2 files/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/1 folder/).length).toBeGreaterThanOrEqual(1);
  });

  it('opens the preview modal when ?preview= matches a swept file', async () => {
    mocks.listLibraryFiles.mockResolvedValue(page([makeFile({ id: 'f1', filename: 'readme.md' })]));

    renderLibrary('/projects/proj-test/library?preview=f1');

    await waitFor(() =>
      expect(screen.getAllByText('readme.md').length).toBeGreaterThanOrEqual(2),
    );
  });

  // --- Multi-directory vertical slice --------------------------------------

  it('performs a single ascending sweep on mount (not one request per directory)', async () => {
    mocks.listLibraryFiles.mockResolvedValue(
      page([
        makeFile({ id: 'a', filename: 'root.md', directory: '/' }),
        makeFile({ id: 'b', filename: 'guide.md', directory: '/docs/' }),
        makeFile({ id: 'c', filename: 'logo.png', directory: '/assets/' }),
      ]),
    );

    renderLibrary();

    await waitFor(() => expect(screen.getByText('root.md')).toBeInTheDocument());

    // Exactly one sweep call, and it requested ascending createdAt order.
    expect(mocks.listLibraryFiles).toHaveBeenCalledTimes(1);
    expect(mocks.listLibraryFiles.mock.calls[0]![1]).toMatchObject({
      sortBy: 'createdAt',
      sortOrder: 'asc',
    });
    // Cross-directory files are not shown at root — only the current directory.
    expect(screen.queryByText('guide.md')).not.toBeInTheDocument();
    expect(screen.queryByText('logo.png')).not.toBeInTheDocument();
  });

  it('search spans files across all directories (cross-directory results)', async () => {
    mocks.listLibraryFiles.mockResolvedValue(
      page([
        makeFile({ id: 'a', filename: 'budget.txt', directory: '/' }),
        makeFile({ id: 'b', filename: 'budget-q2.txt', directory: '/finance/2026/' }),
        makeFile({ id: 'c', filename: 'unrelated.png', directory: '/assets/' }),
      ]),
    );

    renderLibrary();

    await waitFor(() => expect(screen.getByText('budget.txt')).toBeInTheDocument());

    const search = screen.getByPlaceholderText('Search files and folders...');
    await userEvent.type(search, 'budget');

    // Both budget files appear even though they live in different directories.
    await waitFor(() => expect(screen.getByText('budget-q2.txt')).toBeInTheDocument());
    expect(screen.getByText('budget.txt')).toBeInTheDocument();
    expect(screen.queryByText('unrelated.png')).not.toBeInTheDocument();

    // No additional server query was issued — search is served from the index.
    expect(mocks.listLibraryFiles).toHaveBeenCalledTimes(1);
  });

  it('does not re-sweep when navigating into a directory', async () => {
    mocks.listLibraryFiles.mockResolvedValue(
      page([
        makeFile({ id: 'a', filename: 'root.md', directory: '/' }),
        makeFile({ id: 'b', filename: 'guide.md', directory: '/docs/' }),
      ]),
    );
    mocks.listLibraryDirectories.mockResolvedValue({
      directories: [{ path: '/docs/', name: 'docs', fileCount: 1 }],
    });

    renderLibrary();

    await waitFor(() => expect(screen.getByText('docs')).toBeInTheDocument());
    const sweepCallsBefore = mocks.listLibraryFiles.mock.calls.length;
    const dirCallsBefore = mocks.listLibraryDirectories.mock.calls.length;

    await userEvent.click(screen.getByRole('button', { name: /Folder: docs/ }));

    // The file in /docs/ is now shown from the already-swept index.
    await waitFor(() => expect(screen.getByText('guide.md')).toBeInTheDocument());

    // The directory listing refetches, but the sweep does NOT run again.
    await waitFor(() =>
      expect(mocks.listLibraryDirectories.mock.calls.length).toBeGreaterThan(dirCallsBefore),
    );
    expect(mocks.listLibraryFiles.mock.calls.length).toBe(sweepCallsBefore);
  });

  // --- Regression tests -----------------------------------------------------

  it('regression: search is visible without opening the filter panel', async () => {
    mocks.listLibraryFiles.mockResolvedValue(page([makeFile({ id: 'f1', filename: 'test.txt' })]));

    renderLibrary();

    await waitFor(() => expect(screen.getByText('test.txt')).toBeInTheDocument());

    // Search input present even though Filters were never toggled.
    expect(screen.getByPlaceholderText('Search files and folders...')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Agent' })).not.toBeInTheDocument();
  });

  it('regression: rows stay mounted during a background re-sweep (no full-page spinner)', async () => {
    const readme = makeFile({ id: 'f1', filename: 'readme.md' });
    // First sweep resolves; the invalidation re-sweep hangs forever.
    mocks.listLibraryFiles
      .mockResolvedValueOnce(page([readme]))
      .mockReturnValue(new Promise(() => {}));
    // The first sweep populated the cache, so the re-sweep hydrates from it
    // (flicker-free) instead of resetting to a full-page loading spinner.
    cacheMocks.getCachedIndex
      .mockReturnValueOnce(null)
      .mockReturnValue({ files: [readme], count: 1, sweptAt: Date.now() });
    mocks.deleteLibraryFile.mockResolvedValue(undefined);

    renderLibrary();

    await waitFor(() => expect(screen.getByText('readme.md')).toBeInTheDocument());

    // Trigger a mutation refresh (delete) -> invalidate() starts a hanging sweep.
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await userEvent.click(screen.getByRole('button', { name: 'Actions for readme.md' }));
    await userEvent.click(screen.getByText('Delete'));

    // Existing row remains visible while the re-sweep is in flight. A subtle
    // background-refresh indicator is fine; the file list is NOT replaced by a
    // full-page loading state.
    await waitFor(() => expect(mocks.deleteLibraryFile).toHaveBeenCalled());
    expect(screen.getByText('readme.md')).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it('regression: a directory with more than 50 files shows all swept files', async () => {
    const files = Array.from({ length: 60 }, (_, i) =>
      makeFile({ id: `f${i}`, filename: `file-${String(i).padStart(2, '0')}.txt`, directory: '/' }),
    );
    mocks.listLibraryFiles.mockResolvedValue(page(files));

    renderLibrary();

    await waitFor(() => expect(screen.getByText('file-00.txt')).toBeInTheDocument());

    // The 50-item server page size does not cap the client index.
    expect(screen.getByText('file-59.txt')).toBeInTheDocument();
    expect(screen.getAllByText(/60 files/).length).toBeGreaterThanOrEqual(1);
  });

  it('regression: a mutation refresh does not resurrect a deleted file', async () => {
    const keep = makeFile({ id: 'f1', filename: 'keep.md' });
    const deleteMe = makeFile({ id: 'f2', filename: 'delete-me.md' });
    mocks.listLibraryFiles
      .mockResolvedValueOnce(page([keep, deleteMe]))
      // The re-sweep after deletion returns the list WITHOUT the deleted file.
      .mockResolvedValue(page([keep]));
    // The first sweep populated the cache (both files); the re-sweep hydrates
    // from it for a flicker-free transition, then overwrites with fresh data.
    cacheMocks.getCachedIndex
      .mockReturnValueOnce(null)
      .mockReturnValue({ files: [keep, deleteMe], count: 2, sweptAt: Date.now() });
    mocks.deleteLibraryFile.mockResolvedValue(undefined);

    renderLibrary();

    await waitFor(() => expect(screen.getByText('delete-me.md')).toBeInTheDocument());

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await userEvent.click(screen.getByRole('button', { name: 'Actions for delete-me.md' }));
    await userEvent.click(screen.getByText('Delete'));
    confirmSpy.mockRestore();

    // After the re-sweep the deleted file is gone and stays gone.
    await waitFor(() => expect(screen.queryByText('delete-me.md')).not.toBeInTheDocument());
    expect(screen.getByText('keep.md')).toBeInTheDocument();
  });

  // --- Advanced filter + sort interactions (applyAdvancedFilters / sortFiles) ---

  it('source filter narrows the displayed files to the selected upload source', async () => {
    mocks.listLibraryFiles.mockResolvedValue(
      page([
        makeFile({ id: 'f1', filename: 'human-note.txt', uploadSource: 'user' }),
        makeFile({ id: 'f2', filename: 'agent-report.json', uploadSource: 'agent' }),
      ]),
    );

    renderLibrary();

    await waitFor(() => expect(screen.getByText('human-note.txt')).toBeInTheDocument());
    expect(screen.getByText('agent-report.json')).toBeInTheDocument();

    // Open the filter panel and restrict to agent-uploaded files.
    await userEvent.click(screen.getByRole('button', { name: 'Toggle filters' }));
    await userEvent.click(screen.getByRole('button', { name: 'Show only agent-uploaded files' }));

    // The user file is filtered out; the agent file remains.
    await waitFor(() => expect(screen.queryByText('human-note.txt')).not.toBeInTheDocument());
    expect(screen.getByText('agent-report.json')).toBeInTheDocument();
    expect(screen.getAllByText(/1 file/).length).toBeGreaterThanOrEqual(1);
    // No server round-trip — filtering is served from the client index.
    expect(mocks.listLibraryFiles).toHaveBeenCalledTimes(1);
  });

  it('tag filter narrows the displayed files to those carrying the selected tag', async () => {
    mocks.listLibraryFiles.mockResolvedValue(
      page([
        makeFile({
          id: 'f1',
          filename: 'spec.md',
          tags: [{ fileId: 'f1', tag: 'docs', tagSource: 'user' }],
        }),
        makeFile({ id: 'f2', filename: 'photo.png', mimeType: 'image/png' }),
      ]),
    );

    renderLibrary();

    await waitFor(() => expect(screen.getByText('spec.md')).toBeInTheDocument());
    expect(screen.getByText('photo.png')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Toggle filters' }));
    await userEvent.click(screen.getByRole('button', { name: 'Filter by tag: docs' }));

    // Only the tagged file survives the filter.
    await waitFor(() => expect(screen.queryByText('photo.png')).not.toBeInTheDocument());
    expect(screen.getByText('spec.md')).toBeInTheDocument();
    expect(mocks.listLibraryFiles).toHaveBeenCalledTimes(1);
  });

  it('changing the sort dropdown reorders the unfiltered file list', async () => {
    // Distinct sizes + names so createdAt (default), name, and size orders differ.
    mocks.listLibraryFiles.mockResolvedValue(
      page([
        makeFile({ id: 'f1', filename: 'zebra.txt', sizeBytes: 10, createdAt: '2026-04-03T00:00:00Z' }),
        makeFile({ id: 'f2', filename: 'apple.txt', sizeBytes: 30, createdAt: '2026-04-02T00:00:00Z' }),
        makeFile({ id: 'f3', filename: 'mango.txt', sizeBytes: 20, createdAt: '2026-04-01T00:00:00Z' }),
      ]),
    );

    renderLibrary();

    await waitFor(() => expect(screen.getByText('zebra.txt')).toBeInTheDocument());

    const filenamesInOrder = () =>
      screen
        .getAllByText(/\.txt$/)
        .map((el) => el.textContent)
        .filter((t): t is string => t !== null);

    // Default sort is newest-first by createdAt: zebra (04-03) → apple (04-02) → mango (04-01).
    expect(filenamesInOrder()).toEqual(['zebra.txt', 'apple.txt', 'mango.txt']);

    // Switch to name order — alphabetical ascending.
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Sort by' }), 'filename');
    await waitFor(() => expect(filenamesInOrder()).toEqual(['apple.txt', 'mango.txt', 'zebra.txt']));
  });

  // --- Over-cap server fallback --------------------------------------------

  it('falls back to the server-search path when the project exceeds the sweep cap', async () => {
    // Sweep reports an over-cap total; the page then loads via the server path.
    mocks.listLibraryFiles
      .mockResolvedValueOnce(page([], 400))
      .mockResolvedValue(page([makeFile({ id: 's1', filename: 'server-file.txt' })], 400));

    renderLibrary();

    await waitFor(() => expect(screen.getByText('server-file.txt')).toBeInTheDocument());

    // A server query with paging filters was issued (the fallback path).
    await waitFor(() => {
      const last = mocks.listLibraryFiles.mock.calls.at(-1)![1] as Record<string, unknown>;
      expect(last).toMatchObject({ directory: '/' });
      expect(last.limit).toBeDefined();
    });
  });
});
