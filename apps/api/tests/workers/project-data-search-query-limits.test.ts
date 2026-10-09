import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import { handleSearchKnowledge } from '../../src/routes/mcp/knowledge-tools';
import { handleSearchMessages } from '../../src/routes/mcp/session-tools';
import type { McpTokenData } from '../../src/services/mcp-token';
import { seedInstallation, seedProject, seedUser } from './helpers/seed-d1';
import type { ProjectDataTestDouble } from './support/expected-error-doubles';

const SEARCH_TERMS = Array.from({ length: 20 }, (_, index) => `needle${index}`);
const LONG_QUERY = SEARCH_TERMS.join(' ');
const PREFIX_ONLY_TEXT = SEARCH_TERMS.slice(0, 10).join(' ');
const ALL_TERMS_TEXT = SEARCH_TERMS.join(' ');
const LIKE_METACHARACTER_PREFIX = '%'.repeat(24);
const MAX_TERM_FALLBACK_QUERY = Array.from(
  { length: 40 },
  (_, index) => ['AND', 'OR', 'NOT', 'NEAR'][index % 4]
).join(' ');

function freshStub(): DurableObjectStub<ProjectDataTestDouble> {
  const projectId = `search-query-limits-${crypto.randomUUID()}`;
  return env.PROJECT_DATA.get(
    env.PROJECT_DATA.idFromName(projectId)
  ) as DurableObjectStub<ProjectDataTestDouble>;
}

function tokenData(projectId: string): McpTokenData {
  return {
    taskId: 'task-search-limits',
    projectId,
    userId: 'user-search-limits',
    workspaceId: 'workspace-search-limits',
    createdAt: new Date(0).toISOString(),
  };
}

async function createMcpProject(prefix: string): Promise<{ projectId: string; userId: string }> {
  const suffix = crypto.randomUUID();
  const projectId = `${prefix}-${suffix}`;
  const userId = `${prefix}-user-${suffix}`;
  const installationId = `${prefix}-installation-${suffix}`;
  await seedUser(userId);
  await seedInstallation(installationId, userId, { installationIdValue: suffix });
  await seedProject(projectId, userId, installationId, {
    name: `Search limits ${suffix}`,
    repository: `owner/repo-${suffix}`,
  });
  return { projectId, userId };
}

async function seedMessages(
  stub: DurableObjectStub<ProjectDataTestDouble>,
  sessionId: string,
  topic: string,
  messages: Array<{ id: string; content: string; createdAtOffset?: number }>
): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    const now = Date.now();
    state.storage.sql.exec(
      `INSERT INTO chat_sessions
         (id, topic, status, message_count, started_at, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?, ?, ?)`,
      sessionId,
      topic,
      messages.length,
      now,
      now,
      now
    );
    messages.forEach((message, index) => {
      state.storage.sql.exec(
        `INSERT INTO chat_messages
           (id, session_id, role, content, tool_metadata, created_at, sequence)
         VALUES (?, ?, 'user', ?, NULL, ?, ?)`,
        message.id,
        sessionId,
        message.content,
        now + (message.createdAtOffset ?? 0),
        index + 1
      );
    });
  });
}

