import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FilePreviewModal } from '../../../../src/components/library/FilePreviewModal';
import type { FileWithTags } from '../../../../src/components/library/types';
import { FILE_PREVIEW_LOAD_MAX_BYTES } from '../../../../src/lib/file-utils';

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

const HTML_CONTENT = `<!doctype html>
<html>
  <body>
    <button id="run">Run</button>
    <script>window.__ran = true;</script>
  </body>
</html>`;

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
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(MARKDOWN_CONTENT, { status: 200 }));
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
      />
    );

    // Wait for content to load
    await waitFor(() => {
      expect(screen.getByTestId('rendered-markdown')).toBeInTheDocument();
    });

    // Should fetch with credentials and abort signal
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.example.com/preview',
      expect.objectContaining({
        credentials: 'include',
      })
    );

    // Rendered markdown should display the heading
    expect(screen.getByText('Hello World')).toBeInTheDocument();

    // GFM table should render as a <table> element
    expect(document.querySelector('table')).toBeTruthy();
    expect(screen.getByText('Column A')).toBeInTheDocument();

    // Code block should render with syntax highlighting
    expect(document.querySelector('pre')).toBeTruthy();
  });

  it('shows rendered/source toggle buttons after content loads', async () => {
    const file = makeMarkdownFile();
    render(
      <FilePreviewModal
        file={file}
        previewUrl="https://api.example.com/preview"
        onClose={vi.fn()}
        onDownload={vi.fn()}
      />
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
      />
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
      />
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
      />
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
      />
    );

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('renders ImageViewer for image files (regression)', () => {
    const file = makeMarkdownFile({
      mimeType: 'image/png',
      filename: 'photo.png',
      sizeBytes: 1024,
    });
    render(
      <FilePreviewModal
        file={file}
        previewUrl="https://example.com/preview/photo.png"
        onClose={vi.fn()}
        onDownload={vi.fn()}
      />
    );

    // ImageViewer renders an img element (portaled to document.body)
    const img = document.querySelector('img');
    expect(img).toBeTruthy();
    // No markdown content should be rendered
    expect(screen.queryByTestId('rendered-markdown')).not.toBeInTheDocument();
  });

  it('renders PDF iframe for PDF files (regression)', () => {
    const file = makeMarkdownFile({
      mimeType: 'application/pdf',
      filename: 'doc.pdf',
      sizeBytes: 2048,
    });
    render(
      <FilePreviewModal
        file={file}
        previewUrl="https://example.com/preview/doc.pdf"
        onClose={vi.fn()}
        onDownload={vi.fn()}
      />
    );

    // PDF renders an iframe (portaled to document.body)
    const iframe = document.querySelector('iframe');
    expect(iframe).toBeTruthy();
    expect(iframe!.getAttribute('title')).toContain('doc.pdf');
    // No markdown content should be rendered
    expect(screen.queryByTestId('rendered-markdown')).not.toBeInTheDocument();
  });
});

