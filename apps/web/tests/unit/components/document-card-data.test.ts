import type { ToolCallItem } from '@simple-agent-manager/acp-client';
import { describe, expect, it } from 'vitest';

import {
  DOCUMENT_CARD_TOOLS,
  extractDocumentCardData,
  normalizeToolName,
} from '../../../src/components/project-message-view/tool-cards/document-card-data';

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

/** MCP result payload wrapped as the adapter delivers it (content array). */
function rawOutput(payload: Record<string, unknown>): unknown {
  return [{ type: 'text', text: JSON.stringify(payload) }];
}

describe('normalizeToolName', () => {
  it('strips the mcp__<server>__ prefix', () => {
    expect(normalizeToolName('mcp__sam-mcp__upload_to_library')).toBe('upload_to_library');
    expect(normalizeToolName('mcp__other__display_from_library')).toBe('display_from_library');
  });

  it('strips the Codex <server>/<tool> slash form', () => {
    expect(normalizeToolName('sam-mcp/display_from_library')).toBe('display_from_library');
    expect(normalizeToolName('sam-mcp-1/replace_library_file')).toBe('replace_library_file');
  });

  it('handles dotted and colon separators', () => {
    expect(normalizeToolName('sam-mcp.upload_to_library')).toBe('upload_to_library');
    expect(normalizeToolName('sam-mcp:display_from_library')).toBe('display_from_library');
  });

  it('preserves single underscores inside the tool name', () => {
    expect(normalizeToolName('display_from_library')).toBe('display_from_library');
    expect(normalizeToolName('sam-mcp/display_from_library')).toBe('display_from_library');
  });

  it('returns built-in tool names unchanged', () => {
    expect(normalizeToolName('Read')).toBe('Read');
  });

  it('returns the server segment (not a card tool) for trailing-separator inputs', () => {
    // Degenerate titles resolve to the server name, which is NOT a document tool,
    // so recognition safely declines rather than matching.
    expect(normalizeToolName('sam-mcp/')).toBe('sam-mcp');
    expect(normalizeToolName('mcp__sam-mcp__')).toBe('sam-mcp');
    expect(DOCUMENT_CARD_TOOLS.has(normalizeToolName('sam-mcp/') as string)).toBe(false);
  });

  it('returns undefined for undefined', () => {
    expect(normalizeToolName(undefined)).toBeUndefined();
  });
});

