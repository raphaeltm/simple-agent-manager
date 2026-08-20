/**
 * ProjectData same-class Durable Object sharding integration tests.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { ProjectDataTestDouble } from './support/expected-error-doubles';

const SHARD_TEST_ENV = {
  DO_SHARD_MIGRATION_THRESHOLD_BYTES: '1',
  DO_SHARD_AGGRESSIVE_THRESHOLD_BYTES: '1',
  DO_SHARD_HARD_BRAKE_THRESHOLD_BYTES: '999999999',
  DO_SHARD_TARGET_SIZE_BYTES: '1',
  DO_SHARD_MAX_SIZE_BYTES: '100000000',
  DO_SHARD_MIGRATION_BATCH_SIZE: '10',
  DO_SHARD_CHECK_INTERVAL_MS: '60000',
};

type MutableEnv = Record<string, string | undefined>;

function getStub(projectId: string): DurableObjectStub<ProjectDataTestDouble> {
  const id = env.PROJECT_DATA.idFromName(projectId);
  return env.PROJECT_DATA.get(id) as DurableObjectStub<ProjectDataTestDouble>;
}

function getShardStub(shardName: string): DurableObjectStub<ProjectDataTestDouble> {
  const id = env.PROJECT_DATA.idFromName(shardName);
  return env.PROJECT_DATA.get(id) as DurableObjectStub<ProjectDataTestDouble>;
}

async function withEnvOverrides<T>(
  instance: ProjectDataTestDouble,
  overrides: Record<string, string>,
  callback: () => Promise<T>
): Promise<T> {
  const mutableEnv = (instance as unknown as { env: MutableEnv }).env;
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, mutableEnv[key]);
    mutableEnv[key] = value;
  }
  try {
    return await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete mutableEnv[key];
      else mutableEnv[key] = value;
    }
  }
}

function countRows(sql: SqlStorage, query: string, ...params: string[]): number {
  const row = sql.exec(query, ...params).toArray()[0];
  return Number(row?.count ?? 0);
}

async function createSessionWithMessages(
  stub: DurableObjectStub<ProjectDataTestDouble>,
  topic: string,
  messages: Array<{ role: string; content: string }>
): Promise<string> {
  const sessionId = await stub.createSession(null, topic);
  for (const message of messages) {
    await stub.persistMessage(sessionId, message.role, message.content, null);
  }
  return sessionId;
}

async function runShardMigrationAlarm(
  stub: DurableObjectStub<ProjectDataTestDouble>
): Promise<void> {
  await runInDurableObject(stub, async (instance) => {
    await withEnvOverrides(instance, SHARD_TEST_ENV, () => instance.alarm());
  });
}

async function readShardName(
  stub: DurableObjectStub<ProjectDataTestDouble>,
  sessionId: string
): Promise<string> {
  return runInDurableObject(stub, async (_instance, state) => {
    const row = state.storage.sql
      .exec('SELECT shard_name FROM session_shards WHERE session_id = ?', sessionId)
      .toArray()[0];
    expect(row?.shard_name).toBeTypeOf('string');
    return String(row!.shard_name);
  });
}

describe('ProjectData DO sharding', () => {
  it('migrates stopped-session messages to a same-class shard and routes reads', async () => {
    const projectId = `shard-route-${crypto.randomUUID()}`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);

    const sessionId = await createSessionWithMessages(stub, 'Migrated route', [
      { role: 'user', content: 'Archive this session' },
      { role: 'assistant', content: 'Archived response' },
    ]);
    await stub.stopSession(sessionId);

    await runShardMigrationAlarm(stub);
    const shardName = await readShardName(stub, sessionId);

    await runInDurableObject(stub, async (_instance, state) => {
      expect(
        countRows(
          state.storage.sql,
          'SELECT COUNT(*) AS count FROM chat_sessions WHERE id = ?',
          sessionId
        )
      ).toBe(1);
      expect(
        countRows(
          state.storage.sql,
          'SELECT COUNT(*) AS count FROM chat_messages WHERE session_id = ?',
          sessionId
        )
      ).toBe(0);
      expect(
        countRows(
          state.storage.sql,
          'SELECT COUNT(*) AS count FROM chat_messages_grouped WHERE session_id = ?',
          sessionId
        )
      ).toBe(0);
    });

    const shardStub = getShardStub(shardName);
    await runInDurableObject(shardStub, async (_instance, state) => {
      expect(
        countRows(
          state.storage.sql,
          'SELECT COUNT(*) AS count FROM chat_sessions WHERE id = ?',
          sessionId
        )
      ).toBe(1);
      expect(
        countRows(
          state.storage.sql,
          'SELECT COUNT(*) AS count FROM chat_messages WHERE session_id = ?',
          sessionId
        )
      ).toBe(2);
    });

    const session = await stub.getSession(sessionId);
    expect(session).toMatchObject({ id: sessionId, topic: 'Migrated route', status: 'stopped' });
    const { messages } = await stub.getMessages(sessionId, 10);
    expect(messages.map((message) => message.content)).toEqual([
      'Archive this session',
      'Archived response',
    ]);
    expect(await stub.getMessageCount(sessionId)).toBe(2);
  });

  it('does not migrate active or sleeping sessions', async () => {
    const projectId = `shard-status-${crypto.randomUUID()}`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);

    const activeId = await createSessionWithMessages(stub, 'Active', [
      { role: 'user', content: 'active should stay primary' },
    ]);
    const sleepingId = await createSessionWithMessages(stub, 'Sleeping', [
      { role: 'user', content: 'sleeping should stay primary' },
    ]);
    await stub.sleepSession(sleepingId);
    const stoppedId = await createSessionWithMessages(stub, 'Stopped', [
      { role: 'user', content: 'stopped can move' },
    ]);
    await stub.stopSession(stoppedId);

    await runShardMigrationAlarm(stub);

    await runInDurableObject(stub, async (_instance, state) => {
      const rows = state.storage.sql
        .exec('SELECT session_id FROM session_shards ORDER BY session_id')
        .toArray()
        .map((row) => String(row.session_id));
      expect(rows).toEqual([stoppedId]);
      expect(
        countRows(
          state.storage.sql,
          'SELECT COUNT(*) AS count FROM chat_messages WHERE session_id = ?',
          activeId
        )
      ).toBe(1);
      expect(
        countRows(
          state.storage.sql,
          'SELECT COUNT(*) AS count FROM chat_messages WHERE session_id = ?',
          sleepingId
        )
      ).toBe(1);
    });
  });

  it('fans out project-wide search across primary and registered shards', async () => {
    const projectId = `shard-search-${crypto.randomUUID()}`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);

    const migratedId = await createSessionWithMessages(stub, 'Migrated search', [
      { role: 'user', content: 'zebra needle from shard' },
    ]);
    await stub.stopSession(migratedId);
    await runShardMigrationAlarm(stub);

    const primaryId = await createSessionWithMessages(stub, 'Primary search', [
      { role: 'user', content: 'zebra needle from primary' },
    ]);

    const allResults = await stub.searchMessages('zebra needle', null, null, 10);
    expect(new Set(allResults.map((result) => result.sessionId))).toEqual(
      new Set([migratedId, primaryId])
    );

    const migratedOnly = await stub.searchMessages('zebra needle', migratedId, null, 10);
    expect(migratedOnly).toHaveLength(1);
    expect(migratedOnly[0]!.sessionId).toBe(migratedId);

    const limited = await stub.searchMessages('zebra needle', null, null, 1);
    expect(limited).toHaveLength(1);
  });

  it('reports SQLite storage size from PRAGMA page_count and page_size', async () => {
    const projectId = `shard-size-${crypto.randomUUID()}`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    await createSessionWithMessages(stub, 'Storage size', [
      { role: 'user', content: 'storage estimate payload' },
    ]);

    expect(await stub.getStorageSizeBytes()).toBeGreaterThan(0);
    await runInDurableObject(stub, async (instance, state) => {
      try {
        const pageCount = Number(
          state.storage.sql.exec('PRAGMA page_count').toArray()[0]?.page_count
        );
        const pageSize = Number(state.storage.sql.exec('PRAGMA page_size').toArray()[0]?.page_size);
        expect(instance.getStorageSizeBytes()).toBe(pageCount * pageSize);
      } catch (error) {
        expect(String(error)).toContain('SQLITE_AUTH');
        expect(instance.getStorageSizeBytes()).toBe(state.storage.sql.databaseSize);
      }
    });
  });

  it('arms a shard migration alarm after a stopped session crosses the threshold', async () => {
    const projectId = `shard-alarm-${crypto.randomUUID()}`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const sessionId = await createSessionWithMessages(stub, 'Alarm trigger', [
      { role: 'user', content: 'alarm trigger payload' },
    ]);

    await runInDurableObject(stub, async (instance, state) => {
      await withEnvOverrides(instance, SHARD_TEST_ENV, () => instance.stopSession(sessionId));
      const alarm = await state.storage.getAlarm();
      expect(alarm).not.toBeNull();
      expect(alarm!).toBeLessThanOrEqual(Date.now() + 5000);
    });
  });

  it('processes a bounded alarm batch and re-arms while candidates remain', async () => {
    const projectId = `shard-batch-${crypto.randomUUID()}`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const firstId = await createSessionWithMessages(stub, 'First batch candidate', [
      { role: 'user', content: 'first batch payload' },
    ]);
    const secondId = await createSessionWithMessages(stub, 'Second batch candidate', [
      { role: 'user', content: 'second batch payload' },
    ]);
    await stub.stopSession(firstId);
    await stub.stopSession(secondId);

    const batchEnv = { ...SHARD_TEST_ENV, DO_SHARD_MIGRATION_BATCH_SIZE: '1' };
    await runInDurableObject(stub, async (instance, state) => {
      await withEnvOverrides(instance, batchEnv, () => instance.alarm());
      expect(countRows(state.storage.sql, 'SELECT COUNT(*) AS count FROM session_shards')).toBe(1);
      const alarm = await state.storage.getAlarm();
      expect(alarm).not.toBeNull();
      expect(alarm!).toBeGreaterThanOrEqual(Date.now() + 30_000);
      expect(alarm!).toBeLessThanOrEqual(Date.now() + 65_000);
    });

    await runInDurableObject(stub, async (instance, state) => {
      await withEnvOverrides(instance, batchEnv, () => instance.alarm());
      expect(countRows(state.storage.sql, 'SELECT COUNT(*) AS count FROM session_shards')).toBe(2);
      expect(await state.storage.getAlarm()).toBeNull();
    });

    const allResults = await stub.searchMessages('batch payload', null, null, 10);
    expect(new Set(allResults.map((result) => result.sessionId))).toEqual(
      new Set([firstId, secondId])
    );
  });

  it('preserves ACP lineage, linked ideas, and attention rows on migration', async () => {
    const projectId = `shard-cascade-${crypto.randomUUID()}`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const sessionId = await createSessionWithMessages(stub, 'Cascade safety', [
      { role: 'user', content: 'cascade safety payload' },
    ]);
    const acpId = `acp-${crypto.randomUUID()}`;

    await stub.createAcpSession({
      id: acpId,
      chatSessionId: sessionId,
      initialPrompt: 'initial',
      agentType: 'codex',
    });
    await stub.linkSessionIdea(sessionId, 'task-cascade-safe', 'keep idea link');
    await stub.createAttentionMarker({
      sessionId,
      taskId: 'task-cascade-safe',
      workspaceId: null,
      kind: 'needs_input',
      source: 'test',
      reason: 'keep attention',
    });
    await stub.stopSession(sessionId);

    await runShardMigrationAlarm(stub);

    expect(await stub.getAcpSession(acpId)).toMatchObject({ id: acpId, chatSessionId: sessionId });
    expect(await stub.getIdeasForSession(sessionId)).toHaveLength(1);
    expect(await stub.listActiveAttentionMarkers(sessionId)).toHaveLength(1);
    const session = await stub.getSession(sessionId);
    expect(session!.attention).toMatchObject({ kind: 'needs_input', reason: 'keep attention' });
  });
});
