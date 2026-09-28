import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import { handleSearchKnowledge } from '../../src/routes/mcp/knowledge-tools';
import { handleSearchMessages } from '../../src/routes/mcp/session-tools';
import type { McpTokenData } from '../../src/services/mcp-token';
import type { ProjectDataTestDouble } from './support/expected-error-doubles';

const SAFE_PREFIX = Array.from({ length: 6 }, (_, index) => `needle${index}`).join(' ');
const OVER_LIMIT_QUERY = `${SAFE_PREFIX} ${'overflow '.repeat(8_000)}`;
const LIKE_METACHARACTER_PREFIX = '%'.repeat(24);

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

describe('ProjectData search query limits with real Durable Object SQLite', () => {
  it('knowledge search truncates a SQLite-invalid long query and returns a match', async () => {
    const stub = freshStub();
    const { id: entityId } = await stub.createKnowledgeEntity('Search limits', 'context', null);
    await stub.addKnowledgeObservation(entityId, SAFE_PREFIX, 0.9, 'explicit', null);

    const results = await stub.searchKnowledgeObservations(OVER_LIMIT_QUERY, null, null, 10);

    expect(results.map((result) => result.content)).toEqual([SAFE_PREFIX]);
  });

  it('runs an over-limit query through the MCP knowledge handler into real DO SQLite', async () => {
    const projectId = `mcp-knowledge-search-limits-${crypto.randomUUID()}`;
    const stub = env.PROJECT_DATA.get(
      env.PROJECT_DATA.idFromName(projectId)
    ) as DurableObjectStub<ProjectDataTestDouble>;
    const { id: entityId } = await stub.createKnowledgeEntity('MCP search limits', 'context', null);
    await stub.addKnowledgeObservation(entityId, SAFE_PREFIX, 0.9, 'explicit', null);

    const response = await handleSearchKnowledge(
      1,
      { query: OVER_LIMIT_QUERY },
      tokenData(projectId),
      env as unknown as Env
    );
    expect(response.error).toBeUndefined();
    const result = response.result as { content: Array<{ text: string }> };
    const payload = JSON.parse(result.content[0]!.text) as {
      results: Array<{ content: string }>;
      query: string;
      queryTruncated: boolean;
    };
    expect(payload.results.map((item) => item.content)).toEqual([SAFE_PREFIX]);
    expect(payload.query).toBe(SAFE_PREFIX);
    expect(payload.queryTruncated).toBe(true);
  });

  it('message search truncates a SQLite-invalid long query and returns a match', async () => {
    const stub = freshStub();
    await runInDurableObject(stub, async (_instance, state) => {
      const now = Date.now();
      state.storage.sql.exec(
        `INSERT INTO chat_sessions
           (id, topic, status, message_count, started_at, created_at, updated_at)
         VALUES ('session-1', 'Search limits', 'active', 1, ?, ?, ?)`,
        now,
        now,
        now
      );
      state.storage.sql.exec(
        `INSERT INTO chat_messages
           (id, session_id, role, content, tool_metadata, created_at, sequence)
         VALUES ('message-1', 'session-1', 'user', ?, NULL, ?, 1)`,
        SAFE_PREFIX,
        now
      );
    });

    const search = await stub.searchMessagesWithCoverage(
      OVER_LIMIT_QUERY,
      'session-1',
      ['user'],
      10
    );

    expect(search.results.map((result) => result.id)).toEqual(['message-1']);
    expect(search.query.queryTruncated).toBe(true);
    expect(search.query.query).toBe(SAFE_PREFIX);
  });

  it('runs an over-limit query through the MCP message handler into real DO SQLite', async () => {
    const suffix = crypto.randomUUID();
    const projectId = `mcp-message-search-${suffix}`;
    const userId = `mcp-message-user-${suffix}`;
    const installationId = `mcp-message-installation-${suffix}`;
    await env.DATABASE.batch([
      env.DATABASE.prepare('INSERT INTO users (id, email) VALUES (?, ?)').bind(
        userId,
        `${userId}@example.test`
      ),
      env.DATABASE.prepare(
        `INSERT INTO github_installations
           (id, user_id, installation_id, account_type, account_name)
         VALUES (?, ?, ?, 'User', ?)`
      ).bind(installationId, userId, suffix, userId),
      env.DATABASE.prepare(
        `INSERT INTO projects
           (id, user_id, name, normalized_name, installation_id, repository, created_by)
         VALUES (?, ?, 'Search limits', 'search-limits', ?, ?, ?)`
      ).bind(projectId, userId, installationId, `owner/repo-${suffix}`, userId),
      env.DATABASE.prepare(
        `INSERT INTO project_members (project_id, user_id, role, status)
         VALUES (?, ?, 'owner', 'active')`
      ).bind(projectId, userId),
    ]);

    const stub = env.PROJECT_DATA.get(
      env.PROJECT_DATA.idFromName(projectId)
    ) as DurableObjectStub<ProjectDataTestDouble>;
    await runInDurableObject(stub, async (_instance, state) => {
      const now = Date.now();
      state.storage.sql.exec(
        `INSERT INTO chat_sessions
           (id, topic, status, message_count, started_at, created_at, updated_at)
         VALUES ('session-1', 'MCP search limits', 'active', 1, ?, ?, ?)`,
        now,
        now,
        now
      );
      state.storage.sql.exec(
        `INSERT INTO chat_messages
           (id, session_id, role, content, tool_metadata, created_at, sequence)
         VALUES ('message-1', 'session-1', 'user', ?, NULL, ?, 1)`,
        SAFE_PREFIX,
        now
      );
    });

    const response = await handleSearchMessages(
      2,
      { query: OVER_LIMIT_QUERY, sessionId: 'session-1', roles: ['user'] },
      { ...tokenData(projectId), userId },
      env as unknown as Env
    );
    expect(response.error).toBeUndefined();
    const result = response.result as { content: Array<{ text: string }> };
    const payload = JSON.parse(result.content[0]!.text) as {
      results: Array<{ messageId: string }>;
      query: string;
      queryTruncated: boolean;
    };
    expect(payload.results.map((item) => item.messageId)).toEqual(['message-1']);
    expect(payload.query).toBe(SAFE_PREFIX);
    expect(payload.queryTruncated).toBe(true);
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
    await runInDurableObject(stub, async (_instance, state) => {
      const now = Date.now();
      state.storage.sql.exec(
        `INSERT INTO chat_sessions
           (id, topic, status, message_count, started_at, created_at, updated_at)
         VALUES ('session-1', 'Search limits', 'active', 2, ?, ?, ?)`,
        now,
        now,
        now
      );
      state.storage.sql.exec(
        `INSERT INTO chat_messages
           (id, session_id, role, content, tool_metadata, created_at, sequence)
         VALUES ('older', 'session-1', 'user', 'needle0 older', NULL, ?, 1)`,
        now
      );
      state.storage.sql.exec(
        `INSERT INTO chat_messages
           (id, session_id, role, content, tool_metadata, created_at, sequence)
         VALUES ('newer', 'session-1', 'user', 'needle0 newer', NULL, ?, 2)`,
        now + 1
      );
    });

    const search = await stub.searchMessagesWithCoverage('needle0', 'session-1', ['user'], 10);

    expect(search.results.map((result) => result.id)).toEqual(['newer', 'older']);
    expect(search.query.queryTruncated).toBe(false);
    expect(search.query.query).toBe('needle0');
  });
});
