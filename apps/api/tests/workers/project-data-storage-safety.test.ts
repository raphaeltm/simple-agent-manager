/**
 * Worker-runtime coverage for the narrow ProjectData storage-safety firebreak.
 *
 * These tests intentionally use @cloudflare/vitest-pool-workers with real
 * SQLite-backed Durable Objects. They settle behavior that is unsafe to infer:
 * `databaseSize` after deletes, local limits on forcing exact SQLITE_FULL, and
 * alarm-driven telemetry writes.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PROJECT_DATA_STORAGE_LIMIT_BYTES,
  type ProjectDataStorageStatus,
} from '../../src/durable-objects/project-data/storage-safety';
import type { Env as WorkerEnv } from '../../src/env';
import * as projectDataService from '../../src/services/project-data';
import { seedInstallation, seedProject, seedUser } from './helpers/seed-d1';
import type { ProjectDataTestDouble } from './support/expected-error-doubles';

const testEnv = env as unknown as WorkerEnv;
const OWNER = 'storage-safety-owner';
const INSTALLATION = 'storage-safety-installation';

function getStub(projectId: string): DurableObjectStub<ProjectDataTestDouble> {
  return env.PROJECT_DATA.get(
    env.PROJECT_DATA.idFromName(projectId)
  ) as DurableObjectStub<ProjectDataTestDouble>;
}

async function seedProjectGraph(projectId: string): Promise<void> {
  await seedUser(OWNER);
  await seedInstallation(INSTALLATION, OWNER);
  await seedProject(projectId, OWNER, INSTALLATION, {
    name: `Storage Safety ${projectId}`,
  });
}

async function withProjectDataStorageEnv<T>(
  overrides: Partial<Record<keyof WorkerEnv, string>>,
  fn: () => Promise<T>
): Promise<T> {
  const mutableEnv = testEnv as WorkerEnv & Record<string, string | undefined>;
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, mutableEnv[key]);
    mutableEnv[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete mutableEnv[key];
      else mutableEnv[key] = value;
    }
  }
}

async function readTelemetry(projectId: string) {
  return env.DATABASE.prepare(
    `SELECT
       project_id,
       measured_at,
       database_size_bytes,
       limit_bytes,
       usage_ratio,
       status,
       last_alarm_at,
       last_purge_rows,
       last_error
     FROM project_data_storage_telemetry
     WHERE project_id = ?`
  )
    .bind(projectId)
    .first<{
      project_id: string;
      measured_at: number;
      database_size_bytes: number;
      limit_bytes: number;
      usage_ratio: number;
      status: ProjectDataStorageStatus;
      last_alarm_at: number | null;
      last_purge_rows: number | null;
      last_error: string | null;
    }>();
}

function makeToolMetadata(label: string): string {
  return JSON.stringify({
    toolCallId: `tool-${label}`,
    title: `Tool ${label}`,
    status: 'completed',
    content: [{ type: 'text', text: `${label}:${'x'.repeat(64 * 1024)}` }],
  });
}

function makeLegacyToolMetadata(label: string, payloadBytes: number): string {
  return JSON.stringify({
    toolCallId: `tool-${label}`,
    title: `Tool ${label}`,
    status: 'completed',
    content: [{ type: 'text', text: `${label}:${'x'.repeat(payloadBytes)}` }],
  });
}

function makePoisonToolMetadata(label: string): string {
  return JSON.stringify([
    {
      toolCallId: `tool-${label}`,
      content: [{ type: 'text', text: `${label}:poison` }],
    },
  ]);
}

describe('ProjectData storage safety firebreak', () => {
  it('databaseSize drops after deleting rows in the workerd SQLite DO runtime', async () => {
    const projectId = `storage-size-reclaim-${crypto.randomUUID()}`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);

    const sizes = await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      const before = sql.databaseSize;
      sql.exec(
        `CREATE TABLE storage_experiment_payloads (
           id TEXT PRIMARY KEY,
           payload TEXT NOT NULL
         )`
      );
      const afterCreate = sql.databaseSize;
      const payload = 'x'.repeat(4096);
      for (let i = 0; i < 96; i++) {
        sql.exec(
          'INSERT INTO storage_experiment_payloads (id, payload) VALUES (?, ?)',
          `payload-${i}`,
          payload
        );
      }
      const afterInsert = sql.databaseSize;
      sql.exec('DELETE FROM storage_experiment_payloads');
      const afterDelete = sql.databaseSize;
      return { before, afterCreate, afterInsert, afterDelete };
    });

    expect(sizes.afterCreate).toBeGreaterThanOrEqual(sizes.before);
    expect(sizes.afterInsert).toBeGreaterThan(sizes.afterCreate);
    expect(sizes.afterDelete).toBeLessThan(sizes.afterInsert);
  });

  it('SqlStorage write-limit errors are catchable and exact SQLITE_FULL is not locally forceable', async () => {
    const projectId = `storage-write-error-catch-${crypto.randomUUID()}`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);

    const result = await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      let pragmaPageCountAuthorized = true;
      let pragmaPageCountMessage = '';
      try {
        sql.exec('PRAGMA page_count').toArray();
      } catch (error) {
        pragmaPageCountAuthorized = false;
        pragmaPageCountMessage = error instanceof Error ? error.message : String(error);
      }

      const setMaxPageCountForTest = (
        sql as unknown as { setMaxPageCountForTest?: (count: number) => void }
      ).setMaxPageCountForTest;

      sql.exec('CREATE TABLE storage_write_error_probe (id TEXT PRIMARY KEY, payload TEXT NOT NULL)');
      let caught = false;
      let message = '';
      try {
        sql.exec(
          'INSERT INTO storage_write_error_probe (id, payload) VALUES (?, ?)',
          'oversized-row',
          'x'.repeat(3 * 1024 * 1024)
        );
      } catch (error) {
        caught = true;
        message = error instanceof Error ? error.message : String(error);
      }

      const readAfterError = sql
        .exec('SELECT COUNT(*) AS count FROM storage_write_error_probe')
        .toArray()[0] as { count?: number } | undefined;
      sql.exec('DELETE FROM storage_write_error_probe');
      const deleteAfterError = sql
        .exec('SELECT COUNT(*) AS count FROM storage_write_error_probe')
        .toArray()[0] as { count?: number } | undefined;

      return {
        pragmaPageCountAuthorized,
        pragmaPageCountMessage,
        setMaxPageCountForTestAvailable: typeof setMaxPageCountForTest === 'function',
        caught,
        message,
        readAfterError: typeof readAfterError?.count === 'number',
        deleteAfterError: deleteAfterError?.count === 0,
      };
    });

    expect(result.pragmaPageCountAuthorized).toBe(false);
    expect(result.pragmaPageCountMessage).toMatch(/SQLITE_AUTH|not authorized/i);
    expect(result.setMaxPageCountForTestAvailable).toBe(false);
    expect(result.caught).toBe(true);
    expect(result.message).toMatch(/too big|maximum|SQLITE_TOOBIG/i);
    expect(result.readAfterError).toBe(true);
    expect(result.deleteAfterError).toBe(true);
  });

  it('alarm measurement writes bounded D1 telemetry and reschedules the next measurement', async () => {
    const projectId = `storage-alarm-${crypto.randomUUID()}`;
    await seedProjectGraph(projectId);
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    await stub.createSession(null, 'Storage alarm');

    await withProjectDataStorageEnv(
      { PROJECT_DATA_STORAGE_MEASURE_INTERVAL_MS: '60000' },
      async () => {
        await runInDurableObject(stub, async (instance) => instance.alarm());

        const telemetry = await readTelemetry(projectId);
        expect(telemetry).toMatchObject({
          project_id: projectId,
          limit_bytes: DEFAULT_PROJECT_DATA_STORAGE_LIMIT_BYTES,
          status: 'ok',
        });
        expect(telemetry?.database_size_bytes).toBeGreaterThan(0);
        expect(telemetry?.measured_at).toBeGreaterThan(0);
        expect(telemetry?.last_alarm_at).toBeGreaterThan(0);

        const nextAlarm = await runInDurableObject(stub, async (_instance, state) =>
          state.storage.getAlarm()
        );
        expect(nextAlarm).toBeTypeOf('number');
        expect(nextAlarm as number).toBeGreaterThan(Date.now());
      }
    );
  });

  it('honors the storage measurement interval when unrelated alarms fire', async () => {
    const projectId = `storage-measurement-due-${crypto.randomUUID()}`;
    await seedProjectGraph(projectId);
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    await stub.createSession(null, 'Storage measurement cadence');

    await withProjectDataStorageEnv(
      { PROJECT_DATA_STORAGE_MEASURE_INTERVAL_MS: '86400000' },
      async () => {
        await runInDurableObject(stub, async (instance) => instance.alarm());
        const first = await readTelemetry(projectId);
        expect(first?.measured_at).toBeGreaterThan(0);

        await runInDurableObject(stub, async (instance) => instance.alarm());
        const second = await readTelemetry(projectId);
        expect(second?.measured_at).toBe(first?.measured_at);
        expect(second?.last_alarm_at).toBe(first?.last_alarm_at);
      }
    );
  });

  it('strips old terminal tool payloads in bounded cleanup batches and resumes by cursor', async () => {
    const projectId = `storage-tool-cleanup-${crypto.randomUUID()}`;
    await seedProjectGraph(projectId);
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);

    const messageIds = await runInDurableObject(stub, async (instance) => {
      const stoppedSession = await instance.createSession(null, 'Old terminal tool payloads');
      const activeSession = await instance.createSession(null, 'Active tool payload');
      const sleepingSession = await instance.createSession(null, 'Sleeping tool payload');

      const stoppedOne = await instance.persistMessage(
        stoppedSession,
        'tool',
        'visible stopped one',
        makeToolMetadata('stopped-one'),
        'tool-stopped-one'
      );
      const stoppedTwo = await instance.persistMessage(
        stoppedSession,
        'tool',
        'visible stopped two',
        makeToolMetadata('stopped-two'),
        'tool-stopped-two'
      );
      const stoppedThree = await instance.persistMessage(
        stoppedSession,
        'tool',
        'visible stopped three',
        makeToolMetadata('stopped-three'),
        'tool-stopped-three'
      );
      const active = await instance.persistMessage(
        activeSession,
        'tool',
        'visible active',
        makeToolMetadata('active'),
        'tool-active'
      );
      const sleeping = await instance.persistMessage(
        sleepingSession,
        'tool',
        'visible sleeping',
        makeToolMetadata('sleeping'),
        'tool-sleeping'
      );

      await instance.stopSession(stoppedSession);
      await instance.sleepSession(sleepingSession);

      return { stoppedOne, stoppedTwo, stoppedThree, active, sleeping };
    });

    await withProjectDataStorageEnv(
      {
        PROJECT_DATA_STORAGE_LIMIT_BYTES: '10000',
        PROJECT_DATA_STORAGE_MEASURE_INTERVAL_MS: '86400000',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TRIGGER_RATIO: '0.2',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TARGET_RATIO: '0.1',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_ROWS: '2',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MIN_SESSION_AGE_DAYS: '0',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_RECHECK_MS: '60000',
      },
      async () => {
        const first = await runInDurableObject(stub, async (instance, state) => {
          const before = state.storage.sql.databaseSize;
          await instance.alarm();
          const after = state.storage.sql.databaseSize;
          const rows = state.storage.sql
            .exec(
              `SELECT id, content, tool_metadata
               FROM chat_messages
               WHERE id IN (?, ?, ?, ?, ?)
               ORDER BY id ASC`,
              messageIds.stoppedOne,
              messageIds.stoppedTwo,
              messageIds.stoppedThree,
              messageIds.active,
              messageIds.sleeping
            )
            .toArray() as Array<{ id: string; content: string; tool_metadata: string }>;
          const alarm = await state.storage.getAlarm();
          return { before, after, rows, alarm };
        });

        expect(first.after).toBeLessThan(first.before);
        expect(first.alarm).toBeTypeOf('number');

        const firstById = new Map(first.rows.map((row) => [row.id, row]));
        const stoppedOneMeta = JSON.parse(
          firstById.get(messageIds.stoppedOne)?.tool_metadata ?? '{}'
        ) as Record<string, unknown>;
        const stoppedTwoMeta = JSON.parse(
          firstById.get(messageIds.stoppedTwo)?.tool_metadata ?? '{}'
        ) as Record<string, unknown>;
        const stoppedThreeMeta = JSON.parse(
          firstById.get(messageIds.stoppedThree)?.tool_metadata ?? '{}'
        ) as Record<string, unknown>;
        const activeMeta = JSON.parse(
          firstById.get(messageIds.active)?.tool_metadata ?? '{}'
        ) as Record<string, unknown>;
        const sleepingMeta = JSON.parse(
          firstById.get(messageIds.sleeping)?.tool_metadata ?? '{}'
        ) as Record<string, unknown>;

        expect(stoppedOneMeta.content).toBeUndefined();
        expect(stoppedOneMeta.contentSize).toBeGreaterThan(0);
        expect(stoppedOneMeta.toolCallId).toBe('tool-stopped-one');
        expect(stoppedTwoMeta.content).toBeUndefined();
        expect(stoppedTwoMeta.contentSize).toBeGreaterThan(0);
        expect(Array.isArray(stoppedThreeMeta.content)).toBe(true);
        expect(Array.isArray(activeMeta.content)).toBe(true);
        expect(Array.isArray(sleepingMeta.content)).toBe(true);
        expect(firstById.get(messageIds.stoppedOne)?.content).toBe('visible stopped one');

        await runInDurableObject(stub, async (instance) => instance.alarm());
        const early = await runInDurableObject(stub, async (_instance, state) =>
          state.storage.sql
            .exec('SELECT tool_metadata FROM chat_messages WHERE id = ?', messageIds.stoppedThree)
            .toArray()[0]
        ) as { tool_metadata: string };
        expect(Array.isArray((JSON.parse(early.tool_metadata) as Record<string, unknown>).content))
          .toBe(true);

        await runInDurableObject(stub, async (_instance, state) => {
          state.storage.sql.exec(
            `UPDATE do_meta
             SET value = ?
             WHERE key = 'storageSafetyToolCleanupRecheckAt'`,
            String(Date.now() - 1)
          );
        });

        await runInDurableObject(stub, async (instance) => instance.alarm());

        const second = await runInDurableObject(stub, async (_instance, state) => {
          const rows = state.storage.sql
            .exec(
              `SELECT id, tool_metadata
               FROM chat_messages
               WHERE id IN (?, ?, ?, ?, ?)
               ORDER BY id ASC`,
              messageIds.stoppedOne,
              messageIds.stoppedTwo,
              messageIds.stoppedThree,
              messageIds.active,
              messageIds.sleeping
            )
            .toArray() as Array<{ id: string; tool_metadata: string }>;
          const alarm = await state.storage.getAlarm();
          return { rows, alarm };
        });
        const secondById = new Map(second.rows.map((row) => [row.id, row]));
        const stoppedThreeAfter = JSON.parse(
          secondById.get(messageIds.stoppedThree)?.tool_metadata ?? '{}'
        ) as Record<string, unknown>;
        const activeAfter = JSON.parse(
          secondById.get(messageIds.active)?.tool_metadata ?? '{}'
        ) as Record<string, unknown>;
        const sleepingAfter = JSON.parse(
          secondById.get(messageIds.sleeping)?.tool_metadata ?? '{}'
        ) as Record<string, unknown>;
        const telemetry = await readTelemetry(projectId);

        expect(stoppedThreeAfter.content).toBeUndefined();
        expect(stoppedThreeAfter.contentSize).toBeGreaterThan(0);
        expect(Array.isArray(activeAfter.content)).toBe(true);
        expect(Array.isArray(sleepingAfter.content)).toBe(true);
        expect(telemetry?.last_purge_rows).toBe(1);
        expect(second.alarm).toBeTypeOf('number');
      }
    );
  });

  it('bounds cumulative legacy tool metadata bytes even when row limit is high', async () => {
    const projectId = `storage-tool-cleanup-byte-budget-${crypto.randomUUID()}`;
    await seedProjectGraph(projectId);
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);

    const messageIds = await runInDurableObject(stub, async (instance) => {
      const sessionId = await instance.createSession(null, 'Byte-bounded terminal payloads');
      const ids: string[] = [];
      for (let index = 0; index < 4; index++) {
        ids.push(
          await instance.persistMessage(
            sessionId,
            'tool',
            `visible byte bounded ${index}`,
            makeToolMetadata(`byte-bounded-${index}`),
            `tool-byte-bounded-${index}`
          )
        );
      }
      await instance.stopSession(sessionId);
      return ids;
    });

    await withProjectDataStorageEnv(
      {
        PROJECT_DATA_STORAGE_LIMIT_BYTES: '10000',
        PROJECT_DATA_STORAGE_MEASURE_INTERVAL_MS: '86400000',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TRIGGER_RATIO: '0.2',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TARGET_RATIO: '0.1',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_ROWS: '500',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_BYTES: '150000',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MIN_SESSION_AGE_DAYS: '0',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_RECHECK_MS: '60000',
      },
      async () => {
        await runInDurableObject(stub, async (instance) => instance.alarm());

        const rows = await runInDurableObject(stub, async (_instance, state) =>
          state.storage.sql
            .exec(
              `SELECT id, tool_metadata
               FROM chat_messages
               WHERE id IN (?, ?, ?, ?)
               ORDER BY created_at ASC, COALESCE(sequence, 0) ASC, id ASC`,
              messageIds[0],
              messageIds[1],
              messageIds[2],
              messageIds[3]
            )
            .toArray()
        ) as Array<{ id: string; tool_metadata: string }>;

        const metadata = rows.map((row) => JSON.parse(row.tool_metadata) as Record<string, unknown>);
        expect(metadata[0]?.content).toBeUndefined();
        expect(metadata[1]?.content).toBeUndefined();
        expect(Array.isArray(metadata[2]?.content)).toBe(true);
        expect(Array.isArray(metadata[3]?.content)).toBe(true);

        const alarm = await runInDurableObject(stub, async (_instance, state) =>
          state.storage.getAlarm()
        );
        const telemetry = await readTelemetry(projectId);
        expect(telemetry?.last_purge_rows).toBe(2);
        expect(alarm).toBeTypeOf('number');
        expect(alarm as number).toBeGreaterThan(Date.now());
      }
    );
  });

  it('quarantines an oversized single legacy metadata row and resumes after it', async () => {
    const projectId = `storage-tool-cleanup-oversized-${crypto.randomUUID()}`;
    await seedProjectGraph(projectId);
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);

    const messageIds = await runInDurableObject(stub, async (instance, state) => {
      const sessionId = await instance.createSession(null, 'Oversized terminal payload');
      const oversized = await instance.persistMessage(
        sessionId,
        'tool',
        'visible oversized',
        makeToolMetadata('oversized-placeholder'),
        'tool-oversized'
      );
      const next = await instance.persistMessage(
        sessionId,
        'tool',
        'visible after oversized',
        makeToolMetadata('after-oversized'),
        'tool-after-oversized'
      );
      await instance.stopSession(sessionId);
      state.storage.sql.exec(
        'UPDATE chat_messages SET tool_metadata = ? WHERE id = ?',
        makeLegacyToolMetadata('oversized-legacy', 220 * 1024),
        oversized
      );
      return { oversized, next };
    });

    await withProjectDataStorageEnv(
      {
        PROJECT_DATA_STORAGE_LIMIT_BYTES: '10000',
        PROJECT_DATA_STORAGE_MEASURE_INTERVAL_MS: '86400000',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TRIGGER_RATIO: '0.2',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TARGET_RATIO: '0.1',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_ROWS: '500',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_BYTES: '100000',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MIN_SESSION_AGE_DAYS: '0',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_RECHECK_MS: '60000',
      },
      async () => {
        await runInDurableObject(stub, async (instance) => instance.alarm());

        const firstPass = await runInDurableObject(stub, async (_instance, state) =>
          state.storage.sql
            .exec(
              `SELECT id, tool_metadata
               FROM chat_messages
               WHERE id IN (?, ?)
               ORDER BY created_at ASC, COALESCE(sequence, 0) ASC, id ASC`,
              messageIds.oversized,
              messageIds.next
            )
            .toArray()
        ) as Array<{ id: string; tool_metadata: string }>;
        const firstMetadata = firstPass.map(
          (row) => JSON.parse(row.tool_metadata) as Record<string, unknown>
        );
        expect(firstMetadata[0]).toMatchObject({
          storageSafetyTruncated: true,
          contentTruncated: true,
          storageSafetyCleanupReason: 'oversized_legacy_payload',
        });
        expect(Array.isArray(firstMetadata[1]?.content)).toBe(true);

        await runInDurableObject(stub, async (_instance, state) => {
          state.storage.sql.exec(
            `UPDATE do_meta
             SET value = ?
             WHERE key = 'storageSafetyToolCleanupRecheckAt'`,
            String(Date.now() - 1)
          );
        });

        await runInDurableObject(stub, async (instance) => instance.alarm());
        const secondPass = await runInDurableObject(stub, async (_instance, state) =>
          state.storage.sql
            .exec('SELECT tool_metadata FROM chat_messages WHERE id = ?', messageIds.next)
            .toArray()[0]
        ) as { tool_metadata: string };
        const nextMetadata = JSON.parse(secondPass.tool_metadata) as Record<string, unknown>;
        expect(nextMetadata.content).toBeUndefined();
        expect(nextMetadata.contentSize).toBeGreaterThan(0);
      }
    );
  });

  it('fail-closes poison candidates and clears stale due rechecks without alarm thrash', async () => {
    const projectId = `storage-tool-cleanup-poison-${crypto.randomUUID()}`;
    await seedProjectGraph(projectId);
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);

    const messageIds = await runInDurableObject(stub, async (instance, state) => {
      const sessionId = await instance.createSession(null, 'Poison terminal payload');
      const poison = await instance.persistMessage(
        sessionId,
        'tool',
        'visible poison',
        makeToolMetadata('poison-placeholder'),
        'tool-poison'
      );
      const valid = await instance.persistMessage(
        sessionId,
        'tool',
        'visible valid after poison',
        makeToolMetadata('valid-after-poison'),
        'tool-valid-after-poison'
      );
      await instance.stopSession(sessionId);
      state.storage.sql.exec(
        'UPDATE chat_messages SET tool_metadata = ? WHERE id = ?',
        makePoisonToolMetadata('legacy-poison'),
        poison
      );
      state.storage.sql.exec(
        `INSERT INTO do_meta (key, value)
         VALUES ('storageSafetyLastMeasuredAt', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        String(Date.now())
      );
      state.storage.sql.exec(
        `INSERT INTO do_meta (key, value)
         VALUES ('storageSafetyToolCleanupRecheckAt', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        String(Date.now() - 10_000)
      );
      return { poison, valid };
    });

    await withProjectDataStorageEnv(
      {
        PROJECT_DATA_STORAGE_LIMIT_BYTES: '10000',
        PROJECT_DATA_STORAGE_MEASURE_INTERVAL_MS: '86400000',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TRIGGER_RATIO: '0.2',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TARGET_RATIO: '0.1',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_ROWS: '500',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_BYTES: '200000',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MIN_SESSION_AGE_DAYS: '0',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_RECHECK_MS: '60000',
      },
      async () => {
        await runInDurableObject(stub, async (instance) => instance.alarm());

        const stateAfter = await runInDurableObject(stub, async (_instance, state) => {
          const rows = state.storage.sql
            .exec(
              `SELECT id, tool_metadata
               FROM chat_messages
               WHERE id IN (?, ?)
               ORDER BY created_at ASC, COALESCE(sequence, 0) ASC, id ASC`,
              messageIds.poison,
              messageIds.valid
            )
            .toArray() as Array<{ id: string; tool_metadata: string }>;
          const metaRows = state.storage.sql
            .exec(
              `SELECT key, value
               FROM do_meta
               WHERE key IN ('storageSafetyToolCleanupRecheckAt', 'storageSafetyLastError')
               ORDER BY key ASC`
            )
            .toArray() as Array<{ key: string; value: string }>;
          const alarm = await state.storage.getAlarm();
          return { rows, metaRows, alarm };
        });
        const metadata = stateAfter.rows.map(
          (row) => JSON.parse(row.tool_metadata) as Record<string, unknown>
        );
        const metaByKey = new Map(stateAfter.metaRows.map((row) => [row.key, row.value]));

        expect(metadata[0]).toMatchObject({
          storageSafetyTruncated: true,
          contentTruncated: true,
          storageSafetyCleanupReason: 'poison_legacy_payload',
        });
        expect(metadata[1]?.content).toBeUndefined();
        expect(metadata[1]?.contentSize).toBeGreaterThan(0);
        expect(metaByKey.has('storageSafetyToolCleanupRecheckAt')).toBe(false);
        expect(metaByKey.get('storageSafetyLastError')).toMatch(/failed closed 1 candidate/);
        expect(stateAfter.alarm).toBeTypeOf('number');
        expect(stateAfter.alarm as number).toBeGreaterThan(Date.now());

        const telemetry = await readTelemetry(projectId);
        expect(telemetry?.last_error).toMatch(/failed closed 1 candidate/);
      }
    );
  });

  it('preserves recent terminal tool payloads until the configured age floor passes', async () => {
    const projectId = `storage-tool-cleanup-age-${crypto.randomUUID()}`;
    await seedProjectGraph(projectId);
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);

    const messageId = await runInDurableObject(stub, async (instance) => {
      const sessionId = await instance.createSession(null, 'Recent terminal payload');
      const id = await instance.persistMessage(
        sessionId,
        'tool',
        'visible recent terminal',
        makeToolMetadata('recent-terminal'),
        'tool-recent-terminal'
      );
      await instance.stopSession(sessionId);
      return id;
    });

    await withProjectDataStorageEnv(
      {
        PROJECT_DATA_STORAGE_LIMIT_BYTES: '10000',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TRIGGER_RATIO: '0.2',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TARGET_RATIO: '0.1',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_ROWS: '10',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MIN_SESSION_AGE_DAYS: '1',
      },
      async () => {
        await runInDurableObject(stub, async (instance) => instance.alarm());
        const row = await runInDurableObject(stub, async (_instance, state) =>
          state.storage.sql
            .exec('SELECT tool_metadata FROM chat_messages WHERE id = ?', messageId)
            .toArray()[0]
        ) as { tool_metadata: string };
        const meta = JSON.parse(row.tool_metadata) as Record<string, unknown>;
        expect(Array.isArray(meta.content)).toBe(true);
      }
    );
  });

  it('service measurement writes ProjectData storage telemetry directly', async () => {
    const projectId = `storage-service-measure-${crypto.randomUUID()}`;
    await seedProjectGraph(projectId);
    await projectDataService.createSession(testEnv, projectId, null, 'Measured via service');

    const measurement = await projectDataService.measureProjectDataStorage(testEnv, projectId);
    const telemetry = await readTelemetry(projectId);

    expect(measurement).toMatchObject({
      projectId,
      limitBytes: DEFAULT_PROJECT_DATA_STORAGE_LIMIT_BYTES,
      status: 'ok',
    });
    expect(telemetry?.project_id).toBe(projectId);
    expect(telemetry?.database_size_bytes).toBe(measurement?.databaseSizeBytes);
  });

  it('emergency purge deletes only bounded low-value event-log batches', async () => {
    const projectId = `storage-purge-${crypto.randomUUID()}`;
    await seedProjectGraph(projectId);
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);

    const countsBefore = await runInDurableObject(stub, async (instance, state) => {
      const sessionId = await instance.createSession(null, 'Purge guard');
      await instance.persistMessage(sessionId, 'user', 'Keep this message', null);
      const acp = await instance.createAcpSession({
        chatSessionId: sessionId,
        initialPrompt: null,
        agentType: null,
      });

      const sql = state.storage.sql;
      for (let i = 0; i < 5; i++) {
        sql.exec(
          `INSERT INTO activity_events
             (id, event_type, actor_type, actor_id, workspace_id, session_id, task_id, payload, created_at)
           VALUES (?, 'storage.test', 'system', NULL, NULL, ?, NULL, ?, ?)`,
          `activity-${i}`,
          sessionId,
          JSON.stringify({ index: i, payload: 'x'.repeat(1024) }),
          i + 1
        );
        sql.exec(
          `INSERT INTO acp_session_events
             (id, acp_session_id, from_status, to_status, actor_type, actor_id, reason, metadata, created_at)
           VALUES (?, ?, NULL, 'running', 'system', NULL, 'storage-test', ?, ?)`,
          `acp-event-${i}`,
          acp.id,
          JSON.stringify({ index: i, payload: 'y'.repeat(1024) }),
          i + 1
        );
      }

      const activityCount = sql.exec('SELECT COUNT(*) AS count FROM activity_events').toArray()[0] as {
        count: number;
      };
      const acpEventCount = sql.exec('SELECT COUNT(*) AS count FROM acp_session_events').toArray()[0] as {
        count: number;
      };
      const messageCount = sql.exec('SELECT COUNT(*) AS count FROM chat_messages').toArray()[0] as {
        count: number;
      };
      return { activityCount, acpEventCount, messageCount };
    });

    await withProjectDataStorageEnv({ PROJECT_DATA_STORAGE_LIMIT_BYTES: '10000' }, async () => {
      const result = await projectDataService.runProjectDataStorageEmergencyPurge(
        testEnv,
        projectId,
        {
          reason: 'vitest bounded purge',
          targetRatio: 0.1,
          batchRows: 2,
          maxBatches: 1,
        }
      );

      expect(result.rowsDeleted).toEqual({ activityEvents: 2, acpSessionEvents: 2 });
      expect(result.batches).toBe(1);
      expect(result.maxBatches).toBe(1);
      expect(result.batchRows).toBe(2);
      expect(result.beforeBytes).toBeGreaterThanOrEqual(result.afterBytes);
    });

    const countsAfter = await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      const activityCount = sql.exec('SELECT COUNT(*) AS count FROM activity_events').toArray()[0] as {
        count: number;
      };
      const acpEventCount = sql.exec('SELECT COUNT(*) AS count FROM acp_session_events').toArray()[0] as {
        count: number;
      };
      const messageCount = sql.exec('SELECT COUNT(*) AS count FROM chat_messages').toArray()[0] as {
        count: number;
      };
      return { activityCount, acpEventCount, messageCount };
    });
    const telemetry = await readTelemetry(projectId);

    expect(countsBefore.activityCount.count).toBeGreaterThanOrEqual(6);
    expect(countsBefore.acpEventCount.count).toBeGreaterThanOrEqual(6);
    expect(countsAfter.activityCount.count).toBe(countsBefore.activityCount.count - 2);
    expect(countsAfter.acpEventCount.count).toBe(countsBefore.acpEventCount.count - 2);
    expect(countsAfter.messageCount.count).toBe(countsBefore.messageCount.count);
    expect(telemetry?.last_purge_rows).toBe(4);
  });
});
