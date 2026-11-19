/**
 * Behavioural tests for "where this file came from", against the REAL `FilePreviewModal`.
 *
 * The disclosure is opened by clicking its own button, not by setting state, and the strip's
 * absence is always asserted alongside something positive that proves the preview rendered
 * (`.claude/rules/62-tests-must-observe-the-real-trigger.md`).
 */
import type { FileContext } from '@simple-agent-manager/shared';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FilePreviewModal } from '../../../../src/components/library/FilePreviewModal';
import type { FileWithTags } from '../../../../src/components/library/types';
import { renderWithPreviewProviders as render } from '../../../helpers/preview-providers';

const mockGetLibraryFileLinks = vi.fn();

vi.mock('../../../../src/lib/api/links', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/lib/api/links')>()),
  getLibraryFileLinks: (...args: unknown[]) => mockGetLibraryFileLinks(...args),
}));

vi.mock('../../../../src/components/AuthProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/components/AuthProvider')>()),
  useAuth: () => ({ user: { id: 'user-1' }, isSuperadmin: false, isLoading: false }),
}));

vi.mock('../../../../src/hooks/useScrollLock', () => ({ useScrollLock: () => undefined }));

vi.mock('../../../../src/components/MarkdownRenderer', () => ({
  RenderedMarkdown: ({ content }: { content: string }) => (
    <div data-testid="rendered-markdown">{content}</div>
  ),
  SyntaxHighlightedCode: ({ content }: { content: string }) => <pre>{content}</pre>,
}));

const PROJECT_ID = 'proj-1';
const FILE_ID = 'file-1';

function cappedList<T>(
  items: T[],
  overrides: Partial<{ total: number; truncated: boolean; totalIsLowerBound: boolean }> = {}
) {
  return {
    items,
    total: overrides.total ?? items.length,
    truncated: overrides.truncated ?? false,
    totalIsLowerBound: overrides.totalIsLowerBound ?? false,
  };
}

function emptyContext(): FileContext {
  return { sessions: cappedList([]), ideas: cappedList([]) };
}

function richContext(): FileContext {
  return {
    sessions: cappedList([
      {
        sessionId: 'cs-reader',
        topic: 'Review the privacy preference',
        status: 'active',
        relations: ['viewed'],
        lastActivityAt: 200,
        taskId: null,
      },
      {
        sessionId: 'cs-author',
        topic: 'Write the research report',
        status: 'completed',
        relations: ['uploaded'],
        lastActivityAt: 100,
        taskId: 'task-author',
      },
    ]),
    ideas: cappedList([
      { ideaId: 'idea-1', title: 'Agent observability', status: 'draft', relations: ['linked'] },
    ]),
  };
}

function makeFile(overrides: Partial<FileWithTags> = {}): FileWithTags {
  return {
    id: FILE_ID,
    projectId: PROJECT_ID,
    filename: 'report.md',
    mimeType: 'text/markdown',
    sizeBytes: 42,
    tags: [],
    ...overrides,
  } as FileWithTags;
}

const noop = () => undefined;

function renderPreview() {
  return render(
    <FilePreviewModal
      projectId={PROJECT_ID}
      file={makeFile()}
      previewUrl="https://api.test/preview/file-1"
      onClose={noop}
      onDownload={noop}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('# Report') })
  );
  mockGetLibraryFileLinks.mockResolvedValue(richContext());
});