describe('extractDocumentCardData', () => {
  it('extracts upload result from rawOutput (fileId/name/mime/size from result)', () => {
    const data = extractDocumentCardData(
      toolItem({
        toolName: 'mcp__sam-mcp__upload_to_library',
        rawInput: { filePath: '/tmp/auth.md', directory: '/docs/' },
        rawOutput: rawOutput({
          fileId: 'f-1',
          filename: 'auth.md',
          mimeType: 'text/markdown',
          sizeBytes: 1234,
        }),
      })
    );

    expect(data).toMatchObject({
      tool: 'upload_to_library',
      state: 'ready',
      fileId: 'f-1',
      fileName: 'auth.md',
      mimeType: 'text/markdown',
      sizeBytes: 1234,
    });
  });

  it('extracts display_from_library: fileId from args, metadata from result, caption from args', () => {
    const data = extractDocumentCardData(
      toolItem({
        toolName: 'mcp__sam-mcp__display_from_library',
        rawInput: { fileId: 'f-2', caption: 'Section 3 answers this' },
        rawOutput: rawOutput({
          fileId: 'f-2',
          filename: 'diagram.png',
          mimeType: 'image/png',
          sizeBytes: 5000,
        }),
      })
    );

    expect(data).toMatchObject({
      tool: 'display_from_library',
      state: 'ready',
      fileId: 'f-2',
      fileName: 'diagram.png',
      mimeType: 'image/png',
      caption: 'Section 3 answers this',
    });
  });

  it('surfaces the existing file on a FILE_EXISTS upload result', () => {
    const data = extractDocumentCardData(
      toolItem({
        toolName: 'mcp__sam-mcp__upload_to_library',
        rawInput: { filePath: '/tmp/report.md' },
        rawOutput: rawOutput({
          error: 'FILE_EXISTS',
          existingFile: {
            id: 'existing-9',
            filename: 'report.md',
            mimeType: 'text/markdown',
            sizeBytes: 800,
          },
        }),
      })
    );

    expect(data).toMatchObject({ state: 'ready', fileId: 'existing-9', fileName: 'report.md' });
  });

  it('returns tombstone state on FILE_NOT_FOUND', () => {
    const data = extractDocumentCardData(
      toolItem({
        toolName: 'mcp__sam-mcp__display_from_library',
        rawInput: { fileId: 'gone' },
        rawOutput: rawOutput({ error: 'FILE_NOT_FOUND' }),
      })
    );

    expect(data.state).toBe('tombstone');
  });

  it('returns pending state while the tool is still running with no result', () => {
    const data = extractDocumentCardData(
      toolItem({
        toolName: 'mcp__sam-mcp__upload_to_library',
        status: 'in_progress',
        rawInput: { filePath: '/tmp/wip.md' },
        rawOutput: undefined,
      })
    );

    expect(data.state).toBe('pending');
    // fileName derives from the input path so the pending card can name the doc.
    expect(data.fileName).toBe('wip.md');
  });

  it('returns unavailable state when completed but no fileId can be derived', () => {
    const data = extractDocumentCardData(
      toolItem({
        toolName: 'mcp__sam-mcp__upload_to_library',
        status: 'completed',
        rawInput: {},
        rawOutput: undefined,
      })
    );

    expect(data.state).toBe('unavailable');
    expect(data.fileId).toBeUndefined();
  });

  it('tolerates a bare-object rawOutput (non-array)', () => {
    const data = extractDocumentCardData(
      toolItem({
        toolName: 'mcp__sam-mcp__display_from_library',
        rawInput: { fileId: 'f-obj' },
        rawOutput: { fileId: 'f-obj', filename: 'x.md', mimeType: 'text/markdown', sizeBytes: 10 },
      })
    );

    expect(data).toMatchObject({ state: 'ready', fileId: 'f-obj', fileName: 'x.md' });
  });

  it('tolerates a raw JSON string rawOutput (adapter robustness)', () => {
    const data = extractDocumentCardData(
      toolItem({
        toolName: 'mcp__sam-mcp__display_from_library',
        rawInput: { fileId: 'f-str' },
        rawOutput: JSON.stringify({
          fileId: 'f-str',
          filename: 'y.md',
          mimeType: 'text/markdown',
          sizeBytes: 12,
        }),
      })
    );

    expect(data).toMatchObject({ state: 'ready', fileId: 'f-str', fileName: 'y.md' });
  });

  // Array-input parity: isRecord() used to accept arrays (typeof === 'object'),
  // isJsonRecord() rejects them. The only place an array is a legitimate
  // payload shape (the MCP content wrapper) is dispatched via Array.isArray
  // before any isJsonRecord check runs, so none of these should ever legally
  // be arrays — but they must still degrade gracefully, not throw, if they are.
  describe('array inputs (isRecord -> isJsonRecord parity)', () => {
    it('treats an array rawInput as absent input rather than a record', () => {
      const data = extractDocumentCardData(
        toolItem({
          toolName: 'mcp__sam-mcp__upload_to_library',
          status: 'completed',
          rawInput: ['not', 'a', 'record'],
          rawOutput: undefined,
        })
      );

      expect(data.state).toBe('unavailable');
      expect(data.fileId).toBeUndefined();
      expect(data.fileName).toBeUndefined();
    });

    it('treats a tool-result text block that parses to a JSON array as no result (not a crash)', () => {
      const data = extractDocumentCardData(
        toolItem({
          toolName: 'mcp__sam-mcp__upload_to_library',
          status: 'completed',
          rawInput: {},
          rawOutput: [{ type: 'text', text: '[1,2,3]' }],
        })
      );

      expect(data.state).toBe('unavailable');
      expect(data.fileId).toBeUndefined();
    });

    it('treats an array-shaped existingFile as absent rather than surfacing it as the document', () => {
      const data = extractDocumentCardData(
        toolItem({
          toolName: 'mcp__sam-mcp__upload_to_library',
          status: 'completed',
          rawInput: { filePath: '/tmp/report.md' },
          rawOutput: rawOutput({ error: 'FILE_EXISTS', existingFile: ['not', 'a', 'record'] }),
        })
      );

      // existingFile is rejected (not a record), so it falls back to the raw
      // result object, which has no id/fileId of its own either — no crash,
      // no bogus array-derived fileId.
      expect(data.state).toBe('unavailable');
      expect(data.fileId).toBeUndefined();
    });
  });
});
