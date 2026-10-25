import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readLogicalMessage } from '../../../src/durable-objects/project-data/logical-message';
import { readLogicalTranscriptPage } from '../../../src/durable-objects/project-data/logical-transcript';
import type { MessageContextReader } from '../../../src/durable-objects/project-data/message-context';
import { formatMessageRows, getMessages } from '../../../src/durable-objects/project-data/messages';
import type { Env } from '../../../src/env';
import { readChat, searchChats } from '../../../src/operations/chat-core';
import { readChatMessage } from '../../../src/operations/chat-transcript';
import type { OperationContext } from '../../../src/operations/types';
import { getConnectorReadLimits } from '../../../src/services/connector-read-settings';
import * as projectData from '../../../src/services/project-data';
import { getLatestAssistantMessageForTask } from '../../../src/services/task-final-assistant-message';

vi.mock('../../../src/services/acp-interaction-store', () => ({
  getPendingInteractionDetails: vi.fn(async () => []),
}));

vi.mock('../../../src/services/project-data', () => ({
  getMessages: vi.fn(),
  getSession: vi.fn(),
  searchMessagesWithArchiveMetadata: vi.fn(),
  getLogicalTranscriptPage: vi.fn(),
  getLogicalMessage: vi.fn(),
  resolveTranscriptOwner: vi.fn(async (_env: unknown, projectId: string, sessionId: string) => ({
    kind: 'root',
    projectId,
    sessionId,
    ownerName: projectId,
  })),
  listActiveAttentionMarkers: vi.fn(async () => []),
}));

vi.mock('../../../src/services/connector-read-settings', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/services/connector-read-settings')>();
  return { ...actual, getConnectorReadLimits: vi.fn(actual.getConnectorReadLimits) };
});

let db: Database.Database;
const env = { BASE_DOMAIN: 'example.test' } as Env;
const ctx = { env, actor: { via: 'connector', userId: 'owner' } } as OperationContext;
const agentCtx = {
  env,
  actor: { via: 'workspace-agent', userId: 'owner' },
} as OperationContext;

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
  // The Durable Object readers, over this database: the same row order and paging production uses.
  const reader: MessageContextReader = {
    locate: async (messageId) => {
      const row = db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(messageId);
      return row
        ? (formatMessageRows([row as Record<string, unknown>], 'chat', 1, true, 'asc')
            .messages[0] ?? null)
        : null;
    },
    page: async (bounds, limit, order) =>
      getMessages(sql, 'chat', limit, bounds.before, bounds.after, undefined, true, order),
  };
  vi.mocked(projectData.getMessages).mockImplementation(
    async (_env, _project, session, limit, before, after, roles, compact, order) =>
      getMessages(sql, session, limit, before, after, roles, compact, order)
  );
  vi.mocked(projectData.getLogicalTranscriptPage).mockImplementation(async (_e, _p, _s, request) =>
    readLogicalTranscriptPage(reader, request)
  );
  vi.mocked(projectData.getLogicalMessage).mockImplementation(async (_e, _p, _s, request) =>
    readLogicalMessage(reader, request)
  );
  vi.mocked(projectData.getSession).mockResolvedValue({
    id: 'chat',
    topic: 'Test',
    createdByUserId: 'owner',
  } as never);
});
afterEach(() => {
  db.close();
  vi.mocked(getConnectorReadLimits).mockReset();
});

