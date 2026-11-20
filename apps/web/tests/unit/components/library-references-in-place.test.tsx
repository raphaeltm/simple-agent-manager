/**
 * Every kind of Library reference outside the inbox opens the file in place: a markdown link in a
 * chat message or inbox body, an idea's Related row, and a workflow step's output chip. The inbox
 * chip itself is covered end to end in `tests/unit/pages/inbox-library-preview.test.tsx`.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { FileText } from 'lucide-react';
import type { ReactNode } from 'react';
import { MemoryRouter, Outlet, Route, Routes, useLocation } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/components/AuthProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/components/AuthProvider')>()),
  useAuth: () => ({ user: { id: 'user-1' }, isSuperadmin: false, isLoading: false }),
}));

const { LibraryPreviewProvider, LIBRARY_PREVIEW_STATE_KEY } =
  await import('../../../src/components/library/LibraryPreviewProvider');
const { RenderedMarkdown } = await import('../../../src/components/MarkdownRenderer');
const { LinkedWorkRow } = await import('../../../src/components/linked-work');
const { OutputChip } = await import('../../../src/pages/automation/workflows/ui');
const { artifactLink } = await import('../../../src/pages/automation/workflows/links');
const { parseLibraryFileHref } = await import('../../../src/lib/project-routes');

let location = { pathname: '', search: '', state: null as unknown };
function Probe() {
  const current = useLocation();
  location = { pathname: current.pathname, search: current.search, state: current.state };
  return null;
}

function renderInPlace(ui: ReactNode, withProvider = true) {
  // Metadata never resolves: these tests are about where the click goes, not the viewer.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => undefined))
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Layout = () =>
    withProvider ? (
      <LibraryPreviewProvider>
        <Outlet />
        <Probe />
      </LibraryPreviewProvider>
    ) : (
      <>
        <Outlet />
        <Probe />
      </>
    );
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/projects/p1/chat/s1']}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/projects/:id/chat/:sessionId" element={ui} />
            <Route path="*" element={<h1>Elsewhere</h1>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const openedPreview = () =>
  (location.state as Record<string, unknown> | null)?.[LIBRARY_PREVIEW_STATE_KEY];

describe('markdown links to Library files', () => {
  it('a relative Library link in a message opens the preview in place', async () => {
    renderInPlace(
      <RenderedMarkdown content="See [the plan](/projects/p1/library?preview=F9&commentThread=t2)." />
    );
    const link = screen.getByRole('link', { name: 'the plan' });
    expect(link).not.toHaveAttribute('target');

    fireEvent.click(link);

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(location.pathname).toBe('/projects/p1/chat/s1');
    expect(openedPreview()).toMatchObject({ projectId: 'p1', fileId: 'F9', commentThreadId: 't2' });
  });

  it('an absolute Library link on this app opens in place too', async () => {
    renderInPlace(
      <RenderedMarkdown
        content={`[report](${window.location.origin}/projects/p1/library?preview=F3)`}
      />
    );
    fireEvent.click(screen.getByRole('link', { name: 'report' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(openedPreview()).toMatchObject({ fileId: 'F3' });
  });

  it('other links still open in a new tab', () => {
    renderInPlace(
      <RenderedMarkdown content="[docs](https://example.com/projects/p1/library?preview=F3) and [chat](/projects/p1/chat/s2)" />
    );
    expect(screen.getByRole('link', { name: 'docs' })).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('link', { name: 'chat' })).toHaveAttribute('target', '_blank');
    // Liveness: the paragraph rendered, so the absence of a dialog is not a blank render.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('outside the provider a Library link is a plain new-tab link', () => {
    renderInPlace(<RenderedMarkdown content="[plan](/projects/p1/library?preview=F9)" />, false);
    expect(screen.getByRole('link', { name: 'plan' })).toHaveAttribute('target', '_blank');
  });
});

describe('Related rows and workflow outputs', () => {
  it("an idea's Related file row opens the preview in place", async () => {
    renderInPlace(
      <LinkedWorkRow
        icon={FileText}
        accent="var(--sam-color-fg-muted)"
        title="retry-schedules.md"
        libraryFile={{ projectId: 'p1', fileId: 'file-1', filename: 'retry-schedules.md' }}
      />
    );
    const row = screen.getByRole('link', { name: /retry-schedules\.md/ });
    expect(row).toHaveAttribute('href', '/projects/p1/library?preview=file-1');

    fireEvent.click(row);

    expect(await screen.findByRole('dialog', { name: 'retry-schedules.md' })).toBeInTheDocument();
    expect(location.pathname).toBe('/projects/p1/chat/s1');
  });

  it("a workflow step's Library output opens the preview in place", async () => {
    const link = artifactLink({ type: 'library_file', ref: '01M5H0Z9X1Y2Z3A4B5C6D7E8F9' }, 'p1');
    renderInPlace(<OutputChip link={link} />);

    fireEvent.click(screen.getByRole('link', { name: /Library file/ }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(location.pathname).toBe('/projects/p1/chat/s1');
    expect(openedPreview()).toMatchObject({ fileId: '01M5H0Z9X1Y2Z3A4B5C6D7E8F9' });
  });
});

describe('parseLibraryFileHref', () => {
  const origin = 'https://app.example.org';
  it('reads the file, project and thread from a Library preview link', () => {
    expect(
      parseLibraryFileHref('/projects/p%201/library?preview=F1&commentThread=t1', origin)
    ).toEqual({ projectId: 'p 1', fileId: 'F1', commentThreadId: 't1' });
    expect(parseLibraryFileHref(`${origin}/projects/p1/library?preview=F1`, origin)).toEqual({
      projectId: 'p1',
      fileId: 'F1',
      commentThreadId: null,
    });
  });

  it('rejects other origins, other pages and links without a file', () => {
    expect(
      parseLibraryFileHref('https://evil.example/projects/p1/library?preview=F1', origin)
    ).toBe(null);
    expect(parseLibraryFileHref('/projects/p1/library', origin)).toBeNull();
    expect(parseLibraryFileHref('/projects/p1/ideas?preview=F1', origin)).toBeNull();
    expect(parseLibraryFileHref('/projects/p1/library/x?preview=F1', origin)).toBeNull();
    expect(parseLibraryFileHref('/projects/%E0%A4%A/library?preview=F1', origin)).toBeNull();
  });
});
