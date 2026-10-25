/**
 * The task view's assistant messages (`sam_task_get`, workspace-agent and /sam `get_task_details`)
 * read through the real whole-message reader over a real SQLite transcript, stored the way the VM
 * agent stores replies: one row per streamed chunk. Only the Durable Object transport is replaced.
 */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runMigrations } from '../../../src/durable-objects/migrations';
import { readSourceLogicalTranscript } from '../../../src/durable-objects/project-data/logical-transcript';
import type { Env as ProjectDataEnv } from '../../../src/durable-objects/project-data/types';
import { log } from '../../../src/lib/logger';
import {
  getLatestAssistantMessageForTask,
  getRecentAssistantMessagesForTask,
} from '../../../src/services/task-final-assistant-message';
import { createSqlStorage } from '../durable-objects/sql-storage-test-utils';

vi.mock('../../../src/services/project-data', () => ({
  getLogicalTranscriptPage: vi.fn(),
}));

vi.mock('../../../src/services/connector-read-settings', () => ({
  getConnectorReadLimits: vi.fn(),
}));

import * as connectorReadSettings from '../../../src/services/connector-read-settings';
import * as projectDataService from '../../../src/services/project-data';

const PROJECT = 'proj-1';
const SESSION = 'session-1';
const mockGetLogicalTranscriptPage = vi.mocked(projectDataService.getLogicalTranscriptPage);
const mockGetConnectorReadLimits = vi.mocked(connectorReadSettings.getConnectorReadLimits);
const mockEnv = {} as Parameters<typeof getLatestAssistantMessageForTask>[0];

interface SeedRow {
  id: string;
  role: string;
  content: string;
}