describe('library file preview — where this file came from', () => {
  it('reads the file its own id and says who produced it, collapsed', async () => {
    renderPreview();

    const toggle = await screen.findByTestId('file-linked-work-toggle');
    expect(mockGetLibraryFileLinks.mock.calls[0]?.slice(0, 2)).toEqual([PROJECT_ID, FILE_ID]);
    // The uploading chat leads, even though another chat is more recently active.
    expect(toggle).toHaveTextContent('Uploaded by Write the research report');
    // The tail survives truncation as its own element, because it is what says expanding helps.
    expect(toggle).toHaveTextContent('1 more chat');
    expect(toggle).toHaveTextContent('1 idea');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // Collapsed means collapsed: no rows yet.
    expect(screen.queryByTestId('file-linked-chat')).toBeNull();
  });

  it('expands through its own button to every chat and idea', async () => {
    renderPreview();
    fireEvent.click(await screen.findByTestId('file-linked-work-toggle'));

    expect(screen.getByTestId('file-linked-work-toggle')).toHaveAttribute('aria-expanded', 'true');
    const chats = await screen.findAllByTestId('file-linked-chat');
    expect(chats).toHaveLength(2);
    expect(chats[0]).toHaveTextContent('Write the research report');
    expect(chats[0]).toHaveTextContent('Uploaded');
    expect(chats[0]).toHaveAttribute('href', `/projects/${PROJECT_ID}/chat/cs-author`);
    expect(chats[1]).toHaveTextContent('Review the privacy preference');
    expect(chats[1]).toHaveTextContent('Viewed');

    const ideas = screen.getAllByTestId('file-linked-idea');
    expect(ideas).toHaveLength(1);
    expect(ideas[0]).toHaveTextContent('Agent observability');
    expect(ideas[0]).toHaveAttribute('href', `/projects/${PROJECT_ID}/ideas/idea-1`);
  });

  it('collapses again on a second click', async () => {
    renderPreview();
    const toggle = await screen.findByTestId('file-linked-work-toggle');
    fireEvent.click(toggle);
    expect(await screen.findAllByTestId('file-linked-chat')).toHaveLength(2);
    fireEvent.click(toggle);
    expect(screen.queryByTestId('file-linked-chat')).toBeNull();
  });

  it('grows no strip for a file with nothing linked', async () => {
    mockGetLibraryFileLinks.mockResolvedValue(emptyContext());
    renderPreview();

    // Positive control: the preview itself rendered, and the read completed.
    expect(await screen.findByTestId('rendered-markdown')).toBeInTheDocument();
    await waitFor(() => expect(mockGetLibraryFileLinks).toHaveBeenCalled());
    expect(screen.queryByTestId('file-linked-work')).toBeNull();
  });

  it('grows no strip when the read fails, rather than an error banner over the preview', async () => {
    mockGetLibraryFileLinks.mockRejectedValue(new Error('boom'));
    renderPreview();

    expect(await screen.findByTestId('rendered-markdown')).toBeInTheDocument();
    await waitFor(() => expect(mockGetLibraryFileLinks).toHaveBeenCalled());
    expect(screen.queryByTestId('file-linked-work')).toBeNull();
  });

  it('shows a file linked only to an idea with an honest phrase', async () => {
    mockGetLibraryFileLinks.mockResolvedValue({
      sessions: cappedList([]),
      ideas: cappedList([
        { ideaId: 'idea-2', title: 'A standing plan', status: 'draft', relations: ['linked'] },
      ]),
    });
    renderPreview();

    const toggle = await screen.findByTestId('file-linked-work-toggle');
    // No chat produced it, so it does not claim one.
    expect(toggle).toHaveTextContent('Linked work');
    expect(toggle).toHaveTextContent('1 idea');
    fireEvent.click(toggle);
    expect(await screen.findByTestId('file-linked-idea')).toHaveTextContent('A standing plan');
    expect(screen.queryByTestId('file-linked-chat')).toBeNull();
  });

  it('reports a bounded count as "N+"', async () => {
    mockGetLibraryFileLinks.mockResolvedValue({
      sessions: cappedList(richContext().sessions.items, {
        total: 2,
        truncated: true,
        totalIsLowerBound: true,
      }),
      ideas: cappedList([]),
    });
    renderPreview();
    fireEvent.click(await screen.findByTestId('file-linked-work-toggle'));
    expect(await screen.findByText('2+')).toBeInTheDocument();
  });

  it('labels an untitled chat rather than leaving the line blank', async () => {
    mockGetLibraryFileLinks.mockResolvedValue({
      sessions: cappedList([
        {
          sessionId: 'cs-untitled',
          topic: null,
          status: 'sleeping',
          relations: ['uploaded'],
          lastActivityAt: null,
          taskId: null,
        },
      ]),
      ideas: cappedList([]),
    });
    renderPreview();
    expect(await screen.findByTestId('file-linked-work-toggle')).toHaveTextContent(
      'Uploaded by Untitled chat'
    );
  });
});