describe('FilePreviewModal — HTML', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  /** Counts only the signed-URL mint calls, ignoring any preview-text fetches. */
  function mintCallCount(): number {
    return fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('/interactive-preview-url')
    ).length;
  }

  function mintResponse(url: string): Response {
    return new Response(
      JSON.stringify({
        url,
        expiresAt: '2026-08-04T12:05:00.000Z',
        version: '2026-04-14T00:00:00Z',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  function htmlFile() {
    return makeMarkdownFile({
      mimeType: 'text/html',
      filename: 'interactive.html',
      sizeBytes: HTML_CONTENT.length,
    });
  }

  beforeEach(() => {
    // Default: every request resolves to a freshly-minted signed preview URL. Individual tests
    // override with mockResolvedValueOnce where call ordering matters.
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((input: RequestInfo | URL) =>
        Promise.resolve(
          String(input).includes('/interactive-preview-url')
            ? mintResponse('https://preview.example.com/p/signed/index.html')
            : new Response(HTML_CONTENT, {
                status: 200,
                headers: { 'Content-Type': 'text/plain; charset=utf-8' },
              })
        )
      );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    document.body.style.overflow = '';
  });

  it('auto-runs the interactive preview on open with no click, in an allow-scripts-only iframe', async () => {
    render(
      <FilePreviewModal
        file={htmlFile()}
        previewUrl="https://api.example.com/preview/interactive"
        onClose={vi.fn()}
        onDownload={vi.fn()}
      />
    );

    // No confirmation gate: the frame appears without any user interaction.
    const interactiveFrame = await screen.findByTitle('Interactive preview of interactive.html');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Run interactive preview' })
    ).not.toBeInTheDocument();

    // Isolation contract is unchanged.
    expect(interactiveFrame).toHaveAttribute('sandbox', 'allow-scripts');
    expect(interactiveFrame.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(interactiveFrame.getAttribute('sandbox')).not.toContain('allow-forms');
    expect(interactiveFrame).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(interactiveFrame).toHaveAttribute(
      'src',
      'https://preview.example.com/p/signed/index.html'
    );
    expect(screen.getByText('Agent-generated · no network')).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/projects/proj-1/library/file-1/interactive-preview-url'),
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('does not render the inert sanitized copy alongside the interactive preview', async () => {
    render(
      <FilePreviewModal
        file={htmlFile()}
        previewUrl="https://api.example.com/preview/interactive"
        onClose={vi.fn()}
        onDownload={vi.fn()}
      />
    );

    await screen.findByTitle('Interactive preview of interactive.html');

    // Exactly one rendering of the document: the interactive frame. The old DOMPurify srcdoc
    // iframe (sandbox="" + no src) must be gone.
    const frames = Array.from(document.querySelectorAll('iframe'));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toHaveAttribute('src');
    expect(frames[0]).not.toHaveAttribute('srcdoc');
    expect(document.querySelector('iframe[sandbox=""]')).toBeNull();
    // And the modal did not fetch the preview text just to render an inert copy.
    expect(
      fetchSpy.mock.calls.filter((call) => String(call[0]).includes('/preview/interactive'))
    ).toHaveLength(0);
  });

  it('mints exactly once across repeated parent re-renders (no re-mint loop)', async () => {
    const file = htmlFile();
    const { rerender } = render(
      <FilePreviewModal
        file={file}
        previewUrl="https://api.example.com/preview/interactive"
        onClose={vi.fn()}
        onDownload={vi.fn()}
      />
    );
    await screen.findByTitle('Interactive preview of interactive.html');
    expect(mintCallCount()).toBe(1);

    // DocumentCard builds `file` as a fresh object literal on every render. Re-rendering with an
    // equal-but-not-identical object must NOT re-mint or the modal would loop.
    for (let i = 0; i < 3; i += 1) {
      rerender(
        <FilePreviewModal
          file={{ ...file }}
          previewUrl="https://api.example.com/preview/interactive"
          onClose={vi.fn()}
          onDownload={vi.fn()}
        />
      );
      // Let any effect scheduled by this render flush before the next one, so a re-mint would
      // actually have a chance to fire and be counted.
      await act(async () => {
        await Promise.resolve();
      });
    }

    // Deterministic settle rather than waitFor: waitFor would pass the instant the count is 1,
    // which under load can be read before a re-mint lands (and can spuriously fail while the
    // first mint is still in flight). Draining the microtask queue makes the count final.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mintCallCount()).toBe(1);
  });

  it('keeps the preview stopped after Stop, and restores it on Run again', async () => {
    const user = userEvent.setup();
    render(
      <FilePreviewModal
        file={htmlFile()}
        previewUrl="https://api.example.com/preview/interactive"
        onClose={vi.fn()}
        onDownload={vi.fn()}
      />
    );
    await screen.findByTitle('Interactive preview of interactive.html');

    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(screen.queryByTitle('Interactive preview of interactive.html')).not.toBeInTheDocument();

    // The auto-run effect must not undo the user's Stop.
    await waitFor(() => {
      expect(screen.getByText('Preview stopped.')).toBeInTheDocument();
    });
    expect(screen.queryByTitle('Interactive preview of interactive.html')).not.toBeInTheDocument();
    expect(mintCallCount()).toBe(1);

    await user.click(screen.getByRole('button', { name: 'Run again' }));
    expect(await screen.findByTitle('Interactive preview of interactive.html')).toBeInTheDocument();
    expect(mintCallCount()).toBe(2);
  });

  it('shows the starting state while Run again is in flight, not the stale stopped state', async () => {
    const user = userEvent.setup();
    render(
      <FilePreviewModal
        file={htmlFile()}
        previewUrl="https://api.example.com/preview/interactive"
        onClose={vi.fn()}
        onDownload={vi.fn()}
      />
    );
    await screen.findByTitle('Interactive preview of interactive.html');
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(screen.getByText('Preview stopped.')).toBeInTheDocument();

    // Hold the second mint open so the in-flight state is observable. With an instantly-resolved
    // mock this window is a single microtask and the bug is invisible.
    let releaseMint: (value: Response) => void = () => undefined;
    fetchSpy.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          releaseMint = resolve;
        })
    );

    await user.click(screen.getByRole('button', { name: 'Run again' }));

    // Mid-flight: the stopped state must be cleared immediately, not after the mint resolves.
    expect(screen.queryByText('Preview stopped.')).not.toBeInTheDocument();
    expect(screen.getByText('Starting interactive preview…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run again' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();

    await act(async () => {
      releaseMint(mintResponse('https://preview.example.com/p/signed/index.html'));
      await Promise.resolve();
    });
    expect(await screen.findByTitle('Interactive preview of interactive.html')).toBeInTheDocument();
  });

  it('re-mints a fresh signed URL on Reset rather than reloading an expired one', async () => {
    const user = userEvent.setup();
    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve(mintResponse('https://preview.example.com/p/first/index.html'))
    );
    render(
      <FilePreviewModal
        file={htmlFile()}
        previewUrl="https://api.example.com/preview/interactive"
        onClose={vi.fn()}
        onDownload={vi.fn()}
      />
    );

    const frame = await screen.findByTitle('Interactive preview of interactive.html');
    expect(frame).toHaveAttribute('src', 'https://preview.example.com/p/first/index.html');

    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve(mintResponse('https://preview.example.com/p/second/index.html'))
    );
    await user.click(screen.getByRole('button', { name: 'Reset' }));

    // A stale URL reload would render the 403 "Preview link expired" page; Reset must re-mint.
    await waitFor(() => {
      expect(screen.getByTitle('Interactive preview of interactive.html')).toHaveAttribute(
        'src',
        'https://preview.example.com/p/second/index.html'
      );
    });
    expect(mintCallCount()).toBe(2);
  });

  it('collapses overlapping Reset clicks into a single mint', async () => {
    const user = userEvent.setup();
    render(
      <FilePreviewModal
        file={htmlFile()}
        previewUrl="https://api.example.com/preview/interactive"
        onClose={vi.fn()}
        onDownload={vi.fn()}
      />
    );
    await screen.findByTitle('Interactive preview of interactive.html');
    expect(mintCallCount()).toBe(1);

    // Hold the next mint open so a second click genuinely overlaps it, exercising the
    // in-flight guard rather than relying on a stable effect identity.
    let releaseMint: (value: Response) => void = () => undefined;
    fetchSpy.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          releaseMint = resolve;
        })
    );

    const reset = screen.getByRole('button', { name: 'Reset' });
    await user.click(reset);
    await user.click(reset);
    await user.click(reset);

    // Three clicks, one in-flight request: the extra two must be dropped, not queued.
    expect(mintCallCount()).toBe(2);

    await act(async () => {
      releaseMint(mintResponse('https://preview.example.com/p/second/index.html'));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByTitle('Interactive preview of interactive.html')).toHaveAttribute(
        'src',
        'https://preview.example.com/p/second/index.html'
      );
    });
    expect(mintCallCount()).toBe(2);
  });

  it('keeps the running preview mounted while Reset re-mints (no flash to empty)', async () => {
    const user = userEvent.setup();
    render(
      <FilePreviewModal
        file={htmlFile()}
        previewUrl="https://api.example.com/preview/interactive"
        onClose={vi.fn()}
        onDownload={vi.fn()}
      />
    );
    await screen.findByTitle('Interactive preview of interactive.html');

    let releaseMint: (value: Response) => void = () => undefined;
    fetchSpy.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          releaseMint = resolve;
        })
    );
    await user.click(screen.getByRole('button', { name: 'Reset' }));

    // Stale-while-revalidate (rule 48): the already-rendered frame must stay on screen for the
    // whole re-mint rather than being replaced by a spinner or an empty pane.
    expect(screen.getByTitle('Interactive preview of interactive.html')).toHaveAttribute(
      'src',
      'https://preview.example.com/p/signed/index.html'
    );

    await act(async () => {
      releaseMint(mintResponse('https://preview.example.com/p/refreshed/index.html'));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByTitle('Interactive preview of interactive.html')).toHaveAttribute(
        'src',
        'https://preview.example.com/p/refreshed/index.html'
      );
    });
  });

  it('re-mints for a different artifact when the file changes without unmounting', async () => {
    const { rerender } = render(
      <FilePreviewModal
        file={htmlFile()}
        previewUrl="https://api.example.com/preview/interactive"
        onClose={vi.fn()}
        onDownload={vi.fn()}
      />
    );
    await screen.findByTitle('Interactive preview of interactive.html');
    expect(mintCallCount()).toBe(1);

    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve(mintResponse('https://preview.example.com/p/other/index.html'))
    );
    rerender(
      <FilePreviewModal
        file={makeMarkdownFile({
          id: 'file-2',
          mimeType: 'text/html',
          filename: 'other.html',
          sizeBytes: HTML_CONTENT.length,
        })}
        previewUrl="https://api.example.com/preview/other"
        onClose={vi.fn()}
        onDownload={vi.fn()}
      />
    );

    // A genuinely different artifact must mint again and must not keep showing the previous one.
    const frame = await screen.findByTitle('Interactive preview of other.html');
    expect(frame).toHaveAttribute('src', 'https://preview.example.com/p/other/index.html');
    expect(screen.queryByTitle('Interactive preview of interactive.html')).not.toBeInTheDocument();
    expect(mintCallCount()).toBe(2);
    expect(String(fetchSpy.mock.calls.at(-1)?.[0])).toContain(
      '/api/projects/proj-1/library/file-2/interactive-preview-url'
    );
  });

  it('opens a freshly minted URL in a new tab with noopener', async () => {
    const user = userEvent.setup();
    const openSpy = vi.fn();
    vi.stubGlobal('open', openSpy);
    render(
      <FilePreviewModal
        file={htmlFile()}
        previewUrl="https://api.example.com/preview/interactive"
        onClose={vi.fn()}
        onDownload={vi.fn()}
      />
    );
    await screen.findByTitle('Interactive preview of interactive.html');

    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve(mintResponse('https://preview.example.com/p/fresh/index.html'))
    );
    await user.click(screen.getByRole('button', { name: 'Open in new tab' }));

    // Must mint a NEW url rather than reusing the iframe's (possibly expired) one.
    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith(
        'https://preview.example.com/p/fresh/index.html',
        '_blank',
        'noopener,noreferrer'
      );
    });
    expect(mintCallCount()).toBe(2);
    vi.unstubAllGlobals();
  });

  it('reports an error when opening in a new tab fails', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('open', vi.fn());
    render(
      <FilePreviewModal
        file={htmlFile()}
        previewUrl="https://api.example.com/preview/interactive"
        onClose={vi.fn()}
        onDownload={vi.fn()}
      />
    );
    await screen.findByTitle('Interactive preview of interactive.html');

    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'INTERNAL_ERROR', message: 'nope' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
    await user.click(screen.getByRole('button', { name: 'Open in new tab' }));

    // The running preview must survive a failed new-tab mint.
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByTitle('Interactive preview of interactive.html')).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it('surfaces a retryable error instead of a blank pane when minting fails', async () => {
    const user = userEvent.setup();
    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'INTERNAL_ERROR', message: 'mint exploded' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
    render(
      <FilePreviewModal
        file={htmlFile()}
        previewUrl="https://api.example.com/preview/interactive"
        onClose={vi.fn()}
        onDownload={vi.fn()}
      />
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(screen.queryByTitle('Interactive preview of interactive.html')).not.toBeInTheDocument();

    // Retry recovers.
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTitle('Interactive preview of interactive.html')).toBeInTheDocument();
  });

  it('toggles to a source view that shows the original bytes, fetched lazily', async () => {
    const user = userEvent.setup();
    render(
      <FilePreviewModal
        file={htmlFile()}
        previewUrl="https://api.example.com/preview/interactive"
        onClose={vi.fn()}
        onDownload={vi.fn()}
      />
    );
    await screen.findByTitle('Interactive preview of interactive.html');

    // Source is not fetched until requested.
    expect(
      fetchSpy.mock.calls.filter((call) => String(call[0]).includes('/preview/interactive'))
    ).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Source view' }));

    await waitFor(() => {
      expect(document.querySelector('pre')?.textContent).toContain('<script>');
    });
    expect(screen.queryByTitle('Interactive preview of interactive.html')).not.toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.example.com/preview/interactive',
      expect.objectContaining({ credentials: 'include' })
    );

    await user.click(screen.getByRole('button', { name: 'Interactive preview' }));
    expect(await screen.findByTitle('Interactive preview of interactive.html')).toBeInTheDocument();
  });

  it('offers download instead of a preview for oversized HTML', async () => {
    const onDownload = vi.fn();
    render(
      <FilePreviewModal
        file={makeMarkdownFile({
          mimeType: 'text/html',
          filename: 'huge.html',
          sizeBytes: FILE_PREVIEW_LOAD_MAX_BYTES + 1,
        })}
        previewUrl="https://api.example.com/preview/huge"
        onClose={vi.fn()}
        onDownload={onDownload}
      />
    );

    expect(screen.getByText(/too large to preview/i)).toBeInTheDocument();
    expect(screen.queryByTitle('Interactive preview of huge.html')).not.toBeInTheDocument();
    expect(mintCallCount()).toBe(0);
    expect(screen.queryByRole('button', { name: 'Source view' })).not.toBeInTheDocument();
  });
});