describe('task assistant messages', () => {
  let sql: SqlStorage;
  let nextRow = 0;

  function seed(rows: SeedRow[]): void {
    for (const row of rows) {
      nextRow += 1;
      sql.exec(
        `INSERT INTO chat_messages (id, session_id, role, content, created_at, sequence)
         VALUES (?, ?, ?, ?, ?, ?)`,
        row.id,
        SESSION,
        row.role,
        row.content,
        1_000 + nextRow,
        nextRow
      );
    }
  }

  /** A reply streamed as `count` chunk rows: `prefix001`, `prefix002`, ... */
  function streamed(prefix: string, count: number, text = (i: number) => `${prefix}${i}.`) {
    return Array.from({ length: count }, (_, index) => ({
      id: `${prefix}${String(index + 1).padStart(3, '0')}`,
      role: 'assistant',
      content: text(index + 1),
    }));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    nextRow = 0;
    const db = new Database(':memory:');
    sql = createSqlStorage(db);
    runMigrations(sql);
    sql.exec(`INSERT INTO chat_sessions (id, topic, started_at) VALUES (?, ?, ?)`, SESSION, 't', 1);
    mockGetConnectorReadLimits.mockResolvedValue({
      transcriptScanRows: 4_000,
    } as Awaited<ReturnType<typeof connectorReadSettings.getConnectorReadLimits>>);
    mockGetLogicalTranscriptPage.mockImplementation((_env, projectId, sessionId, request) =>
      readSourceLogicalTranscript(
        sql,
        {} as ProjectDataEnv,
        { projectId, sessionId, ownerName: projectId, generation: 1, migrationId: null },
        request
      )
    );
  });

  it('returns nothing without a session, and does not read', async () => {
    expect(await getLatestAssistantMessageForTask(mockEnv, PROJECT, null)).toBeNull();
    expect(await getRecentAssistantMessagesForTask(mockEnv, PROJECT, null, 5)).toEqual([]);
    expect(mockGetLogicalTranscriptPage).not.toHaveBeenCalled();
  });

  it('returns null when the chat has no assistant reply', async () => {
    seed([{ id: 'u1', role: 'user', content: 'Hello?' }]);

    expect(await getLatestAssistantMessageForTask(mockEnv, PROJECT, SESSION)).toBeNull();
    expect(mockGetLogicalTranscriptPage).toHaveBeenCalledTimes(1);
  });

  it('returns null when the newest reply is only whitespace', async () => {
    seed([
      { id: 'a1', role: 'assistant', content: 'Earlier reply' },
      { id: 'u1', role: 'user', content: 'And now?' },
      { id: 'a2', role: 'assistant', content: '   ' },
    ]);

    expect(await getLatestAssistantMessageForTask(mockEnv, PROJECT, SESSION)).toBeNull();
  });

  it('assembles the whole newest reply from every streamed chunk', async () => {
    // 300 chunk rows: more than the 200-row tail the raw-row reader used to scan.
    seed([{ id: 'u1', role: 'user', content: 'Review this' }, ...streamed('r', 300)]);
    const expected = Array.from({ length: 300 }, (_, i) => `r${i + 1}.`).join('');

    const latest = await getLatestAssistantMessageForTask(mockEnv, PROJECT, SESSION);

    expect(expected.length).toBeLessThan(2_000);
    expect(latest).toEqual({ id: 'r001', content: expected, createdAt: 1_002 });
  });

  it('marks a reply whose start lies beyond the scan budget as partialBefore', async () => {
    mockGetConnectorReadLimits.mockResolvedValue({
      transcriptScanRows: 250,
    } as Awaited<ReturnType<typeof connectorReadSettings.getConnectorReadLimits>>);
    seed([{ id: 'u1', role: 'user', content: 'Review this' }, ...streamed('r', 300)]);

    const latest = await getLatestAssistantMessageForTask(mockEnv, PROJECT, SESSION);

    expect(latest).toMatchObject({ partialBefore: true });
    expect(latest!.content.endsWith('r300.')).toBe(true);
    expect(latest!.content.startsWith('r1.')).toBe(false);
  });

  it('caps a long reply at the snippet length and says it was truncated', async () => {
    seed(streamed('x', 25, () => 'x'.repeat(100)));

    const latest = await getLatestAssistantMessageForTask(mockEnv, PROJECT, SESSION);

    expect(latest!.content).toHaveLength(2_003);
    expect(latest!.content.endsWith('...')).toBe(true);
    expect(latest).toMatchObject({ truncated: true });
  });

  it('does not mark a reply of exactly the snippet length as truncated', async () => {
    seed(streamed('x', 20, () => 'x'.repeat(100)));

    const latest = await getLatestAssistantMessageForTask(mockEnv, PROJECT, SESSION);

    expect(latest!.content).toHaveLength(2_000);
    expect(latest).not.toHaveProperty('truncated');
  });

  it('lists recent replies newest first, each whole, skipping user and tool rows', async () => {
    seed([
      { id: 'u1', role: 'user', content: 'Start' },
      ...streamed('a', 3),
      { id: 't1', role: 'tool', content: '' },
      ...streamed('b', 2),
      { id: 'u2', role: 'user', content: 'More' },
      ...streamed('c', 4),
    ]);

    const recent = await getRecentAssistantMessagesForTask(mockEnv, PROJECT, SESSION, 5);

    expect(recent.map((message) => [message.id, message.content])).toEqual([
      ['c001', 'c1.c2.c3.c4.'],
      ['b001', 'b1.b2.'],
      ['a001', 'a1.a2.a3.'],
    ]);
  });

  it('keeps each of several long recent replies whole up to the snippet length', async () => {
    const long = (prefix: string) => streamed(prefix, 15, () => prefix.repeat(100));
    seed([
      ...long('a'),
      { id: 'u1', role: 'user', content: 'Next' },
      ...long('b'),
      { id: 'u2', role: 'user', content: 'Next' },
      ...long('c'),
    ]);

    const recent = await getRecentAssistantMessagesForTask(mockEnv, PROJECT, SESSION, 5);

    expect(recent.map((message) => [message.id, message.content.length])).toEqual([
      ['c001', 1_500],
      ['b001', 1_500],
      ['a001', 1_500],
    ]);
    expect(recent.some((message) => message.truncated)).toBe(false);
  });

  it('returns at most the requested number of recent replies', async () => {
    seed([
      ...streamed('a', 2),
      { id: 'u1', role: 'user', content: 'Next' },
      ...streamed('b', 2),
      { id: 'u2', role: 'user', content: 'Next' },
      ...streamed('c', 2),
    ]);

    const recent = await getRecentAssistantMessagesForTask(mockEnv, PROJECT, SESSION, 2);

    expect(recent.map((message) => message.id)).toEqual(['c001', 'b001']);
  });

  it('returns nothing and logs when the transcript cannot be read', async () => {
    const warn = vi.spyOn(log, 'warn');
    mockGetLogicalTranscriptPage.mockRejectedValue(new Error('ProjectData unavailable'));

    expect(await getLatestAssistantMessageForTask(mockEnv, PROJECT, SESSION)).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      'get_recent_assistant_messages_for_task_failed',
      expect.objectContaining({ projectId: PROJECT, sessionId: SESSION })
    );
  });
});
