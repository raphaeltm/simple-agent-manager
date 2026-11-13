/**
 * Commented words in a library markdown file: open threads' quotes are painted on the rendered
 * file, clicking them opens the comments panel on that thread, and a comment deep link opens
 * the file with its panel on the thread. Rendered through the real preview modal; only the
 * network (comments API, the file's text) and the markdown renderer are replaced.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LibraryFileCommentThread } from '../../../src/lib/api/comments';
import { renderWithPreviewProviders as render } from '../../helpers/preview-providers';
import { type HighlightStubs, POINTER, stubCssHighlights } from '../../test-utils/css-highlights';

const mocks = vi.hoisted(() => ({ listLibraryFileComments: vi.fn() }));

vi.mock('../../../src/lib/api/comments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api/comments')>()),
  listLibraryFileComments: mocks.listLibraryFileComments,
}));

vi.mock('../../../src/components/AuthProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/components/AuthProvider')>()),
  useAuth: () => ({ user: { id: 'user-1', name: 'Ada' }, isSuperadmin: false, isLoading: false }),
}));

vi.mock('../../../src/hooks/useQueryScope', () => ({ useQueryScope: () => 'user-1' }));

vi.mock('../../../src/lib/api/links', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api/links')>()),
  getLibraryFileLinks: vi.fn().mockResolvedValue({
    sessions: { items: [], total: 0, truncated: false, totalIsLowerBound: false },
    ideas: { items: [], total: 0, truncated: false, totalIsLowerBound: false },
  }),
}));

vi.mock('../../../src/components/MarkdownRenderer', () => ({
  RenderedMarkdown: ({ content }: { content: string }) => (
    <div data-testid="rendered-markdown">
      {content.split('\n\n').map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
    </div>
  ),
  SyntaxHighlightedCode: ({ content }: { content: string }) => (
    <pre data-testid="md-source">{content}</pre>
  ),
}));

vi.mock('../../../src/hooks/useScrollLock', () => ({ useScrollLock: () => undefined }));

vi.mock('@simple-agent-manager/acp-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@simple-agent-manager/acp-client')>()),
  VoiceButton: () => null,
}));

import { FilePreviewModal } from '../../../src/components/library/FilePreviewModal';
import type { FileWithTags } from '../../../src/components/library/types';

const MARKDOWN = 'Rollout starts on Monday.\n\nEvery region gets the new build within a week.';

function thread(overrides: Partial<LibraryFileCommentThread>): LibraryFileCommentThread {
  return {
    id: 'thread',
    clientId: null,
    projectId: 'proj-1',
    fileId: 'f-1',
    anchor: { kind: 'library_file', fileId: 'f-1', quote: null },
    author: { id: 'user-2', name: 'Grace Hopper', kind: 'human' },
    body: 'A comment',
    createdAt: 1_000,
    updatedAt: 1_000,
    status: 'open',
    replies: [],
    ...overrides,
  };
}

const OPEN = thread({
  id: 'open',
  anchor: { kind: 'library_file', fileId: 'f-1', quote: 'within a week' },
  body: 'Too slow?',
});
const RESOLVED = thread({
  id: 'resolved',
  anchor: { kind: 'library_file', fileId: 'f-1', quote: 'starts on Monday' },
  body: 'Confirmed.',
  status: 'resolved',
});

const FILE = {
  id: 'f-1',
  projectId: 'proj-1',
  filename: 'rollout.md',
  mimeType: 'text/markdown',
  sizeBytes: MARKDOWN.length,
  tags: [],
} as unknown as FileWithTags;

function renderPreview(initialCommentThreadId?: string) {
  return render(
    <FilePreviewModal
      projectId="proj-1"
      file={FILE}
      previewUrl="https://api.test/preview/f-1"
      onClose={() => undefined}
      onDownload={() => undefined}
      initialCommentThreadId={initialCommentThreadId}
    />
  );
}

function focusedThreadText() {
  return document.querySelector('[data-comment-focused="true"]')?.textContent ?? null;
}

let highlights: HighlightStubs;

beforeEach(() => {
  vi.clearAllMocks();
  highlights = stubCssHighlights();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve(MARKDOWN) })
  );
  mocks.listLibraryFileComments.mockResolvedValue({ threads: [OPEN, RESOLVED], hasMore: false });
});

afterEach(() => {
  highlights.restore();
});

describe('library markdown comment quotes', () => {
  it('paints open comments’ quotes on the rendered file, without opening the panel', async () => {
    renderPreview();

    await waitFor(() => expect(highlights.otherQuotes()).toEqual(['within a week']));
    expect(highlights.activeQuotes()).toEqual([]);
    expect(screen.queryByRole('complementary', { name: 'File comments' })).toBeNull();
    // Liveness: the file rendered.
    expect(screen.getByText('Rollout starts on Monday.')).toBeTruthy();
  });

  it('opens the comments panel on the thread whose words were clicked', async () => {
    renderPreview();
    await waitFor(() => expect(highlights.otherQuotes()).toEqual(['within a week']));

    highlights.pointerOver('within a week');
    fireEvent.click(screen.getByText(/Every region/), POINTER);

    expect(await screen.findByRole('complementary', { name: 'File comments' })).toBeTruthy();
    await waitFor(() => expect(focusedThreadText()).toContain('Too slow?'));
    await waitFor(() => expect(highlights.activeQuotes()).toEqual(['within a week']));
  });

  it('ignores clicks on words no open comment is about', async () => {
    renderPreview();
    await waitFor(() => expect(highlights.otherQuotes()).toHaveLength(1));

    highlights.pointerOver('starts on Monday');
    fireEvent.click(screen.getByText('Rollout starts on Monday.'), POINTER);

    expect(screen.queryByRole('complementary', { name: 'File comments' })).toBeNull();
  });

  it('opens a comment deep link with the panel on its thread, resolved or not', async () => {
    renderPreview('resolved');

    expect(await screen.findByRole('complementary', { name: 'File comments' })).toBeTruthy();
    await waitFor(() => expect(focusedThreadText()).toContain('Confirmed.'));
    await waitFor(() => expect(highlights.activeQuotes()).toEqual(['starts on Monday']));
    expect(highlights.otherQuotes()).toEqual(['within a week']);
  });

  it('paints nothing over the markdown source', async () => {
    renderPreview();
    await waitFor(() => expect(highlights.otherQuotes()).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: 'Source view' }));

    expect(await screen.findByTestId('md-source')).toBeTruthy();
    await waitFor(() => expect(highlights.otherQuotes()).toEqual([]));
  });

  it('stops painting when the preview closes', async () => {
    const { unmount } = renderPreview();
    await waitFor(() => expect(highlights.otherQuotes()).toHaveLength(1));

    unmount();

    expect(highlights.registry.size).toBe(0);
  });

  it('brings a deep-linked comment’s words on screen once the file has loaded', async () => {
    // jsdom has no layout: give the preview pane one, with the quoted words 1500px down it.
    const original = Range.prototype.getBoundingClientRect;
    let pane: HTMLElement | null = null;
    Range.prototype.getBoundingClientRect = function getBoundingClientRect() {
      const top = 1500 - (pane?.scrollTop ?? 0);
      return {
        top,
        bottom: top + 20,
        left: 0,
        right: 100,
        width: 100,
        height: 20,
        x: 0,
        y: top,
        toJSON: () => ({}),
      };
    };
    try {
      renderPreview('open');
      pane = screen.getByRole('region', { name: 'Preview of rollout.md' });
      pane.style.overflowY = 'auto';
      Object.defineProperty(pane, 'scrollHeight', { configurable: true, value: 3000 });
      Object.defineProperty(pane, 'clientHeight', { configurable: true, value: 500 });
      pane.getBoundingClientRect = () =>
        ({
          top: 0,
          bottom: 500,
          left: 0,
          right: 100,
          width: 100,
          height: 500,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect;

      await waitFor(() => expect(highlights.activeQuotes()).toEqual(['within a week']));
      await waitFor(() => expect(pane?.scrollTop).toBe(1500 - 500 * 0.3));
    } finally {
      Range.prototype.getBoundingClientRect = original;
    }
  });

  it('clicking a comment’s words opens it without moving the file', async () => {
    const original = Range.prototype.getBoundingClientRect;
    Range.prototype.getBoundingClientRect = () =>
      ({
        top: 1500,
        bottom: 1520,
        left: 0,
        right: 100,
        width: 100,
        height: 20,
        x: 0,
        y: 1500,
        toJSON: () => ({}),
      }) as DOMRect;
    try {
      renderPreview();
      const pane = screen.getByRole('region', { name: 'Preview of rollout.md' });
      pane.style.overflowY = 'auto';
      Object.defineProperty(pane, 'scrollHeight', { configurable: true, value: 3000 });
      Object.defineProperty(pane, 'clientHeight', { configurable: true, value: 500 });

      // Clicking the words opens their thread without moving the file.
      await waitFor(() => expect(highlights.otherQuotes()).toEqual(['within a week']));
      highlights.pointerOver('within a week');
      fireEvent.pointerDown(screen.getByText(/Every region/), { ...POINTER, pointerType: 'touch' });
      fireEvent.click(screen.getByText(/Every region/), POINTER);
      await waitFor(() => expect(focusedThreadText()).toContain('Too slow?'));
      expect(pane.scrollTop).toBe(0);
    } finally {
      Range.prototype.getBoundingClientRect = original;
    }
  });
});
