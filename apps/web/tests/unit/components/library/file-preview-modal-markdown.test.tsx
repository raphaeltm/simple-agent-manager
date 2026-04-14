import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FilePreviewModal } from '../../../../src/components/library/FilePreviewModal';
import type { FileWithTags } from '../../../../src/components/library/types';

// Mock mermaid to avoid DOM rendering issues in test env
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg></svg>' }),
  },
}));

const MARKDOWN_CONTENT = `# Hello World

This is **bold** and *italic*.

## Code Block

\`\`\`typescript
const x = 42;
\`\`\`

| Column A | Column B |
|----------|----------|
| Cell 1   | Cell 2   |
`;

function makeMarkdownFile(overrides?: Partial<FileWithTags>): FileWithTags {
  return {
    id: 'file-1',
    projectId: 'proj-1',
    filename: 'readme.md',
    directory: '/',
    mimeType: 'text/markdown',
    sizeBytes: MARKDOWN_CONTENT.length,
    status: 'ready',
    uploadSource: 'user',
    uploadSessionId: null,
    uploadTaskId: null,
    extractedTextPreview: null,
    description: null,
    r2Key: 'files/file-1',
    encryptionKeyVersion: 1,
    replacedAt: null,
    replacedBy: null,
    createdAt: '2026-04-14T00:00:00Z',
    updatedAt: '2026-04-14T00:00:00Z',
    tags: [],
    ...overrides,
  };
}

describe('FilePreviewModal — Markdown', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(MARKDOWN_CONTENT, { status: 200 }),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    document.body.style.overflow = '';
  });

  it('fetches and renders markdown content', async () => {
    const file = makeMarkdownFile();
    render(
      <FilePreviewModal
        file={file}
        previewUrl="https://api.example.com/preview"
        onClose={vi.fn()}
        onDownload={vi.fn()}
      />,
    );

    // Should show loading spinner initially
    // Wait for content to load
    await waitFor(() => {
      expect(screen.getByTestId('rendered-markdown')).toBeInTheDocument();
    });

    // Should fetch with credentials
    expect(fetchSpy).toHaveBeenCalledWith('https://api.example.com/preview', {
      credentials: 'include',
    });

    // Rendered markdown should display the heading
    expect(screen.getByText('Hello World')).toBeInTheDocument();
  });

  it('shows rendered/source toggle buttons after content loads', async () => {
    const file = makeMarkdownFile();
    render(
      <FilePreviewModal
        file={file}
        previewUrl="https://api.example.com/preview"
        onClose={vi.fn()}
        onDownload={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('rendered-markdown')).toBeInTheDocument();
    });

    const renderedBtn = screen.getByRole('button', { name: 'Rendered view' });
    const sourceBtn = screen.getByRole('button', { name: 'Source view' });
    expect(renderedBtn).toBeInTheDocument();
    expect(sourceBtn).toBeInTheDocument();

    // Rendered should be active by default
    expect(renderedBtn).toHaveAttribute('aria-pressed', 'true');
    expect(sourceBtn).toHaveAttribute('aria-pressed', 'false');
  });

  it('toggles between rendered and source views', async () => {
    const user = userEvent.setup();
    const file = makeMarkdownFile();
    render(
      <FilePreviewModal
        file={file}
        previewUrl="https://api.example.com/preview"
        onClose={vi.fn()}
        onDownload={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('rendered-markdown')).toBeInTheDocument();
    });

    // Switch to source view
    await user.click(screen.getByRole('button', { name: 'Source view' }));

    // Rendered markdown should no longer be visible; source code should be
    expect(screen.queryByTestId('rendered-markdown')).not.toBeInTheDocument();
    // Source view uses SyntaxHighlightedCode which splits text into tokens,
    // so check for the raw content in the container rather than by text query
    const sourceContainer = document.querySelector('pre');
    expect(sourceContainer).toBeTruthy();
    expect(sourceContainer!.textContent).toContain('# Hello World');

    // Switch back to rendered view
    await user.click(screen.getByRole('button', { name: 'Rendered view' }));
    expect(screen.getByTestId('rendered-markdown')).toBeInTheDocument();
  });

  it('shows error state when fetch fails', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 500 }));

    const file = makeMarkdownFile();
    render(
      <FilePreviewModal
        file={file}
        previewUrl="https://api.example.com/preview"
        onClose={vi.fn()}
        onDownload={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Unable to load markdown preview/)).toBeInTheDocument();
    });
  });

  it('does not show toggle buttons for non-markdown files', () => {
    const file = makeMarkdownFile({ mimeType: 'image/png', filename: 'photo.png' });
    render(
      <FilePreviewModal
        file={file}
        previewUrl="https://example.com/preview"
        onClose={vi.fn()}
        onDownload={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Rendered view' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Source view' })).not.toBeInTheDocument();
  });

  it('closes on Escape key', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const file = makeMarkdownFile();
    render(
      <FilePreviewModal
        file={file}
        previewUrl="https://api.example.com/preview"
        onClose={onClose}
        onDownload={vi.fn()}
      />,
    );

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});
