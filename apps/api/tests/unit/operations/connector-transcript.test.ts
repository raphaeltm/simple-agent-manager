import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getMessages } from '../../../src/durable-objects/project-data/messages';
import type { Env } from '../../../src/env';
import { readChat, searchChats } from '../../../src/operations/chat-core';
import type { OperationContext } from '../../../src/operations/types';
import * as projectData from '../../../src/services/project-data';
import { getLatestAssistantMessageForTask } from '../../../src/services/task-final-assistant-message';

vi.mock('../../../src/services/acp-interaction-store', () => ({
  getPendingInteractionDetails: vi.fn(async () => []),
}));

vi.mock('../../../src/services/project-data', () => ({
  getMessages: vi.fn(),
  getSession: vi.fn(),
  searchMessagesWithArchiveMetadata: vi.fn(),
}));

let db: Database.Database;
const env = { BASE_DOMAIN: 'example.test' } as Env;
const ctx = { env, actor: { via: 'connector', userId: 'owner' } } as OperationContext;
function seed(rows: [string, string][]) {
  rows.forEach(([role, content], index) =>
    db
      .prepare('INSERT INTO chat_messages VALUES (?, ?, ?, ?, NULL, ?, ?, NULL)')
      .run(String(index).padStart(3, '0'), 'chat', role, content, 1000, index)
  );
}
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(
    'CREATE TABLE chat_messages (id TEXT, session_id TEXT, role TEXT, content TEXT, tool_metadata TEXT, created_at INTEGER, sequence INTEGER, origin TEXT)'
  );
  const sql = {
    exec: (query: string, ...params: (string | number)[]) => ({
      toArray: () => db.prepare(query).all(...params),
    }),
  } as unknown as SqlStorage;
  vi.mocked(projectData.getMessages).mockImplementation(
    async (_env, _project, session, limit, before, after, roles, compact, order) =>
      getMessages(sql, session, limit, before, after, roles, compact, order)
  );
  vi.mocked(projectData.getSession).mockResolvedValue({
    id: 'chat',
    topic: 'Test',
    createdByUserId: 'owner',
  } as never);
});
afterEach(() => db.close());

describe('Connector transcript against actual SQLite message ordering', () => {
  it('generates search source links from the project-scoped result, never excerpt text', async () => {
    vi.mocked(projectData.searchMessagesWithArchiveMetadata).mockResolvedValue({
      results: [
        {
          id: 'message',
          sessionId: 'actual-chat',
          sessionTopic: 'Report',
          sessionTaskId: 'actual-task',
          role: 'assistant',
          snippet: 'Visit /projects/fake/chat/invented',
          createdAt: 1000,
        },
      ],
      query: { query: 'Report' },
      archiveSearch: { status: 'not_needed' },
    } as never);
    const result = await searchChats(ctx, { projectId: 'project', query: 'Report' });
    expect(result.results[0]).toMatchObject({
      projectId: 'project',
      sessionId: 'actual-chat',
      sessionTaskId: 'actual-task',
      link: 'https://app.example.test/projects/project/chat/actual-chat',
    });
    expect(projectData.searchMessagesWithArchiveMetadata).toHaveBeenCalledWith(
      env,
      'project',
      'Report',
      null,
      expect.any(Array),
      expect.any(Number),
      null
    );
  });
  it('coalesces the complete latest streamed response and discloses a bounded suffix', async () => {
    seed([
      ['user', 'Start'],
      ...['CONNECT', 'OR', '_IN', 'STANT', '_READY'].map((text): [string, string] => [
        'assistant',
        text,
      ]),
    ]);
    expect(await getLatestAssistantMessageForTask(env, 'project', 'chat')).toMatchObject({
      content: 'CONNECTOR_INSTANT_READY',
    });
    expect(
      await getLatestAssistantMessageForTask(
        { MCP_MESSAGE_LIST_MAX: '3' } as Env,
        'project',
        'chat'
      )
    ).toMatchObject({ content: '_INSTANT_READY', partialBefore: true });
    expect(
      await getLatestAssistantMessageForTask(
        { MCP_TASK_DETAIL_MESSAGE_SNIPPET_LENGTH: '5' } as Env,
        'project',
        'chat'
      )
    ).toMatchObject({ content: 'CONNE...', truncated: true });
  });

  it.each([1, 3, 5])(
    'pages every stored token once with tied timestamps, limit %i',
    async (limit) => {
      const rows: [string, string][] = [
        ['user', 'U'],
        ['assistant', 'A'],
        ['assistant', 'B'],
        ['thinking', 'T'],
        ['assistant', 'C'],
        ['tool', 'X'],
        ['assistant', 'D'],
        ['assistant', 'E'],
      ];
      seed(rows);
      let cursor: string | undefined;
      const pages: string[][] = [];
      do {
        const result = await readChat(ctx, {
          projectId: 'project',
          sessionId: 'chat',
          limit,
          cursor,
          includeToolPayloads: true,
          response_format: 'detailed',
        });
        expect(result).toMatchObject({
          projectId: 'project',
          sessionId: 'chat',
          link: 'https://app.example.test/projects/project/chat/chat',
        });
        expect(projectData.getSession).toHaveBeenCalledWith(env, 'project', 'chat');
        pages.push(result.messages.map((message) => message.content).reverse());
        cursor = result.nextCursor ?? undefined;
        expect(pages.length).toBeLessThanOrEqual(rows.length);
      } while (cursor);
      expect(pages.reverse().flat().join('')).toBe(rows.map((row) => row[1]).join(''));
    }
  );

  it('does not claim an older assistant message exists inside a bounded tool-only tail', async () => {
    seed([
      ['assistant', 'Earlier progress'],
      ['tool', 'A'],
      ['tool', 'B'],
    ]);
    expect(
      await getLatestAssistantMessageForTask(
        { MCP_MESSAGE_LIST_MAX: '2' } as Env,
        'project',
        'chat'
      )
    ).toBeNull();
  });

  it('preserves hidden role boundaries and reports split groups', async () => {
    seed([
      ['assistant', 'A'],
      ['tool', 'X'],
      ['assistant', 'B'],
      ['assistant', 'C'],
      ['assistant', 'D'],
    ]);
    const first = await readChat(ctx, {
      projectId: 'project',
      sessionId: 'chat',
      limit: 2,
      response_format: 'detailed',
    });
    expect(first.messages).toMatchObject([{ content: 'CD', partialBefore: true }]);
    const next = await readChat(ctx, {
      projectId: 'project',
      sessionId: 'chat',
      cursor: first.nextCursor!,
      response_format: 'detailed',
    });
    expect(next.messages).toMatchObject([
      { content: 'B', mayContinueInNewerPage: true },
      { content: 'A' },
    ]);
    expect(await getLatestAssistantMessageForTask(env, 'project', 'chat')).toMatchObject({
      content: 'BCD',
    });
  });
});