describe('ProjectData search query limits with real Durable Object SQLite', () => {
  it('knowledge search uses late terms in a long query and excludes prefix-only controls', async () => {
    const stub = freshStub();
    const { id: entityId } = await stub.createKnowledgeEntity('Search limits', 'context', null);
    await stub.addKnowledgeObservation(entityId, PREFIX_ONLY_TEXT, 0.9, 'explicit', null);
    await stub.addKnowledgeObservation(entityId, ALL_TERMS_TEXT, 0.9, 'explicit', null);

    const results = await stub.searchKnowledgeObservations(LONG_QUERY, null, null, 10);

    expect(results.map((result) => result.content)).toEqual([ALL_TERMS_TEXT]);
  });

  it('runs a long query through the MCP knowledge handler into real DO SQLite', async () => {
    const { projectId, userId } = await createMcpProject('mcp-knowledge-search-limits');
    const stub = env.PROJECT_DATA.get(
      env.PROJECT_DATA.idFromName(projectId)
    ) as DurableObjectStub<ProjectDataTestDouble>;
    const { id: entityId } = await stub.createKnowledgeEntity('MCP search limits', 'context', null);
    await stub.addKnowledgeObservation(entityId, PREFIX_ONLY_TEXT, 0.9, 'explicit', null);
    await stub.addKnowledgeObservation(entityId, ALL_TERMS_TEXT, 0.9, 'explicit', null);

    const response = await handleSearchKnowledge(
      1,
      { query: LONG_QUERY },
      { ...tokenData(projectId), userId },
      env as unknown as Env
    );
    expect(response.error).toBeUndefined();
    const result = response.result as { content: Array<{ text: string }> };
    const payload = JSON.parse(result.content[0]!.text) as {
      results: Array<{ content: string }>;
      query: string;
      queryTruncated: boolean;
      queryLimits: { maxLength: number; maxTermLength: number; maxTerms: number };
    };
    expect(payload.results.map((item) => item.content)).toEqual([ALL_TERMS_TEXT]);
    expect(payload.query).toBe(LONG_QUERY);
    expect(payload.queryTruncated).toBe(false);
    expect(payload.queryLimits).toEqual({ maxLength: 4096, maxTermLength: 48, maxTerms: 40 });
  });

  it('message search uses late terms in a long query and excludes prefix-only controls', async () => {
    const stub = freshStub();
    await seedMessages(stub, 'session-1', 'Search limits', [
      { id: 'message-control', content: PREFIX_ONLY_TEXT },
      { id: 'message-match', content: ALL_TERMS_TEXT },
    ]);

    const search = await stub.searchMessagesWithCoverage(LONG_QUERY, 'session-1', ['user'], 10);

    expect(search.results.map((result) => result.id)).toEqual(['message-match']);
    expect(search.query.queryTruncated).toBe(false);
    expect(search.query.query).toBe(LONG_QUERY);
  });

  it('runs a long query through the MCP message handler into real DO SQLite', async () => {
    const { projectId, userId } = await createMcpProject('mcp-message-search');

    const stub = env.PROJECT_DATA.get(
      env.PROJECT_DATA.idFromName(projectId)
    ) as DurableObjectStub<ProjectDataTestDouble>;
    await seedMessages(stub, 'session-1', 'MCP search limits', [
      { id: 'message-control', content: PREFIX_ONLY_TEXT },
      { id: 'message-match', content: ALL_TERMS_TEXT },
    ]);

    const response = await handleSearchMessages(
      2,
      { query: LONG_QUERY, sessionId: 'session-1', roles: ['user'] },
      { ...tokenData(projectId), userId },
      env as unknown as Env
    );
    expect(response.error).toBeUndefined();
    const result = response.result as { content: Array<{ text: string }> };
    const payload = JSON.parse(result.content[0]!.text) as {
      results: Array<{ messageId: string }>;
      query: string;
      queryTruncated: boolean;
      queryLimits: { maxLength: number; maxTermLength: number; maxTerms: number };
    };
    expect(payload.results.map((item) => item.messageId)).toEqual(['message-match']);
    expect(payload.query).toBe(LONG_QUERY);
    expect(payload.queryTruncated).toBe(false);
    expect(payload.queryLimits).toEqual({ maxLength: 4096, maxTermLength: 48, maxTerms: 40 });
  });

  it('deduplicates roles before a max-term LIKE fallback reaches the bind ceiling', async () => {
    const { projectId, userId } = await createMcpProject('mcp-message-bind-budget');

    const stub = env.PROJECT_DATA.get(
      env.PROJECT_DATA.idFromName(projectId)
    ) as DurableObjectStub<ProjectDataTestDouble>;
    await seedMessages(stub, 'session-bind-budget', 'Bind budget', [
      { id: 'message-bind-budget', content: MAX_TERM_FALLBACK_QUERY },
    ]);

    const response = await handleSearchMessages(
      3,
      {
        query: MAX_TERM_FALLBACK_QUERY,
        sessionId: 'session-bind-budget',
        roles: Array.from({ length: 59 }, () => 'user'),
      },
      { ...tokenData(projectId), userId },
      env as unknown as Env
    );
    expect(response.error).toBeUndefined();
    const result = response.result as { content: Array<{ text: string }> };
    const payload = JSON.parse(result.content[0]!.text) as {
      results: Array<{ messageId: string }>;
      queryTruncated: boolean;
    };
    expect(payload.results.map((item) => item.messageId)).toEqual(['message-bind-budget']);
    expect(payload.queryTruncated).toBe(false);
  });

  it('accounts for LIKE escape bytes before querying real SQLite', async () => {
    const stub = freshStub();
    const { id: entityId } = await stub.createKnowledgeEntity('Escaped search', 'context', null);
    await stub.addKnowledgeObservation(
      entityId,
      `${LIKE_METACHARACTER_PREFIX} literal percent signs`,
      0.9,
      'explicit',
      null
    );

    const knowledge = await stub.searchKnowledgeObservations('%'.repeat(100), null, null, 10);

    expect(knowledge.map((result) => result.content)).toEqual([
      `${LIKE_METACHARACTER_PREFIX} literal percent signs`,
    ]);
  });

  it('keeps normal short-query ranking and results unchanged', async () => {
    const stub = freshStub();
    await seedMessages(stub, 'session-1', 'Search limits', [
      { id: 'older', content: 'needle0 older' },
      { id: 'newer', content: 'needle0 newer', createdAtOffset: 1 },
    ]);

    const search = await stub.searchMessagesWithCoverage('needle0', 'session-1', ['user'], 10);

    expect(search.results.map((result) => result.id)).toEqual(['newer', 'older']);
    expect(search.query.queryTruncated).toBe(false);
    expect(search.query.query).toBe('needle0');
  });
});