async function scanRows(rows: number) {
  const actual = await vi
    .importActual<typeof import('../../../src/services/connector-read-settings')>(
      '../../../src/services/connector-read-settings'
    )
    .then((module) => module.getConnectorReadLimits(env));
  vi.mocked(getConnectorReadLimits).mockResolvedValue({ ...actual, transcriptScanRows: rows });
}

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

  it('returns the complete latest streamed reply for task details', async () => {
    seed([
      ['user', 'Start'],
      ...['CONNECT', 'OR', '_IN', 'STANT', '_READY'].map((text): [string, string] => [
        'assistant',
        text,
      ]),
    ]);
    expect(await getLatestAssistantMessageForTask(env, 'project', 'chat')).toMatchObject({
      id: '001',
      content: 'CONNECTOR_INSTANT_READY',
    });
    expect(
      await getLatestAssistantMessageForTask(
        { MCP_TASK_DETAIL_MESSAGE_SNIPPET_LENGTH: '5' } as Env,
        'project',
        'chat'
      )
    ).toMatchObject({ content: 'CONNE...', truncated: true });
    await scanRows(3);
    expect(await getLatestAssistantMessageForTask(env, 'project', 'chat')).toMatchObject({
      content: '_INSTANT_READY',
      partialBefore: true,
    });
  });

  it('does not claim an older assistant message exists inside a bounded tool-only tail', async () => {
    seed([
      ['assistant', 'Earlier progress'],
      ['tool', 'A'],
      ['tool', 'B'],
    ]);
    await scanRows(2);
    expect(await getLatestAssistantMessageForTask(env, 'project', 'chat')).toBeNull();
  });

  describe('stored-row unit (diagnostics, workspace agents)', () => {
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
            unit: 'rows',
          });
          expect(result).toMatchObject({
            projectId: 'project',
            sessionId: 'chat',
            paginationUnit: 'stored_rows',
            link: 'https://app.example.test/projects/project/chat/chat',
          });
          pages.push(result.messages.map((message) => message.content).reverse());
          cursor = result.nextCursor ?? undefined;
          expect(pages.length).toBeLessThanOrEqual(rows.length);
        } while (cursor);
        expect(pages.reverse().flat().join('')).toBe(rows.map((row) => row[1]).join(''));
      }
    );

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
        unit: 'rows',
      });
      expect(first.messages).toMatchObject([{ content: 'CD', partialBefore: true }]);
      const next = await readChat(ctx, {
        projectId: 'project',
        sessionId: 'chat',
        cursor: first.nextCursor!,
        response_format: 'detailed',
        unit: 'rows',
      });
      expect(next.messages).toMatchObject([
        { content: 'B', mayContinueInNewerPage: true },
        { content: 'A' },
      ]);
      expect(await getLatestAssistantMessageForTask(env, 'project', 'chat')).toMatchObject({
        content: 'BCD',
      });
    });

    it('keeps the workspace-agent shape: stored rows, no app fields', async () => {
      seed([
        ['user', 'Q'],
        ['assistant', 'A1'],
        ['assistant', 'A2'],
      ]);
      const result = await readChat(agentCtx, { projectId: 'project', sessionId: 'chat' });
      expect(result).not.toHaveProperty('paginationUnit');
      expect(result).not.toHaveProperty('link');
      expect(result).not.toHaveProperty('pendingAttention');
      expect(result.messages.map((message) => message.content)).toEqual(['Q', 'A1A2']);
    });
  });

  describe('whole-message unit (default for apps)', () => {
    it('returns whole replies, activity summaries and the latest request and reply', async () => {
      seed([
        ['user', 'Please audit the deploy'],
        ['assistant', 'Looking'],
        ['assistant', ' now.'],
        ['tool', 'grep output'],
        ['thinking', 'hidden plan'],
        ['assistant', 'The deploy is '],
        ['assistant', 'fine.'],
      ]);
      const result = await readChat(ctx, { projectId: 'project', sessionId: 'chat' });
      expect(result).toMatchObject({
        paginationUnit: 'logical_messages',
        hasMore: false,
        nextCursor: null,
        messageCount: 3,
        pendingAttention: [],
        latest: {
          assistant: { messageId: '005', inPage: true },
          user: { messageId: '000', inPage: true },
        },
      });
      expect(result.messages).toMatchObject([
        { kind: 'message', role: 'assistant', content: 'The deploy is fine.' },
        { kind: 'activity', toolCalls: 1, thinkingMessages: 1 },
        { kind: 'message', role: 'assistant', content: 'Looking now.' },
        { kind: 'message', role: 'user', sentBy: 'person', content: 'Please audit the deploy' },
      ]);
      expect(JSON.stringify(result)).not.toContain('grep output');
      expect(JSON.stringify(result)).not.toContain('hidden plan');
    });

    it('returns the latest request itself when it is not on the page, cut to fit', async () => {
      const request = `Please audit the deploy ${'and the rollout plan '.repeat(150)}`.trim();
      seed([
        ['user', request],
        ['assistant', 'Looking'],
        ['assistant', ' now.'],
        ['tool', 'grep output'],
        ['assistant', 'The deploy is '],
        ['assistant', 'fine.'],
      ]);
      // An 8,000-byte response cap leaves a 3,200-byte result, a quarter of it for each latest.
      const small = { ...env, CONNECTOR_RESPONSE_MAX_BYTES: '8000' } as Env;
      const smallCtx = { ...ctx, env: small } as OperationContext;

      const result = await readChat(smallCtx, {
        projectId: 'project',
        sessionId: 'chat',
        limit: 1,
      });

      expect(result.messages).toMatchObject([
        { kind: 'message', messageId: '004', content: 'The deploy is fine.' },
      ]);
      expect(result.latest?.assistant).toEqual({ messageId: '004', inPage: true });
      const user = result.latest?.user;
      expect(user).toMatchObject({
        inPage: false,
        messageId: '000',
        role: 'user',
        sentBy: 'person',
        contentLength: request.length,
        truncated: true,
      });
      if (!user || !('content' in user)) throw new Error('expected the latest request itself');
      expect(user.content.length).toBeGreaterThan(0);
      expect(request.startsWith(user.content)).toBe(true);
      expect(user.nextOffset).toBe(user.content.length);
      expect(new TextEncoder().encode(user.content).length).toBeLessThanOrEqual(3_200 / 4);
      expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(3_200);
    });

    it('cuts an oversized page at a message boundary and loses nothing across pages', async () => {
      const replies = Array.from({ length: 6 }, (_, index) => `${index}:${'x'.repeat(300)}`);
      seed(replies.map((reply): [string, string] => ['user', reply]));
      // A 2,000-byte response cap leaves an 800-byte result budget: a few messages per page.
      const small = { ...env, CONNECTOR_RESPONSE_MAX_BYTES: '2000' } as Env;
      const smallCtx = { ...ctx, env: small } as OperationContext;
      const seen: string[] = [];
      let cursor: string | undefined;
      let trimmedOnce = false;
      for (let pages = 0; pages < 10; pages += 1) {
        const result = await readChat(smallCtx, {
          projectId: 'project',
          sessionId: 'chat',
          cursor,
        });
        if ('coverage' in result) trimmedOnce ||= result.coverage.trimmedToFitResponse;
        for (const message of result.messages) seen.unshift(message.content);
        cursor = result.nextCursor ?? undefined;
        if (!cursor) break;
      }
      expect(trimmedOnce).toBe(true);
      expect(seen).toEqual(replies);
    });

    it('rejects an unknown role and accepts thinking on request', async () => {
      seed([
        ['thinking', 'reasoning'],
        ['assistant', 'answer'],
      ]);
      await expect(
        readChat(ctx, { projectId: 'project', sessionId: 'chat', roles: ['nope'] })
      ).rejects.toMatchObject({ code: 'invalid_input' });
      const result = await readChat(ctx, {
        projectId: 'project',
        sessionId: 'chat',
        roles: ['assistant', 'thinking'],
      });
      expect(result.messages.map((message) => message.content)).toEqual(['answer', 'reasoning']);
    });

    it('reads the rest of a long message by offset', async () => {
      seed([
        ['assistant', 'abc'],
        ['assistant', 'def'],
        ['assistant', 'ghi'],
      ]);
      const first = await readChatMessage(ctx, {
        projectId: 'project',
        sessionId: 'chat',
        messageId: '001',
        maxChars: 4,
      });
      expect(first).toMatchObject({
        complete: true,
        message: { messageId: '000', content: 'abcd', nextOffset: 4, contentLength: 9 },
      });
      const rest = await readChatMessage(ctx, {
        projectId: 'project',
        sessionId: 'chat',
        messageId: '000',
        offset: 4,
      });
      expect(rest.message).toMatchObject({ content: 'efghi', nextOffset: null });
      await expect(
        readChatMessage(ctx, { projectId: 'project', sessionId: 'chat', messageId: 'gone' })
      ).rejects.toMatchObject({ code: 'not_found' });
    });

    it('adds whole-message excerpts to app search results only', async () => {
      seed([
        ['assistant', 'The security '],
        ['assistant', 'audit'],
        ['assistant', ' found two issues.'],
      ]);
      const hit = (id: string) => ({
        id,
        sessionId: 'chat',
        sessionTopic: 'Report',
        sessionTaskId: null,
        role: 'assistant',
        snippet: 'audit',
        createdAt: 1000,
      });
      vi.mocked(projectData.searchMessagesWithArchiveMetadata).mockResolvedValue({
        results: [hit('001'), hit('002')],
        query: { query: 'audit' },
        archiveSearch: { status: 'not_needed' },
      } as never);
      vi.mocked(projectData.resolveTranscriptOwner).mockClear();
      vi.mocked(projectData.getLogicalMessage).mockClear();
      const app = await searchChats(ctx, { projectId: 'project', query: 'audit' });
      // Two hits in one chat: one lookup of who owns its transcript, passed to both reads.
      expect(projectData.resolveTranscriptOwner).toHaveBeenCalledTimes(1);
      expect(vi.mocked(projectData.getLogicalMessage).mock.calls.map((call) => call[4])).toEqual([
        expect.objectContaining({ sessionId: 'chat' }),
        expect.objectContaining({ sessionId: 'chat' }),
      ]);
      expect(app.results[0]).toMatchObject({
        snippet: 'audit',
        excerpt: {
          messageId: '000',
          text: 'The security audit found two issues.',
          matched: true,
          complete: true,
        },
      });
      const agent = await searchChats(agentCtx, { projectId: 'project', query: 'audit' });
      expect(agent.results[0]).not.toHaveProperty('excerpt');
      expect(agent).not.toHaveProperty('excerptCoverage');
    });
  });
});
