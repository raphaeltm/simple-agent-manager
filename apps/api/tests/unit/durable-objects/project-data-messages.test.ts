import { afterEach, describe, expect, it, vi } from 'vitest';

import { getMessages } from '../../../src/durable-objects/project-data/messages';
import {
  boundToolMetadataForStorage,
  DEFAULT_PROJECT_DATA_TOOL_METADATA_MAX_BYTES,
} from '../../../src/durable-objects/project-data/tool-metadata-storage';
import type { Env } from '../../../src/durable-objects/project-data/types';
import { log } from '../../../src/lib/logger';

type QueryRow = Record<string, unknown>;

function makeRow(overrides: Partial<QueryRow> = {}): QueryRow {
  return {
    id: 'msg-1',
    session_id: 'session-1',
    role: 'user',
    content: 'message',
    tool_metadata: null,
    created_at: 1000,
    sequence: 1,
    ...overrides,
  };
}

function makeSql(rows: QueryRow[]) {
  return {
    exec: vi.fn(() => ({
      toArray: () => rows,
    })),
  } as unknown as Parameters<typeof getMessages>[0] & { exec: ReturnType<typeof vi.fn> };
}

describe('boundToolMetadataForStorage', () => {
  it('keeps metadata unchanged when it is under the configured cap', () => {
    const raw = JSON.stringify({ toolCallId: 'tc-1', status: 'completed' });
    const result = boundToolMetadataForStorage(raw, {} as Env);

    expect(DEFAULT_PROJECT_DATA_TOOL_METADATA_MAX_BYTES).toBe(128 * 1024);
    expect(result).toMatchObject({
      value: raw,
      originalBytes: raw.length,
      storedBytes: raw.length,
      truncated: false,
    });
  });

  it('strips oversized content arrays and preserves useful tool identity fields', () => {
    const raw = JSON.stringify({
      toolCallId: 'tc-large',
      title: 'Run shell command',
      kind: 'shell',
      status: 'completed',
      content: [{ type: 'terminal', output: 'x'.repeat(4096), exitCode: 0 }],
    });

    const result = boundToolMetadataForStorage(raw, {
      PROJECT_DATA_TOOL_METADATA_MAX_BYTES: '768',
    } as Env);

    expect(result.truncated).toBe(true);
    expect(result.storedBytes).toBeLessThanOrEqual(768);
    const stored = JSON.parse(result.value ?? '{}') as Record<string, unknown>;
    expect(stored).toMatchObject({
      toolCallId: 'tc-large',
      title: 'Run shell command',
      kind: 'shell',
      status: 'completed',
    });
    expect(stored.content).toBeUndefined();
    expect(stored.contentSize).toBeGreaterThan(4096);
  });

  it('falls back to a minimal valid JSON marker when compact metadata is still too large', () => {
    const raw = JSON.stringify({
      toolCallId: 'tc-minimal',
      title: 'x'.repeat(2048),
      status: 'completed',
      content: [{ type: 'terminal', output: 'y'.repeat(2048) }],
    });

    const result = boundToolMetadataForStorage(raw, {
      PROJECT_DATA_TOOL_METADATA_MAX_BYTES: '128',
    } as Env);

    expect(result.truncated).toBe(true);
    expect(result.storedBytes).toBeLessThanOrEqual(128);
    expect(() => JSON.parse(result.value ?? '')).not.toThrow();
    expect(JSON.parse(result.value ?? '{}')).toMatchObject({
      storageSafetyTruncated: true,
    });
  });

  it('stores a valid JSON marker for oversized malformed metadata', () => {
    const raw = `{${'x'.repeat(2048)}`;
    const result = boundToolMetadataForStorage(raw, {
      PROJECT_DATA_TOOL_METADATA_MAX_BYTES: '256',
    } as Env);

    expect(result.truncated).toBe(true);
    expect(result.storedBytes).toBeLessThanOrEqual(256);
    expect(JSON.parse(result.value ?? '{}')).toMatchObject({
      storageSafetyTruncated: true,
      parseFailed: true,
    });
  });
});

