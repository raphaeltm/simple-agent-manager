import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FilePreviewModal } from '../../../src/components/library/FilePreviewModal';
import type { FileWithTags } from '../../../src/components/library/types';

// Mock the heavy content renderers/viewers with test doubles that expose which
// branch the modal selected. The modal's branch choice (image/pdf/markdown/html)
// is the behavior under test, not the renderers themselves.
vi.mock('../../../src/components/MarkdownRenderer', () => ({
  RenderedMarkdown: ({ content }: { content: string }) => (
    <div data-testid="rendered-markdown">{content}</div>
  ),
  SyntaxHighlightedCode: ({ content }: { content: string }) => (
    <pre data-testid="md-source">{content}</pre>
  ),
}));
vi.mock('../../../src/components/shared-file-viewer/HtmlViewer', () => ({
  HtmlViewer: ({ fileName }: { fileName: string }) => (
    <div data-testid="html-viewer">{fileName}</div>
  ),
}));
vi.mock('../../../src/components/shared-file-viewer/ImageViewer', () => ({
  ImageViewer: ({ fileName }: { fileName: string }) => (
    <div data-testid="image-viewer">{fileName}</div>
  ),
}));
vi.mock('../../../src/hooks/useScrollLock', () => ({ useScrollLock: () => undefined }));

function makeFile(overrides: Partial<FileWithTags>): FileWithTags {
  return {
    id: 'f-1',
    filename: 'file',
    mimeType: 'application/octet-stream',
    sizeBytes: 48,
    tags: [],
    ...overrides,
  } as FileWithTags;
}

const noop = () => undefined;

describe('FilePreviewModal — octet-stream extension recovery', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders the markdown branch for an octet-stream file with a .md name', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('# Recovered heading\n\nBody.'),
    }));

    render(
      <FilePreviewModal
        file={makeFile({ filename: 'plan.md', mimeType: 'application/octet-stream' })}
        previewUrl="https://api.test/preview/f-1"
        onClose={noop}
        onDownload={noop}
      />,
    );

    // Markdown branch: fetches the preview URL and renders the returned source.
    await waitFor(() => {
      expect(screen.getByTestId('rendered-markdown')).toBeTruthy();
    });
    expect(screen.getByTestId('rendered-markdown').textContent).toContain('# Recovered heading');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.test/preview/f-1',
      expect.objectContaining({ credentials: 'include' }),
    );
    // Not routed to any other viewer.
    expect(screen.queryByTestId('image-viewer')).toBeNull();
    expect(screen.queryByTestId('html-viewer')).toBeNull();
  });

  it('routes an octet-stream .html file to the sandboxed HtmlViewer (no unsafe path)', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    render(
      <FilePreviewModal
        file={makeFile({ filename: 'page.html', mimeType: 'application/octet-stream' })}
        previewUrl="https://api.test/preview/f-html"
        onClose={noop}
        onDownload={noop}
      />,
    );

    // HTML always goes through HtmlViewer (DOMPurify + sandboxed iframe); the
    // modal itself never fetches HTML directly. No markdown/image branch.
    expect(screen.getByTestId('html-viewer')).toBeTruthy();
    expect(screen.queryByTestId('rendered-markdown')).toBeNull();
    expect(screen.queryByTestId('image-viewer')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not render an image branch for an octet-stream file with a .svg name (SVG stays non-previewable)', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    render(
      <FilePreviewModal
        file={makeFile({ filename: 'icon.svg', mimeType: 'application/octet-stream' })}
        previewUrl="https://api.test/preview/f-svg"
        onClose={noop}
        onDownload={noop}
      />,
    );

    // .svg recovers to image/svg+xml, which is excluded from the previewable
    // image set — the modal must NOT render the ImageViewer (or any other branch).
    expect(screen.queryByTestId('image-viewer')).toBeNull();
    expect(screen.queryByTestId('rendered-markdown')).toBeNull();
    expect(screen.queryByTestId('html-viewer')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.getByText('icon.svg')).toBeTruthy();
  });

  it('shows no preview branch for an octet-stream file with no known extension', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    render(
      <FilePreviewModal
        file={makeFile({ filename: 'blob.bin', mimeType: 'application/octet-stream' })}
        previewUrl="https://api.test/preview/f-bin"
        onClose={noop}
        onDownload={noop}
      />,
    );

    // No branch renders; nothing is fetched. The header (filename) still shows.
    expect(screen.queryByTestId('rendered-markdown')).toBeNull();
    expect(screen.queryByTestId('image-viewer')).toBeNull();
    expect(screen.queryByTestId('html-viewer')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.getByText('blob.bin')).toBeTruthy();
  });
});
