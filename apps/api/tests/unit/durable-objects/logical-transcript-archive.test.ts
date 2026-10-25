/**
 * Whole-message reads of an archived chat. Old chats move from the root ProjectData object to an
 * archive shard (SQLite rows, or compact gzip chunks in R2), and every whole-message read of such
 * a chat goes through the target reader. The chat is archived here through the production archive
 * steps (prepare, export, commit, seal), and each archived read must equal the same read taken
 * from the live transcript before it moved.
 */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runMigrations } from '../../../src/durable-objects/migrations';
import * as archive from '../../../src/durable-objects/project-data/archive-sharding';
import {
  readSourceLogicalMessage,
  readTargetLogicalMessage,
} from '../../../src/durable-objects/project-data/logical-message';
import {
  type LogicalTranscriptRequest,
  type LogicalTranscriptResult,
  readSourceLogicalTranscript,
  readTargetLogicalTranscript,
} from '../../../src/durable-objects/project-data/logical-transcript';
import {
  readTargetMessageContext,
  targetTranscriptReader,
} from '../../../src/durable-objects/project-data/message-context';
import type { Env } from '../../../src/durable-objects/project-data/types';
import { writeCompactChunk } from '../../../src/project-data-archive/compact-r2';
import { PROJECT_DATA_ARCHIVE_TABLES } from '../../../src/project-data-archive/contract';
import { createSqlStorage } from './sql-storage-test-utils';

const BASE = {
  projectId: 'project',
  sessionId: 'session',
  migrationId: 'migration',
  sourceOwnerName: 'project',
  targetOwnerName: 'project:archive:g1:s0',
  targetGeneration: 1,
  sourceIntentToken: 'intent',
  now: 2_000_000,
  minTerminalAgeMs: 0,
};
const SOURCE_OWNER = {
  projectId: BASE.projectId,
  sessionId: BASE.sessionId,
  ownerName: BASE.projectId,
  generation: 1,
  migrationId: null,
};
const TARGET_OWNER = {
  projectId: BASE.projectId,
  sessionId: BASE.sessionId,
  ownerName: BASE.targetOwnerName,
  generation: BASE.targetGeneration,
  migrationId: BASE.migrationId,
};

function memoryR2() {
  const objects = new Map<string, Uint8Array>();
  return {
    head: vi.fn(async (key: string) =>
      objects.has(key) ? { size: objects.get(key)?.byteLength } : null
    ),
    put: vi.fn(async (key: string, value: Uint8Array, options?: R2PutOptions) => {
      if (options?.onlyIf && objects.has(key)) return null;
      objects.set(key, new Uint8Array(value));
      return {};
    }),
    get: vi.fn(async (key: string) => {
      const body = objects.get(key);
      return body ? { size: body.byteLength, body: new Response(body).body } : null;
    }),
  } as unknown as R2Bucket;
}

/** u1 | a1–a5 | tool call | u2 | b1–b7 (one reply) | thought | tool call | c1. Stored content is
 * never empty: the message batch route rejects empty rows. */
const CONVERSATION: Array<{ id: string; role: string; content: string; tool?: object }> = [
  { id: 'u1', role: 'user', content: 'First question' },
  ...Array.from({ length: 5 }, (_, i) => ({
    id: `a${i + 1}`,
    role: 'assistant',
    content: `a${i + 1}.`,
  })),
  {
    id: 't1',
    role: 'tool',
    content: 'Read notes.md',
    tool: {
      toolCallId: 'call-1',
      status: 'pending',
      kind: 'read',
      toolName: 'Read',
      title: 'Read notes.md',
    },
  },
  {
    id: 't2',
    role: 'tool',
    content: 'file text',
    tool: { toolCallId: 'call-1', status: 'completed' },
  },
  { id: 'u2', role: 'user', content: 'Second question' },
  ...Array.from({ length: 7 }, (_, i) => ({
    id: `b${i + 1}`,
    role: 'assistant',
    content: `b${i + 1}.`,
  })),
  { id: 'th1', role: 'thinking', content: 'private reasoning' },
  {
    id: 't3',
    role: 'tool',
    content: 'pnpm test',
    tool: {
      toolCallId: 'call-2',
      status: 'in_progress',
      kind: 'execute',
      toolName: 'Bash',
      title: 'pnpm test',
    },
  },
  { id: 'c1', role: 'assistant', content: 'Final answer' },
];

