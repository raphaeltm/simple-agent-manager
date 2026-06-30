import { describe, expect, it, vi } from 'vitest';

import { getMessages } from '../../../src/durable-objects/project-data/messages';

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

describe('ProjectData messages getMessages', () => {
  it('keeps newest-page default behavior ordered chronologically for rendering', () => {
    const newest = makeRow({ id: 'newest', content: 'Newest', created_at: 3000, sequence: 3 });
    const older = makeRow({ id: 'older', content: 'Older', created_at: 2000, sequence: 2 });
    const sql = makeSql([newest, older]);

    const result = getMessages(sql, 'session-1', 2);

    expect(sql.exec.mock.calls[0]?.[0]).toContain('ORDER BY created_at DESC, sequence DESC');
    expect(result.messages.map((message) => message.content)).toEqual(['Older', 'Newest']);
    expect(result.hasMore).toBe(false);
  });

  it('supports oldest-first lookups for the initial user prompt', () => {
    const initialPrompt = makeRow({ id: 'initial', content: 'Initial prompt', created_at: 1000, sequence: 1 });
    const followUp = makeRow({ id: 'follow-up', content: 'Follow-up prompt', created_at: 3000, sequence: 3 });
    const sql = makeSql([initialPrompt, followUp]);

    const result = getMessages(sql, 'session-1', 1, null, ['user'], true, 'asc');

    expect(sql.exec.mock.calls[0]?.[0]).toContain('ORDER BY created_at ASC, sequence ASC');
    expect(sql.exec.mock.calls[0]?.slice(1)).toEqual(['session-1', 'user', 2]);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.content).toBe('Initial prompt');
    expect(result.hasMore).toBe(true);
  });
});
