/**
 * Unit tests for compact mode: stripToolMetadataContent and parseChatMessageRowCompact.
 *
 * Tests verify:
 * - Content array is stripped and replaced with contentSize
 * - Non-content metadata fields (toolCallId, title, kind, status, locations) are preserved
 * - Empty/missing content arrays pass through unchanged
 * - Non-object metadata passes through unchanged
 * - contentSize accurately reflects UTF-8 byte count
 * - parseChatMessageRowCompact produces compact output
 */
import { describe, expect, it } from 'vitest';

import { getMessageToolContent } from '../../../src/durable-objects/project-data/messages';
import {
  parseChatMessageRow,
  parseChatMessageRowCompact,
  stripToolMetadataContent,
} from '../../../src/durable-objects/project-data/row-schemas';

describe('stripToolMetadataContent', () => {
  it('strips content array and adds contentSize', () => {
    const meta = {
      toolCallId: 'tc-123',
      title: 'Read file',
      kind: 'read',
      status: 'completed',
      locations: [{ path: '/foo/bar.ts', line: 42 }],
      content: [
        { type: 'content', text: 'Hello world' },
        { type: 'diff', text: '--- a/file\n+++ b/file' },
      ],
    };

    const result = stripToolMetadataContent(meta) as Record<string, unknown>;

    expect(result.toolCallId).toBe('tc-123');
    expect(result.title).toBe('Read file');
    expect(result.kind).toBe('read');
    expect(result.status).toBe('completed');
    expect(result.locations).toEqual([{ path: '/foo/bar.ts', line: 42 }]);
    expect(result.content).toBeUndefined();
    expect(typeof result.contentSize).toBe('number');
    expect(result.contentSize).toBeGreaterThan(0);
  });

  it('preserves metadata when content is empty array', () => {
    const meta = { toolCallId: 'tc-1', content: [] };
    const result = stripToolMetadataContent(meta);
    expect(result).toEqual(meta); // empty array → no stripping
  });

  it('preserves metadata when content is missing', () => {
    const meta = { toolCallId: 'tc-1', title: 'Write' };
    const result = stripToolMetadataContent(meta);
    expect(result).toEqual(meta);
  });

  it('passes through null metadata', () => {
    expect(stripToolMetadataContent(null)).toBeNull();
  });

  it('passes through non-object metadata', () => {
    expect(stripToolMetadataContent('string')).toBe('string');
    expect(stripToolMetadataContent(42)).toBe(42);
  });

  it('calculates contentSize as UTF-8 byte count', () => {
    const content = [{ type: 'content', text: 'café' }]; // é is 2 bytes in UTF-8
    const meta = { content };
    const result = stripToolMetadataContent(meta) as Record<string, unknown>;

    const expectedBytes = new TextEncoder().encode(JSON.stringify(content)).byteLength;
    expect(result.contentSize).toBe(expectedBytes);
  });

  it('handles large content arrays', () => {
    const largeContent = Array.from({ length: 100 }, (_, i) => ({
      type: 'content',
      text: 'x'.repeat(1000),
      index: i,
    }));
    const meta = { toolCallId: 'tc-big', content: largeContent };
    const result = stripToolMetadataContent(meta) as Record<string, unknown>;

    expect(result.content).toBeUndefined();
    expect(result.contentSize).toBeGreaterThan(100_000);
    expect(result.toolCallId).toBe('tc-big');
  });
});

