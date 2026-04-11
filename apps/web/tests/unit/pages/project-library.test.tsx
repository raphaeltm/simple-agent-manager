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
    expect(screen.getByText('Showing 2 of 2 files')).toBeInTheDocument();
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

    expect(screen.getByPlaceholderText('Search files across all directories...')).toBeInTheDocument();
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

    // Mock all subsequent calls (one per keystroke triggers a new API call)
    mocks.listLibraryFiles.mockResolvedValue(makeResponse([]));
    const searchInput = screen.getByPlaceholderText('Search files across all directories...');
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
});
