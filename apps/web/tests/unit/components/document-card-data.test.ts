import type { ToolCallItem } from '@simple-agent-manager/acp-client';
import { describe, expect, it } from 'vitest';

import {
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

  it('returns built-in tool names unchanged', () => {
    expect(normalizeToolName('Read')).toBe('Read');
  });

  it('returns undefined for undefined', () => {
    expect(normalizeToolName(undefined)).toBeUndefined();
  });
});

describe('extractDocumentCardData', () => {
  it('extracts upload result from rawOutput (fileId/name/mime/size from result)', () => {
    const data = extractDocumentCardData(toolItem({
      toolName: 'mcp__sam-mcp__upload_to_library',
      rawInput: { filePath: '/tmp/auth.md', directory: '/docs/' },
      rawOutput: rawOutput({ fileId: 'f-1', filename: 'auth.md', mimeType: 'text/markdown', sizeBytes: 1234 }),
    }));

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
    const data = extractDocumentCardData(toolItem({
      toolName: 'mcp__sam-mcp__display_from_library',
      rawInput: { fileId: 'f-2', caption: 'Section 3 answers this' },
      rawOutput: rawOutput({ fileId: 'f-2', filename: 'diagram.png', mimeType: 'image/png', sizeBytes: 5000 }),
    }));

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
    const data = extractDocumentCardData(toolItem({
      toolName: 'mcp__sam-mcp__upload_to_library',
      rawInput: { filePath: '/tmp/report.md' },
      rawOutput: rawOutput({
        error: 'FILE_EXISTS',
        existingFile: { id: 'existing-9', filename: 'report.md', mimeType: 'text/markdown', sizeBytes: 800 },
      }),
    }));

    expect(data).toMatchObject({ state: 'ready', fileId: 'existing-9', fileName: 'report.md' });
  });

  it('returns tombstone state on FILE_NOT_FOUND', () => {
    const data = extractDocumentCardData(toolItem({
      toolName: 'mcp__sam-mcp__display_from_library',
      rawInput: { fileId: 'gone' },
      rawOutput: rawOutput({ error: 'FILE_NOT_FOUND' }),
    }));

    expect(data.state).toBe('tombstone');
  });

  it('returns pending state while the tool is still running with no result', () => {
    const data = extractDocumentCardData(toolItem({
      toolName: 'mcp__sam-mcp__upload_to_library',
      status: 'in_progress',
      rawInput: { filePath: '/tmp/wip.md' },
      rawOutput: undefined,
    }));

    expect(data.state).toBe('pending');
    // fileName derives from the input path so the pending card can name the doc.
    expect(data.fileName).toBe('wip.md');
  });

  it('returns unavailable state when completed but no fileId can be derived', () => {
    const data = extractDocumentCardData(toolItem({
      toolName: 'mcp__sam-mcp__upload_to_library',
      status: 'completed',
      rawInput: {},
      rawOutput: undefined,
    }));

    expect(data.state).toBe('unavailable');
    expect(data.fileId).toBeUndefined();
  });

  it('tolerates a bare-object rawOutput (non-array)', () => {
    const data = extractDocumentCardData(toolItem({
      toolName: 'mcp__sam-mcp__display_from_library',
      rawInput: { fileId: 'f-obj' },
      rawOutput: { fileId: 'f-obj', filename: 'x.md', mimeType: 'text/markdown', sizeBytes: 10 },
    }));

    expect(data).toMatchObject({ state: 'ready', fileId: 'f-obj', fileName: 'x.md' });
  });
});