describe('parseChatMessageRowCompact', () => {
  const makeRow = (toolMetadata: unknown) => ({
    id: 'msg-1',
    session_id: 'sess-1',
    role: 'tool',
    content: 'tool output',
    tool_metadata: toolMetadata ? JSON.stringify(toolMetadata) : null,
    created_at: 1234567890,
    sequence: 1,
  });

  it('strips content from tool_metadata in compact mode', () => {
    const meta = {
      toolCallId: 'tc-1',
      title: 'Read',
      content: [{ type: 'content', text: 'file contents here' }],
    };
    const row = makeRow(meta);

    const compact = parseChatMessageRowCompact(row);
    const tm = compact.toolMetadata as Record<string, unknown>;

    expect(tm.toolCallId).toBe('tc-1');
    expect(tm.title).toBe('Read');
    expect(tm.content).toBeUndefined();
    expect(typeof tm.contentSize).toBe('number');
    expect(tm.contentSize).toBeGreaterThan(0);
  });

  it('preserves all other fields identically to parseChatMessageRow', () => {
    const meta = {
      toolCallId: 'tc-1',
      title: 'Read',
      content: [{ type: 'content', text: 'data' }],
    };
    const row = makeRow(meta);

    const compact = parseChatMessageRowCompact(row);
    const full = parseChatMessageRow(row);

    expect(compact.id).toBe(full.id);
    expect(compact.sessionId).toBe(full.sessionId);
    expect(compact.role).toBe(full.role);
    expect(compact.content).toBe(full.content);
    expect(compact.createdAt).toBe(full.createdAt);
    expect(compact.sequence).toBe(full.sequence);
  });

  it('handles null tool_metadata', () => {
    const row = makeRow(null);
    const compact = parseChatMessageRowCompact(row);
    expect(compact.toolMetadata).toBeNull();
  });

  it('handles tool_metadata without content array', () => {
    const meta = { toolCallId: 'tc-1', title: 'Read', status: 'completed' };
    const row = makeRow(meta);
    const compact = parseChatMessageRowCompact(row);
    const tm = compact.toolMetadata as Record<string, unknown>;

    expect(tm.toolCallId).toBe('tc-1');
    expect(tm.content).toBeUndefined();
    expect(tm.contentSize).toBeUndefined();
  });
});

describe('getMessageToolContent', () => {
  function makeSql(rows: Record<string, unknown>[]) {
    return {
      exec: () => ({ toArray: () => rows }),
    } as unknown as import('@cloudflare/workers-types').SqlStorage;
  }

  it('returns content array for a valid message with tool_metadata', () => {
    const content = [{ type: 'content', text: 'hello' }];
    const sql = makeSql([{ tool_metadata: JSON.stringify({ toolCallId: 'tc-1', content }) }]);
    const result = getMessageToolContent(sql, 'sess-1', 'msg-1');
    expect(result).toEqual(content);
  });

  it('returns null when message is not found', () => {
    const sql = makeSql([]);
    const result = getMessageToolContent(sql, 'sess-1', 'msg-missing');
    expect(result).toBeNull();
  });

  it('returns null when tool_metadata is not a string', () => {
    const sql = makeSql([{ tool_metadata: 42 }]);
    const result = getMessageToolContent(sql, 'sess-1', 'msg-1');
    expect(result).toBeNull();
  });

  it('returns null when tool_metadata has no content array', () => {
    const sql = makeSql([{ tool_metadata: JSON.stringify({ toolCallId: 'tc-1', title: 'Read' }) }]);
    const result = getMessageToolContent(sql, 'sess-1', 'msg-1');
    expect(result).toBeNull();
  });

  it('returns null when tool_metadata is malformed JSON', () => {
    const sql = makeSql([{ tool_metadata: '{bad json' }]);
    const result = getMessageToolContent(sql, 'sess-1', 'msg-1');
    expect(result).toBeNull();
  });

  it('returns null when tool_metadata is null string', () => {
    const sql = makeSql([{ tool_metadata: null }]);
    const result = getMessageToolContent(sql, 'sess-1', 'msg-1');
    expect(result).toBeNull();
  });
});

describe('compact vs full mode payload size comparison', () => {
  it('compact mode produces significantly smaller output for tool-heavy messages', () => {
    const makeToolRow = (i: number) => ({
      id: `msg-${i}`,
      session_id: 'sess-1',
      role: 'tool',
      content: '',
      tool_metadata: JSON.stringify({
        toolCallId: `tc-${i}`,
        title: `Tool ${i}`,
        kind: 'read',
        status: 'completed',
        locations: [{ path: `/src/file-${i}.ts`, line: i }],
        content: [{ type: 'content', text: 'x'.repeat(10_000) }],
      }),
      created_at: Date.now() + i,
      sequence: i,
    });

    const rows = Array.from({ length: 20 }, (_, i) => makeToolRow(i));

    const fullSize = JSON.stringify(rows.map((r) => parseChatMessageRow(r))).length;
    const compactSize = JSON.stringify(rows.map((r) => parseChatMessageRowCompact(r))).length;

    // Compact mode should be at least 80% smaller for content-heavy rows
    const reduction = 1 - compactSize / fullSize;
    expect(reduction).toBeGreaterThan(0.8);
  });
});
