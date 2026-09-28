import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { ProjectDataTestDouble } from './support/expected-error-doubles';

const SAFE_PREFIX = Array.from({ length: 6 }, (_, index) => `needle${index}`).join(' ');
const OVER_LIMIT_QUERY = `${SAFE_PREFIX} ${'overflow '.repeat(8_000)}`;

function freshStub(): DurableObjectStub<ProjectDataTestDouble> {
  const projectId = `search-query-limits-${crypto.randomUUID()}`;
  return env.PROJECT_DATA.get(
    env.PROJECT_DATA.idFromName(projectId)
  ) as DurableObjectStub<ProjectDataTestDouble>;
}

describe('ProjectData search query limits with real Durable Object SQLite', () => {
  it('knowledge search truncates a SQLite-invalid long query and returns a match', async () => {
    const stub = freshStub();
    const { id: entityId } = await stub.createKnowledgeEntity('Search limits', 'context', null);
    await stub.addKnowledgeObservation(entityId, SAFE_PREFIX, 0.9, 'explicit', null);

    const results = await stub.searchKnowledgeObservations(OVER_LIMIT_QUERY, null, null, 10);

    expect(results.map((result) => result.content)).toEqual([SAFE_PREFIX]);
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
