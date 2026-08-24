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
       last_purge_rows
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
    }>();
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