describe('ProjectData messages getMessages', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps newest-page default behavior ordered chronologically for rendering', () => {
    const newest = makeRow({ id: 'newest', content: 'Newest', created_at: 3000, sequence: 3 });
    const older = makeRow({ id: 'older', content: 'Older', created_at: 2000, sequence: 2 });
    const sql = makeSql([newest, older]);

    const result = getMessages(sql, 'session-1', 2);

    expect(sql.exec.mock.calls[0]?.[0]).toContain('ORDER BY created_at DESC, sequence DESC');
    expect(result.messages.map((message) => message.content)).toEqual(['Older', 'Newest']);
    expect(result.hasMore).toBe(false);
  });

  it('skips a malformed message row among valid rows instead of throwing', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const newest = makeRow({ id: 'newest', content: 'Newest', created_at: 3000, sequence: 3 });
    const bad = makeRow({ id: 'bad', content: null, created_at: 2000, sequence: 2 });
    const oldest = makeRow({ id: 'oldest', content: 'Oldest', created_at: 1000, sequence: 1 });
    const sql = makeSql([newest, bad, oldest]);

    expect(() => getMessages(sql, 'session-1', 3)).not.toThrow();

    const result = getMessages(sql, 'session-1', 3);
    expect(result.messages.map((message) => message.id)).toEqual(['oldest', 'newest']);
    expect(result.hasMore).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      'messages.list_row_skipped',
      expect.objectContaining({
        rowId: 'bad',
        rowSessionId: 'session-1',
        requestedSessionId: 'session-1',
        compact: false,
        error: expect.stringContaining('content'),
      })
    );
    expect(warn).toHaveBeenCalledWith(
      'messages.list_degraded',
      expect.objectContaining({ returned: 2, skipped: 1 })
    );
  });

  it('skips malformed compact message rows without failing the compact list', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const good = makeRow({ id: 'good', content: 'Good compact content' });
    const bad = makeRow({ id: 'bad-compact', content: null });
    const sql = makeSql([good, bad]);

    const result = getMessages(sql, 'session-1', 2, null, null, undefined, true);

    expect(result.messages.map((message) => message.id)).toEqual(['good']);
    expect(warn).toHaveBeenCalledWith(
      'messages.list_row_skipped',
      expect.objectContaining({
        rowId: 'bad-compact',
        compact: true,
        error: expect.stringContaining('content'),
      })
    );
  });

  it('returns an empty non-throwing list when every message row is malformed', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const sql = makeSql([
      makeRow({ id: 'bad-1', content: null }),
      makeRow({ id: 'bad-2', role: null }),
    ]);

    const result = getMessages(sql, 'session-1', 2);

    expect(result.messages).toEqual([]);
    expect(result.hasMore).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      'messages.list_degraded',
      expect.objectContaining({ returned: 0, skipped: 2 })
    );
  });

  it('supports oldest-first lookups for the initial user prompt', () => {
    const initialPrompt = makeRow({ id: 'initial', content: 'Initial prompt', created_at: 1000, sequence: 1 });
    const followUp = makeRow({ id: 'follow-up', content: 'Follow-up prompt', created_at: 3000, sequence: 3 });
    const sql = makeSql([initialPrompt, followUp]);

    const result = getMessages(sql, 'session-1', 1, null, null, ['user'], true, 'asc');

    expect(sql.exec.mock.calls[0]?.[0]).toContain('ORDER BY created_at ASC, sequence ASC');
    expect(sql.exec.mock.calls[0]?.slice(1)).toEqual(['session-1', 'user', 2]);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.content).toBe('Initial prompt');
    expect(result.hasMore).toBe(true);
  });

  it('supports forward-cursor delta lookups after a cached message timestamp', () => {
    const newMessage = makeRow({ id: 'new', content: 'New', created_at: 4000, sequence: 4 });
    const sql = makeSql([newMessage]);

    const result = getMessages(sql, 'session-1', 10, null, 3000, undefined, false, 'asc');

    expect(sql.exec.mock.calls[0]?.[0]).toContain('AND created_at > ?');
    expect(sql.exec.mock.calls[0]?.slice(1)).toEqual(['session-1', 3000, 11]);
    expect(result.messages.map((message) => message.id)).toEqual(['new']);
  });
});
