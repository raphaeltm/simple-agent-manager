import type { ToolCallItem } from '@simple-agent-manager/acp-client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DocumentCard } from '../../../src/components/project-message-view/tool-cards/DocumentCard';
import { matchToolCard } from '../../../src/components/project-message-view/tool-cards/registry';

const downloadLibraryFile = vi.fn();

vi.mock('../../../src/lib/api/library', () => ({
  getLibraryFilePreviewUrl: (projectId: string, fileId: string) => `https://api.test/p/${projectId}/${fileId}`,
  downloadLibraryFile: (...args: unknown[]) => downloadLibraryFile(...args),
}));

function toolItem(overrides: Partial<ToolCallItem>): ToolCallItem {
  return {
    kind: 'tool_call',
    id: 'i-1',
    toolCallId: 'tc-1',
    title: 'Tool',
    status: 'completed',
    content: [],
    locations: [],
    timestamp: 0,
    ...overrides,
  };
}

function rawOutput(payload: Record<string, unknown>): unknown {
  return [{ type: 'text', text: JSON.stringify(payload) }];
}

const readyOutput = rawOutput({ id: 'f-1', filename: 'doc.pdf', mimeType: 'application/pdf', sizeBytes: 10 });

describe('matchToolCard registry', () => {
  it('returns DocumentCard for the three library document tools (Claude mcp__ form)', () => {
    for (const name of [
      'mcp__sam-mcp__upload_to_library',
      'mcp__sam-mcp__replace_library_file',
      'mcp__sam-mcp__display_from_library',
    ]) {
      expect(matchToolCard(toolItem({ toolName: name, rawOutput: readyOutput }))).toBe(DocumentCard);
    }
  });

  it('returns DocumentCard for the Codex slash form (<server>/<tool>)', () => {
    // Codex has no explicit toolName; the identifier arrives as the ACP title.
    for (const title of [
      'sam-mcp/display_from_library',
      'sam-mcp/upload_to_library',
      'sam-mcp-1/replace_library_file', // multi-server naming
      'sam-mcp.display_from_library', // dotted separator
      'sam-mcp:display_from_library', // colon separator
    ]) {
      expect(matchToolCard(toolItem({ title, toolName: undefined, rawOutput: readyOutput }))).toBe(DocumentCard);
    }
  });

  it('returns DocumentCard when legacy rows only have the MCP title', () => {
    expect(matchToolCard(toolItem({
      title: 'mcp__sam-mcp__display_from_library',
      toolName: undefined,
      rawOutput: readyOutput,
    }))).toBe(DocumentCard);
  });

  it('renders the pending card before output arrives', () => {
    expect(matchToolCard(toolItem({
      toolName: 'mcp__sam-mcp__display_from_library',
      status: 'in_progress',
      rawOutput: undefined,
    }))).toBe(DocumentCard);
  });

  it('falls back (null) for non-document tools and unknown tools', () => {
    expect(matchToolCard(toolItem({ toolName: 'Read' }))).toBeNull();
    expect(matchToolCard(toolItem({ toolName: 'mcp__sam-mcp__list_library_files' }))).toBeNull();
    expect(matchToolCard(toolItem({ toolName: 'sam-mcp/list_library_files' }))).toBeNull();
    expect(matchToolCard(toolItem({ toolName: undefined }))).toBeNull();
  });

  it('falls back (null) when the name matches but the payload is unusable (shape authority)', () => {
    // A completed library tool with no fileId in any payload → generic card,
    // never a broken empty DocumentCard.
    expect(matchToolCard(toolItem({
      toolName: 'mcp__sam-mcp__display_from_library',
      status: 'completed',
      rawOutput: rawOutput({ error: 'SOMETHING_ELSE' }),
    }))).toBeNull();
  });
});