describe('whole-message reads of an archived chat', () => {
  afterEach(() => vi.restoreAllMocks());

  function liveSource(conversation: typeof CONVERSATION = CONVERSATION): {
    db: Database.Database;
    sql: SqlStorage;
  } {
    const db = new Database(':memory:');
    const sql = createSqlStorage(db);
    runMigrations(sql);
    sql.exec(
      `INSERT INTO chat_sessions (id, status, message_count, started_at, ended_at,
         created_at, updated_at, agent_completed_at, materialized_at)
       VALUES ('session', 'stopped', ?, 1000, 1500, 1000, 1500, 1500, 1500)`,
      conversation.length
    );
    conversation.forEach((row, index) => {
      sql.exec(
        `INSERT INTO chat_messages (id, session_id, role, content, tool_metadata, created_at, sequence, origin)
         VALUES (?, 'session', ?, ?, ?, ?, ?, NULL)`,
        row.id,
        row.role,
        row.content,
        row.tool ? JSON.stringify(row.tool) : null,
        1000 + index,
        index
      );
    });
    return { db, sql };
  }

  /** Move the chat to an archive shard through the production archive steps. */
  async function archiveTo(
    source: SqlStorage,
    storageFormat: 'sqlite-v1' | 'r2-gzip-v1',
    chunkRows = 4
  ): Promise<{ target: SqlStorage; env: Env & { PROJECT_DATA_ARCHIVE_R2: R2Bucket } }> {
    const target = createSqlStorage(new Database(':memory:'));
    runMigrations(target);
    const bucket = memoryR2();
    const env = { PROJECT_DATA_ARCHIVE_R2: bucket } as unknown as Env & {
      PROJECT_DATA_ARCHIVE_R2: R2Bucket;
    };
    const prepared = await archive.prepareArchiveSourceIntentOrRefuse(source, BASE);
    if ('refused' in prepared || !('terminalVersionSha256' in prepared)) {
      throw new Error(`archive refused: ${JSON.stringify(prepared)}`);
    }
    archive.prepareArchiveTarget(target, {
      ...BASE,
      terminalVersionSha256: prepared.terminalVersionSha256,
      sessionRow: prepared.sessionRow,
      expectedMessageCount: prepared.messageCount,
      storageFormat,
    });
    const hashes: string[] = [];
    for (const tableName of PROJECT_DATA_ARCHIVE_TABLES) {
      let cursor: string | null = null;
      let ordinal = 0;
      do {
        // Small chunks by default, so one read spans several of them.
        const chunk = await archive.exportArchiveChunk(source, {
          ...BASE,
          tableName,
          ordinal,
          cursor,
          maxRows: chunkRows,
          maxBytes: 100_000,
        });
        const rawChunkRef =
          storageFormat === 'r2-gzip-v1' && tableName === 'chat_messages'
            ? await writeCompactChunk(bucket, 'archive', chunk)
            : undefined;
        await archive.commitArchiveTargetChunk(
          target,
          { ...chunk, rawChunkRef, now: BASE.now },
          env
        );
        hashes.push(chunk.sha256);
        cursor = chunk.hasMore ? chunk.cursor : null;
        ordinal += 1;
      } while (cursor);
    }
    await archive.sealArchiveTarget(
      target,
      {
        ...BASE,
        terminalVersionSha256: prepared.terminalVersionSha256,
        expectedChunkHashes: hashes,
      },
      env
    );
    return { target, env };
  }

  async function allPages(
    read: (request: LogicalTranscriptRequest) => Promise<LogicalTranscriptResult>,
    request: Omit<LogicalTranscriptRequest, 'before'>
  ): Promise<LogicalTranscriptResult[]> {
    const pages: LogicalTranscriptResult[] = [];
    let before: LogicalTranscriptRequest['before'] = null;
    do {
      const page = await read({ ...request, before });
      pages.push(page);
      before = page.nextCursor;
    } while (before && pages.length < 50);
    return pages;
  }

  const REQUESTS: Array<[string, Omit<LogicalTranscriptRequest, 'before'>]> = [
    [
      'two messages a page, with the latest request and reply',
      {
        limit: 2,
        roles: ['user', 'assistant', 'system'],
        maxScanRows: 5_000,
        maxMessageChars: 10_000,
        maxPageChars: 100_000,
        includeLatest: true,
        includeToolTitles: true,
      },
    ],
    [
      'assistant replies only, one a page, cut to six characters',
      {
        limit: 1,
        roles: ['assistant'],
        maxScanRows: 5_000,
        maxMessageChars: 6,
        maxPageChars: 100_000,
        includeLatest: false,
        includeToolTitles: false,
      },
    ],
  ];

  it.each(['sqlite-v1', 'r2-gzip-v1'] as const)(
    'pages an archived chat exactly as it paged live (%s)',
    async (storageFormat) => {
      const source = liveSource();
      const live = new Map<string, LogicalTranscriptResult[]>();
      for (const [name, request] of REQUESTS) {
        live.set(
          name,
          await allPages(
            (page) => readSourceLogicalTranscript(source.sql, {} as Env, SOURCE_OWNER, page),
            request
          )
        );
      }
      const liveReply = await readSourceLogicalMessage(source.sql, {} as Env, SOURCE_OWNER, {
        messageId: 'b4',
        maxRows: 5_000,
        offset: 3,
        maxChars: 5,
        focus: null,
        includeThinking: false,
        includeToolTitles: false,
      });

      const { target, env } = await archiveTo(source.sql, storageFormat);

      for (const [name, request] of REQUESTS) {
        const archived = await allPages(
          (page) => readTargetLogicalTranscript(target, env, TARGET_OWNER, page),
          request
        );
        expect(archived, name).toEqual(live.get(name));
        expect(archived.length, name).toBeGreaterThan(1);
      }
      expect(
        await readTargetLogicalMessage(target, env, TARGET_OWNER, {
          messageId: 'b4',
          maxRows: 5_000,
          offset: 3,
          maxChars: 5,
          focus: null,
          includeThinking: false,
          includeToolTitles: false,
        })
      ).toEqual(liveReply);
      expect(liveReply.message).toMatchObject({
        messageId: 'b1',
        content: 'b2.b3',
        complete: true,
      });
      source.db.close();
    }
  );

  it('gives one archived read a single R2 time budget across its pages', async () => {
    const source = liveSource();
    const { target, env } = await archiveTo(source.sql, 'r2-gzip-v1');
    let clock = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const bucket = env.PROJECT_DATA_ARCHIVE_R2;
    const get = bucket.get.bind(bucket);
    // Every R2 read takes 400 ms of a 1 s budget: one read's first two pages fit, the third does
    // not. With a fresh budget per page, every page would fit.
    bucket.get = ((key: string) => {
      clock += 400;
      return get(key);
    }) as typeof bucket.get;
    const budgeted = { ...env, PROJECT_DATA_ARCHIVE_R2_TIMEOUT_MS: '1000' } as Env;

    const reader = targetTranscriptReader(target, budgeted, TARGET_OWNER, true, 'test read');
    const first = await reader.page({ before: null, after: null }, 1, 'desc');
    const oldest = first.messages[0]!;
    const before = {
      createdAt: oldest.createdAt as number,
      sequence: oldest.sequence as number,
      id: oldest.id as string,
    };
    await reader.page({ before, after: null }, 1, 'desc');
    await expect(reader.page({ before, after: null }, 1, 'desc')).rejects.toThrow(/deadline/);

    // A new read starts a new budget.
    const fresh = targetTranscriptReader(target, budgeted, TARGET_OWNER, true, 'test read');
    await expect(fresh.page({ before: null, after: null }, 1, 'desc')).resolves.toMatchObject({
      messages: [expect.objectContaining({ id: 'c1' })],
    });
    source.db.close();
  });

  /** 30 exchanges: a request, then a reply streamed as 19 rows. 600 rows in all. */
  const LONG_CHAT = Array.from({ length: 30 }, (_, exchange) => [
    { id: `u${exchange}`, role: 'user', content: `Question ${exchange}` },
    ...Array.from({ length: 19 }, (_, chunk) => ({
      id: `a${exchange}-${chunk}`,
      role: 'assistant',
      content: `${exchange}.${chunk} `,
    })),
  ]).flat();

  /** Every R2 read takes 400 ms of a 1 s budget: one read gets through about two pages. */
  function slowR2(env: Env & { PROJECT_DATA_ARCHIVE_R2: R2Bucket }) {
    let clock = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const bucket = env.PROJECT_DATA_ARCHIVE_R2;
    const get = bucket.get.bind(bucket);
    bucket.get = ((key: string) => {
      clock += 400;
      return get(key);
    }) as typeof bucket.get;
    return { ...env, PROJECT_DATA_ARCHIVE_R2_TIMEOUT_MS: '1000' } as Env;
  }

  it('returns what an archived read got through when its time runs out, and resumes', async () => {
    const source = liveSource(LONG_CHAT);
    const { target, env } = await archiveTo(source.sql, 'r2-gzip-v1', 300);
    const budgeted = slowR2(env);
    const request = {
      limit: 100,
      roles: ['user', 'assistant'],
      maxScanRows: 5_000,
      maxMessageChars: 10_000,
      maxPageChars: 1_000_000,
      includeLatest: false,
      includeToolTitles: false,
    };

    const entries: LogicalTranscriptResult['entries'] = [];
    let before: LogicalTranscriptRequest['before'] = null;
    let cutByTime = 0;
    for (let reads = 0; reads < 20; reads += 1) {
      // Each read has a fresh budget and continues from the previous read's cursor.
      const page = await readTargetLogicalTranscript(target, budgeted, TARGET_OWNER, {
        ...request,
        before,
      });
      expect(page.entries.length).toBeGreaterThan(0);
      if (page.scanBudgetExhausted) cutByTime += 1;
      entries.push(...page.entries);
      before = page.nextCursor;
      if (!page.hasMore) break;
    }
    expect(cutByTime).toBeGreaterThan(0);

    const ids = entries.flatMap((entry) => (entry.kind === 'message' ? [entry.messageId] : []));
    expect(ids).toEqual(
      LONG_CHAT.filter((row) => row.id.startsWith('u') || row.id.endsWith('-0'))
        .map((row) => row.id)
        .reverse()
    );
    expect(entries.every((entry) => entry.complete)).toBe(true);
    source.db.close();
  });

  it('returns the part of an archived message read before its time ran out', async () => {
    const reply = [
      { id: 'u0', role: 'user', content: 'Write it all' },
      ...Array.from({ length: 599 }, (_, chunk) => ({
        id: `r${chunk}`,
        role: 'assistant',
        content: `${chunk} `,
      })),
    ];
    const source = liveSource(reply);
    const { target, env } = await archiveTo(source.sql, 'r2-gzip-v1', 300);
    const budgeted = slowR2(env);

    const result = await readTargetLogicalMessage(target, budgeted, TARGET_OWNER, {
      messageId: 'r598',
      maxRows: 5_000,
      offset: 0,
      maxChars: 100_000,
      focus: null,
      includeThinking: false,
      includeToolTitles: false,
    });

    expect(result.found).toBe(true);
    expect(result.message?.complete).toBe(false);
    expect(result.message?.content.endsWith('598 ')).toBe(true);
    expect(result.message?.content.startsWith('0 ')).toBe(false);
    source.db.close();
  });

  it('ends a side of an archived comment context where its time ran out', async () => {
    const source = liveSource(LONG_CHAT);
    const { target, env } = await archiveTo(source.sql, 'r2-gzip-v1', 300);
    const budgeted = slowR2(env);

    // Both sides read at once and share one budget, which the anchor and their first R2 reads
    // use up: the read still returns the anchor, and says both sides have more.
    const context = await readTargetMessageContext(target, budgeted, TARGET_OWNER, {
      messageId: 'u29',
      messagesEachSide: 1_000,
      maxRows: 5_000,
      compact: true,
    });

    expect(context).toMatchObject({ found: true, hasMoreBefore: true, hasMoreAfter: true });
    expect(context.messages.map((row) => row.id)).toContain('u29');
    source.db.close();
  });
});
