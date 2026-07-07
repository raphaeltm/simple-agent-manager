import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/api', () => ({
  getRepoBranches: vi.fn().mockResolvedValue({
    branches: [
      { name: 'main', isDefault: true },
      { name: 'feat', isDefault: false },
    ],
    truncated: false,
  }),
  getRepoTree: vi.fn().mockResolvedValue({
    ref: 'main',
    path: '',
    truncated: false,
    entries: [
      { path: 'src', name: 'src', type: 'tree', size: null },
      { path: 'src/a.ts', name: 'a.ts', type: 'blob', size: 5 },
      { path: 'README.md', name: 'README.md', type: 'blob', size: 10 },
    ],
  }),
  getRepoFile: vi.fn().mockResolvedValue({
    ref: 'main', path: 'README.md', size: 10, isBinary: false, tooLarge: false,
    content: 'Hello from README', rawUrl: null,
  }),
  getRepoCompare: vi.fn().mockResolvedValue({
    base: 'main', head: 'feat',
    files: [
      { path: 'src/a.ts', status: 'modified', additions: 2, deletions: 1, patch: '@@ -1 +1 @@\n+added line', patchTruncated: false, isBinary: false },
    ],
    totalAdditions: 2, totalDeletions: 1, filesChanged: 1, truncated: false,
  }),
  repoRawUrl: vi.fn().mockReturnValue('http://localhost/raw'),
}));

vi.mock('../../src/components/shared-file-viewer', () => ({
  DiffRenderer: ({ diff }: { diff: string }) => <pre data-testid="diff">{diff}</pre>,
  ImageViewer: () => <div data-testid="image" />,
}));
vi.mock('../../src/components/MarkdownRenderer', () => ({
  CODE_THEME_BG: '#000',
  RenderedMarkdown: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
  SyntaxHighlightedCode: ({ content }: { content: string }) => <pre data-testid="code">{content}</pre>,
}));

import { ProjectFiles } from '../../src/pages/ProjectFiles';

function renderFiles() {
  return render(
    <MemoryRouter initialEntries={['/projects/p1/files']}>
      <Routes>
        <Route path="/projects/:id/files" element={<ProjectFiles />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('ProjectFiles', () => {
  it('defaults to Browse on the default branch and lists top-level entries', async () => {
    renderFiles();
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Browse' })).toHaveAttribute('aria-selected', 'true'));
    // Changes tab is disabled on the default branch
    expect(screen.getByRole('tab', { name: 'Changes' })).toBeDisabled();
    expect(await screen.findByText('src')).toBeInTheDocument();
    expect(screen.getByText('README.md')).toBeInTheDocument();
  });

  it('opens a file and renders its content (markdown rendered)', async () => {
    const user = userEvent.setup();
    renderFiles();
    const readme = await screen.findByText('README.md');
    await user.click(readme);
    expect(await screen.findByTestId('md')).toHaveTextContent('Hello from README');
  });

  it('fuzzy-searches files by name', async () => {
    const user = userEvent.setup();
    renderFiles();
    await screen.findByText('README.md');
    await user.type(screen.getByRole('searchbox', { name: /search files/i }), 'a.ts');
    expect(await screen.findByText('src/a.ts')).toBeInTheDocument();
  });

  it('selecting a non-default branch switches to Changes mode and shows the diff', async () => {
    const user = userEvent.setup();
    renderFiles();
    const select = await screen.findByRole('combobox', { name: 'Branch' });
    await user.selectOptions(select, 'feat');
    // Changes mode: summary + changed file + diff
    expect(await screen.findByText(/1 file changed/i)).toBeInTheDocument();
    const fileRow = await screen.findByRole('button', { name: /src\/a\.ts/ });
    await user.click(fileRow);
    expect(await screen.findByTestId('diff')).toHaveTextContent('added line');
  });

  it('shows an empty-changes message when a branch has no diff vs base', async () => {
    const api = await import('../../src/lib/api');
    (api.getRepoCompare as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      base: 'main', head: 'feat', files: [], totalAdditions: 0, totalDeletions: 0, filesChanged: 0, truncated: false,
    });
    const user = userEvent.setup();
    renderFiles();
    const select = await screen.findByRole('combobox', { name: 'Branch' });
    await user.selectOptions(select, 'feat');
    expect(await screen.findByText(/up to date with/i)).toBeInTheDocument();
  });
});