describe('DocumentCard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    downloadLibraryFile.mockClear();
  });

  it('renders an inline thumbnail for image documents', () => {
    render(<DocumentCard projectId="proj-1" item={toolItem({
      toolName: 'mcp__sam-mcp__display_from_library',
      rawInput: { fileId: 'f-img' },
      rawOutput: rawOutput({ fileId: 'f-img', filename: 'diagram.png', mimeType: 'image/png', sizeBytes: 5000 }),
    })} />);

    const img = screen.getByAltText('diagram.png') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('https://api.test/p/proj-1/f-img');
    expect(img.getAttribute('loading')).toBe('lazy');
  });

  it('renders from legacy title + content JSON when raw metadata is absent', () => {
    render(<DocumentCard projectId="proj-1" item={toolItem({
      title: 'mcp__sam-mcp__display_from_library',
      content: [
        {
          type: 'content',
          text: JSON.stringify({
            fileId: 'f-legacy',
            filename: 'legacy.png',
            mimeType: 'image/png',
            sizeBytes: 2048,
            caption: 'Recovered from a stale VM agent row',
          }),
        },
      ],
    })} />);

    const img = screen.getByAltText('legacy.png') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('https://api.test/p/proj-1/f-legacy');
    expect(screen.getByText('Recovered from a stale VM agent row')).toBeTruthy();
  });

  it('renders a clamped markdown source preview fetched from the preview endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('# Auth flow\n\nStep 1 ...'),
    }));

    render(<DocumentCard projectId="proj-1" item={toolItem({
      toolName: 'mcp__sam-mcp__upload_to_library',
      rawInput: { filePath: '/docs/auth.md' },
      rawOutput: rawOutput({ fileId: 'f-md', filename: 'auth.md', mimeType: 'text/markdown', sizeBytes: 40 }),
    })} />);

    await waitFor(() => {
      expect(screen.getByText(/# Auth flow/)).toBeTruthy();
    });
  });

  it('renders the markdown tier for an octet-stream file with a .md name (agent-upload bug)', async () => {
    // Agent uploads land as application/octet-stream; the extension recovers the
    // markdown tier so the clamped source preview still renders + fetches.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('# Recovered\n\nThis previews from the filename.'),
    }));

    render(<DocumentCard projectId="proj-1" item={toolItem({
      toolName: 'mcp__sam-mcp__upload_to_library',
      rawInput: { filePath: '/engineering/byo-nodes/plan.md' },
      rawOutput: rawOutput({ fileId: 'f-oct', filename: 'plan.md', mimeType: 'application/octet-stream', sizeBytes: 48 }),
    })} />);

    await waitFor(() => {
      expect(screen.getByText(/# Recovered/)).toBeTruthy();
    });
  });

  it('shows a tombstone when a markdown preview fetch returns 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve('') }));

    render(<DocumentCard projectId="proj-1" item={toolItem({
      toolName: 'mcp__sam-mcp__display_from_library',
      rawInput: { fileId: 'f-del' },
      rawOutput: rawOutput({ fileId: 'f-del', filename: 'old.md', mimeType: 'text/markdown', sizeBytes: 40 }),
    })} />);

    await waitFor(() => {
      expect(screen.getByText(/No longer in the library/)).toBeTruthy();
    });
  });

  it('degrades an image to the icon tier when the thumbnail fails to load', () => {
    render(<DocumentCard projectId="proj-1" item={toolItem({
      toolName: 'mcp__sam-mcp__display_from_library',
      rawInput: { fileId: 'f-img' },
      rawOutput: rawOutput({ fileId: 'f-img', filename: 'broken.png', mimeType: 'image/png', sizeBytes: 5000 }),
    })} />);

    const img = screen.getByAltText('broken.png');
    // Simulate the preview failing to load (404, auth, network).
    fireEvent.error(img);

    // The thumbnail is removed; the card degrades to the icon tier (filename kept).
    expect(screen.queryByAltText('broken.png')).toBeNull();
    expect(screen.getByText('broken.png')).toBeTruthy();
  });

  it('suppresses the inline image tier for files over the inline size cap', () => {
    // 60 MB — above FILE_PREVIEW_INLINE_MAX_BYTES (10 MB).
    render(<DocumentCard projectId="proj-1" item={toolItem({
      toolName: 'mcp__sam-mcp__display_from_library',
      rawInput: { fileId: 'f-huge' },
      rawOutput: rawOutput({ fileId: 'f-huge', filename: 'huge.png', mimeType: 'image/png', sizeBytes: 60 * 1024 * 1024 }),
    })} />);

    // No inline thumbnail; icon card with the filename instead.
    expect(screen.queryByAltText('huge.png')).toBeNull();
    expect(screen.getByText('huge.png')).toBeTruthy();
  });

  it('degrades markdown to the icon tier when the preview fetch errors (non-404)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    render(<DocumentCard projectId="proj-1" item={toolItem({
      toolName: 'mcp__sam-mcp__upload_to_library',
      rawInput: { filePath: '/docs/flaky.md' },
      rawOutput: rawOutput({ fileId: 'f-md', filename: 'flaky.md', mimeType: 'text/markdown', sizeBytes: 40 }),
    })} />);

    // The card stays as an icon card (filename shown), no tombstone, no <pre>.
    await waitFor(() => {
      expect(screen.getByText('flaky.md')).toBeTruthy();
    });
    expect(screen.queryByText(/No longer in the library/)).toBeNull();
  });

  it('renders an icon card (no preview) for PDF documents', () => {
    render(<DocumentCard projectId="proj-1" item={toolItem({
      toolName: 'mcp__sam-mcp__display_from_library',
      rawInput: { fileId: 'f-pdf' },
      rawOutput: rawOutput({ fileId: 'f-pdf', filename: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 90000 }),
    })} />);

    expect(screen.getByText('report.pdf')).toBeTruthy();
    expect(screen.queryByAltText('report.pdf')).toBeNull();
  });

  it('keeps HTML documents on the icon tier with an interactive hint', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    render(<DocumentCard projectId="proj-1" item={toolItem({
      toolName: 'mcp__sam-mcp__display_from_library',
      rawInput: { fileId: 'f-html' },
      rawOutput: rawOutput({
        fileId: 'f-html',
        filename: 'interactive.html',
        mimeType: 'text/html',
        sizeBytes: 1200,
      }),
    })} />);

    expect(screen.getByText('interactive.html')).toBeTruthy();
    expect(screen.getByText('Interactive · tap to open')).toBeTruthy();
    expect(document.querySelector('iframe')).toBeNull();
    expect(document.querySelector('pre')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('renders a tombstone card for FILE_NOT_FOUND', () => {
    render(<DocumentCard projectId="proj-1" item={toolItem({
      toolName: 'mcp__sam-mcp__display_from_library',
      rawInput: { fileId: 'gone' },
      rawOutput: rawOutput({ error: 'FILE_NOT_FOUND' }),
    })} />);

    expect(screen.getByText(/No longer in the library/)).toBeTruthy();
  });

  it('renders a pending state while the tool is still running', () => {
    render(<DocumentCard projectId="proj-1" item={toolItem({
      toolName: 'mcp__sam-mcp__upload_to_library',
      status: 'in_progress',
      rawInput: { filePath: '/docs/wip.md' },
    })} />);

    expect(screen.getByText(/Preparing wip\.md/)).toBeTruthy();
  });

  it('renders the caption when present', () => {
    render(<DocumentCard projectId="proj-1" item={toolItem({
      toolName: 'mcp__sam-mcp__display_from_library',
      rawInput: { fileId: 'f-pdf', caption: 'Section 3 covers token refresh' },
      rawOutput: rawOutput({ fileId: 'f-pdf', filename: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 9000 }),
    })} />);

    expect(screen.getByText('Section 3 covers token refresh')).toBeTruthy();
  });

  it('opens the full-screen preview modal when clicked', async () => {
    render(<DocumentCard projectId="proj-1" item={toolItem({
      toolName: 'mcp__sam-mcp__display_from_library',
      rawInput: { fileId: 'f-img' },
      rawOutput: rawOutput({ fileId: 'f-img', filename: 'diagram.png', mimeType: 'image/png', sizeBytes: 5000 }),
    })} />);

    fireEvent.click(screen.getByRole('button', { name: /Open diagram\.png/ }));

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeTruthy();
    });
  });

  it('degrades to a non-clickable icon card when projectId is absent', () => {
    render(<DocumentCard item={toolItem({
      toolName: 'mcp__sam-mcp__display_from_library',
      rawInput: { fileId: 'f-img' },
      rawOutput: rawOutput({ fileId: 'f-img', filename: 'diagram.png', mimeType: 'image/png', sizeBytes: 5000 }),
    })} />);

    // Filename still shown, but no preview image and no open button (no projectId).
    expect(screen.getByText('diagram.png')).toBeTruthy();
    expect(screen.queryByAltText('diagram.png')).toBeNull();
    expect(screen.queryByRole('button', { name: /Open/ })).toBeNull();
  });
});
