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
       growth_rate_bytes_per_day,
       estimated_days_to_limit,
       cleanup_health,
       reclaimable_bytes,
       category_breakdown_json,
       last_alarm_at,
       last_alert_at,
       last_alert_status,
       last_alert_reason,
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
      growth_rate_bytes_per_day: number | null;
      estimated_days_to_limit: number | null;
      cleanup_health: string | null;
      reclaimable_bytes: number | null;
      category_breakdown_json: string | null;
      last_alarm_at: number | null;
      last_alert_at: number | null;
      last_alert_status: ProjectDataStorageStatus | null;
      last_alert_reason: string | null;
      last_purge_rows: number | null;
      last_error: string | null;
    }>();
}

async function readTelemetryHistory(projectId: string) {
  const result = await env.DATABASE.prepare(
    `SELECT
       project_id,
       measured_at,
       database_size_bytes,
       status,
       growth_rate_bytes_per_day,
       estimated_days_to_limit,
       cleanup_health,
       reclaimable_bytes,
       category_breakdown_json
     FROM project_data_storage_telemetry_history
     WHERE project_id = ?
     ORDER BY measured_at ASC, created_at ASC`
  )
    .bind(projectId)
    .all<{
      project_id: string;
      measured_at: number;
      database_size_bytes: number;
      status: ProjectDataStorageStatus;
      growth_rate_bytes_per_day: number | null;
      estimated_days_to_limit: number | null;
      cleanup_health: string | null;
      reclaimable_bytes: number | null;
      category_breakdown_json: string | null;
    }>();
  return result.results ?? [];
}

async function seedStorageGrowthBaseline(
  projectId: string,
  databaseSizeBytes: number,
  limitBytes: number,
  measuredAt: number = Date.now() - 24 * 60 * 60 * 1000
): Promise<void> {
  await env.DATABASE.prepare(
    `INSERT INTO project_data_storage_telemetry (
       project_id,
       measured_at,
       database_size_bytes,
       limit_bytes,
       usage_ratio,
       status,
       updated_at
     )
     VALUES (?, ?, ?, ?, ?, 'notice', ?)
     ON CONFLICT(project_id) DO UPDATE SET
       measured_at = excluded.measured_at,
       database_size_bytes = excluded.database_size_bytes,
       limit_bytes = excluded.limit_bytes,
       usage_ratio = excluded.usage_ratio,
       status = excluded.status,
       updated_at = excluded.updated_at`
  )
    .bind(projectId, measuredAt, databaseSizeBytes, limitBytes, databaseSizeBytes / limitBytes, measuredAt)
    .run();

  await env.DATABASE.prepare(
    `INSERT INTO project_data_storage_telemetry_history (
       id,
       project_id,
       measured_at,
       database_size_bytes,
       limit_bytes,
       usage_ratio,
       status,
       created_at
     )
     VALUES (?, ?, ?, ?, ?, ?, 'notice', ?)`
  )
    .bind(
      crypto.randomUUID(),
      projectId,
      measuredAt,
      databaseSizeBytes,
      limitBytes,
      databaseSizeBytes / limitBytes,
      measuredAt
    )
    .run();
}

async function readProjectDataStorageAlerts(projectId: string) {
  const result = await env.OBSERVABILITY_DATABASE.prepare(
    `SELECT level, message, context
     FROM platform_errors
     ORDER BY created_at DESC
     LIMIT 50`
  )
    .all<{ level: string; message: string; context: string | null }>();
  return (result.results ?? []).filter((row) => parseAlertContext(row).projectId === projectId);
}

function parseAlertContext(row: { context: string | null }): Record<string, unknown> {
  return JSON.parse(row.context ?? '{}') as Record<string, unknown>;
}

function stringifyNullable(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
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

  it('emits warning-level operator alerts with growth and time-to-limit forecasts', async () => {
    const projectId = `storage-warning-alert-${crypto.randomUUID()}`;
    await seedProjectGraph(projectId);
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    await stub.createSession(null, 'Warning alert forecast');

    const currentSize = await runInDurableObject(
      stub,
      async (_instance, state) => state.storage.sql.databaseSize
    );
    const limitBytes = Math.ceil(currentSize / 0.85);
    await seedStorageGrowthBaseline(projectId, Math.max(1, currentSize - 4096), limitBytes);

    await withProjectDataStorageEnv(
      {
        PROJECT_DATA_STORAGE_LIMIT_BYTES: String(limitBytes),
        PROJECT_DATA_STORAGE_ALERT_INTERVAL_MS: '1',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ENABLED: 'false',
        PROJECT_DATA_EVENT_LOG_CLEANUP_ENABLED: 'false',
      },
      async () => {
        await runInDurableObject(stub, async (instance) => instance.alarm());

        const telemetry = await readTelemetry(projectId);
        expect(telemetry?.status).toBe('warning');
        expect(telemetry?.growth_rate_bytes_per_day).toBeGreaterThan(0);
        expect(telemetry?.estimated_days_to_limit).toBeGreaterThan(0);
        expect(telemetry?.category_breakdown_json).toContain('"reclaimableBytes"');
        expect(telemetry?.last_alert_status).toBe('warning');
        expect(telemetry?.last_alert_reason).toBe('threshold_exceeded');

        const alerts = await readProjectDataStorageAlerts(projectId);
        const alert = alerts.find((row) => row.message.includes('ProjectData storage usage'));
        expect(alert?.level).toBe('warn');
        expect(alert?.message).toContain('bytes/day');
        expect(alert?.message).toContain('days to limit');

        const context = parseAlertContext(alert ?? { context: null });
        expect(context.alertReason).toBe('threshold_exceeded');
        expect(context.status).toBe('warning');
        expect(context.growthRateBytesPerDay).toBeGreaterThan(0);
        expect(context.estimatedDaysToLimit).toBeGreaterThan(0);
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
        expect(stringifyNullable(telemetry?.last_error)).toMatch(/failed closed 1 candidate/);
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

  it('deletes only bounded terminal-session event-log cleanup candidates', async () => {
    const projectId = `storage-event-cleanup-${crypto.randomUUID()}`;
    await seedProjectGraph(projectId);
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);

    const seeded = await runInDurableObject(stub, async (instance, state) => {
      const terminalSession = await instance.createSession(null, 'Terminal event cleanup');
      const activeSession = await instance.createSession(null, 'Active event cleanup guard');
      const sleepingSession = await instance.createSession(null, 'Sleeping event cleanup guard');
      await instance.persistMessage(terminalSession, 'user', 'keep terminal message', null);
      await instance.persistMessage(activeSession, 'user', 'keep active message', null);
      await instance.persistMessage(sleepingSession, 'user', 'keep sleeping message', null);
      const terminalAcp = await instance.createAcpSession({
        chatSessionId: terminalSession,
        initialPrompt: null,
        agentType: null,
      });
      const activeAcp = await instance.createAcpSession({
        chatSessionId: activeSession,
        initialPrompt: null,
        agentType: null,
      });

      await instance.stopSession(terminalSession);
      await instance.sleepSession(sleepingSession);

      const sql = state.storage.sql;
      sql.exec(
        `UPDATE acp_sessions
         SET status = 'completed', completed_at = ?, updated_at = ?
         WHERE id = ?`,
        Date.now(),
        Date.now(),
        terminalAcp.id
      );

      const terminalActivityIds: string[] = [];
      const activeActivityIds: string[] = [];
      const sleepingActivityIds: string[] = [];
      const terminalAcpEventIds: string[] = [];
      const activeAcpEventIds: string[] = [];
      for (let index = 0; index < 3; index++) {
        const suffix = `${index}-${crypto.randomUUID()}`;
        terminalActivityIds.push(`terminal-activity-${suffix}`);
        activeActivityIds.push(`active-activity-${suffix}`);
        sleepingActivityIds.push(`sleeping-activity-${suffix}`);
        terminalAcpEventIds.push(`terminal-acp-event-${suffix}`);
        activeAcpEventIds.push(`active-acp-event-${suffix}`);

        sql.exec(
          `INSERT INTO activity_events
             (id, event_type, actor_type, actor_id, workspace_id, session_id, task_id, payload, created_at)
           VALUES (?, 'storage.test', 'system', NULL, NULL, ?, NULL, ?, ?)`,
          terminalActivityIds[index],
          terminalSession,
          JSON.stringify({ terminal: index, payload: 't'.repeat(2048) }),
          index + 1
        );
        sql.exec(
          `INSERT INTO activity_events
             (id, event_type, actor_type, actor_id, workspace_id, session_id, task_id, payload, created_at)
           VALUES (?, 'storage.test', 'system', NULL, NULL, ?, NULL, ?, ?)`,
          activeActivityIds[index],
          activeSession,
          JSON.stringify({ active: index, payload: 'a'.repeat(2048) }),
          index + 1
        );
        sql.exec(
          `INSERT INTO activity_events
             (id, event_type, actor_type, actor_id, workspace_id, session_id, task_id, payload, created_at)
           VALUES (?, 'storage.test', 'system', NULL, NULL, ?, NULL, ?, ?)`,
          sleepingActivityIds[index],
          sleepingSession,
          JSON.stringify({ sleeping: index, payload: 's'.repeat(2048) }),
          index + 1
        );
        sql.exec(
          `INSERT INTO acp_session_events
             (id, acp_session_id, from_status, to_status, actor_type, actor_id, reason, metadata, created_at)
           VALUES (?, ?, NULL, 'completed', 'system', NULL, 'storage-test', ?, ?)`,
          terminalAcpEventIds[index],
          terminalAcp.id,
          JSON.stringify({ terminal: index, payload: 'u'.repeat(2048) }),
          index + 1
        );
        sql.exec(
          `INSERT INTO acp_session_events
             (id, acp_session_id, from_status, to_status, actor_type, actor_id, reason, metadata, created_at)
           VALUES (?, ?, NULL, 'running', 'system', NULL, 'storage-test', ?, ?)`,
          activeAcpEventIds[index],
          activeAcp.id,
          JSON.stringify({ active: index, payload: 'v'.repeat(2048) }),
          index + 1
        );
      }

      return {
        terminalActivityIds,
        activeActivityIds,
        sleepingActivityIds,
        terminalAcpEventIds,
        activeAcpEventIds,
      };
    });

    const currentSize = await runInDurableObject(
      stub,
      async (_instance, state) => state.storage.sql.databaseSize
    );
    await withProjectDataStorageEnv(
      {
        PROJECT_DATA_STORAGE_LIMIT_BYTES: String(Math.ceil(currentSize / 0.85)),
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ENABLED: 'false',
        PROJECT_DATA_EVENT_LOG_CLEANUP_BATCH_ROWS: '2',
        PROJECT_DATA_EVENT_LOG_CLEANUP_MIN_SESSION_AGE_DAYS: '0',
        PROJECT_DATA_EVENT_LOG_CLEANUP_RECHECK_MS: '60000',
      },
      async () => {
        await runInDurableObject(stub, async (instance) => instance.alarm());

        const after = await runInDurableObject(stub, async (_instance, state) => {
          const sql = state.storage.sql;
          const activityRows = sql
            .exec(
              `SELECT id
               FROM activity_events
               WHERE id IN (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ORDER BY id ASC`,
              ...seeded.terminalActivityIds,
              ...seeded.activeActivityIds,
              ...seeded.sleepingActivityIds
            )
            .toArray() as Array<{ id: string }>;
          const acpRows = sql
            .exec(
              `SELECT id
               FROM acp_session_events
               WHERE id IN (?, ?, ?, ?, ?, ?)
               ORDER BY id ASC`,
              ...seeded.terminalAcpEventIds,
              ...seeded.activeAcpEventIds
            )
            .toArray() as Array<{ id: string }>;
          const messageCount = sql.exec('SELECT COUNT(*) AS count FROM chat_messages').toArray()[0] as {
            count: number;
          };
          const alarm = await state.storage.getAlarm();
          return { activityRows, acpRows, messageCount, alarm };
        });

        const activityIds = new Set(after.activityRows.map((row) => row.id));
        const acpEventIds = new Set(after.acpRows.map((row) => row.id));

        expect(seeded.terminalActivityIds.filter((id) => activityIds.has(id))).toHaveLength(1);
        expect(seeded.activeActivityIds.every((id) => activityIds.has(id))).toBe(true);
        expect(seeded.sleepingActivityIds.every((id) => activityIds.has(id))).toBe(true);
        expect(seeded.terminalAcpEventIds.filter((id) => acpEventIds.has(id))).toHaveLength(1);
        expect(seeded.activeAcpEventIds.every((id) => acpEventIds.has(id))).toBe(true);
        expect(after.messageCount.count).toBe(3);
        expect(after.alarm).toBeTypeOf('number');
      }
    );
  });

  it('surfaces target-unreachable health and an error alert when cleanup candidates exhaust above target', async () => {
    const projectId = `storage-target-unreachable-${crypto.randomUUID()}`;
    await seedProjectGraph(projectId);
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);

    const seeded = await runInDurableObject(stub, async (instance, state) => {
      const terminalSession = await instance.createSession(null, 'Target unreachable terminal');
      const activeSession = await instance.createSession(null, 'Target unreachable active');
      const sleepingSession = await instance.createSession(null, 'Target unreachable sleeping');
      const terminalTool = await instance.persistMessage(
        terminalSession,
        'tool',
        'visible terminal tool',
        makeLegacyToolMetadata('terminal-unreachable', 16 * 1024),
        'tool-terminal-unreachable'
      );
      const normalizedTool = await instance.persistMessage(
        terminalSession,
        'tool',
        'visible normalized terminal tool',
        JSON.stringify({
          toolCallId: 'tool-normalized-unreachable',
          title: 'Tool normalized unreachable',
          status: 'completed',
          contentSize: 64 * 1024,
        }),
        'tool-normalized-unreachable'
      );
      const activeTool = await instance.persistMessage(
        activeSession,
        'tool',
        `visible active ${'a'.repeat(64 * 1024)}`,
        makeToolMetadata('active-unreachable'),
        'tool-active-unreachable'
      );
      const sleepingTool = await instance.persistMessage(
        sleepingSession,
        'tool',
        `visible sleeping ${'s'.repeat(64 * 1024)}`,
        makeToolMetadata('sleeping-unreachable'),
        'tool-sleeping-unreachable'
      );
      const terminalAcp = await instance.createAcpSession({
        chatSessionId: terminalSession,
        initialPrompt: null,
        agentType: null,
      });
      const activeAcp = await instance.createAcpSession({
        chatSessionId: activeSession,
        initialPrompt: null,
        agentType: null,
      });

      await instance.stopSession(terminalSession);
      await instance.sleepSession(sleepingSession);

      const sql = state.storage.sql;
      const now = Date.now();
      sql.exec(
        `UPDATE acp_sessions
         SET status = 'completed', completed_at = ?, updated_at = ?
         WHERE id = ?`,
        now,
        now,
        terminalAcp.id
      );

      const terminalActivityIds: string[] = [];
      const activeActivityIds: string[] = [];
      const terminalAcpEventIds: string[] = [];
      const activeAcpEventIds: string[] = [];
      for (let index = 0; index < 2; index++) {
        const suffix = `${index}-${crypto.randomUUID()}`;
        terminalActivityIds.push(`target-terminal-activity-${suffix}`);
        activeActivityIds.push(`target-active-activity-${suffix}`);
        terminalAcpEventIds.push(`target-terminal-acp-event-${suffix}`);
        activeAcpEventIds.push(`target-active-acp-event-${suffix}`);
        sql.exec(
          `INSERT INTO activity_events
             (id, event_type, actor_type, actor_id, workspace_id, session_id, task_id, payload, created_at)
           VALUES (?, 'storage.test', 'system', NULL, NULL, ?, NULL, ?, ?)`,
          terminalActivityIds[index],
          terminalSession,
          JSON.stringify({ terminal: index, payload: 't'.repeat(2048) }),
          index + 1
        );
        sql.exec(
          `INSERT INTO activity_events
             (id, event_type, actor_type, actor_id, workspace_id, session_id, task_id, payload, created_at)
           VALUES (?, 'storage.test', 'system', NULL, NULL, ?, NULL, ?, ?)`,
          activeActivityIds[index],
          activeSession,
          JSON.stringify({ active: index, payload: 'a'.repeat(2048) }),
          index + 1
        );
        sql.exec(
          `INSERT INTO acp_session_events
             (id, acp_session_id, from_status, to_status, actor_type, actor_id, reason, metadata, created_at)
           VALUES (?, ?, NULL, 'completed', 'system', NULL, 'storage-test', ?, ?)`,
          terminalAcpEventIds[index],
          terminalAcp.id,
          JSON.stringify({ terminal: index, payload: 'u'.repeat(2048) }),
          index + 1
        );
        sql.exec(
          `INSERT INTO acp_session_events
             (id, acp_session_id, from_status, to_status, actor_type, actor_id, reason, metadata, created_at)
           VALUES (?, ?, NULL, 'running', 'system', NULL, 'storage-test', ?, ?)`,
          activeAcpEventIds[index],
          activeAcp.id,
          JSON.stringify({ active: index, payload: 'v'.repeat(2048) }),
          index + 1
        );
      }

      return {
        terminalTool,
        normalizedTool,
        activeTool,
        sleepingTool,
        terminalActivityIds,
        activeActivityIds,
        terminalAcpEventIds,
        activeAcpEventIds,
      };
    });

    const beforeSize = await runInDurableObject(
      stub,
      async (_instance, state) => state.storage.sql.databaseSize
    );
    const limitBytes = Math.ceil(beforeSize / 0.85);
    await seedStorageGrowthBaseline(projectId, Math.max(1, beforeSize - 8192), limitBytes);

    await withProjectDataStorageEnv(
      {
        PROJECT_DATA_STORAGE_LIMIT_BYTES: String(limitBytes),
        PROJECT_DATA_STORAGE_ALERT_INTERVAL_MS: '1',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TRIGGER_RATIO: '0.8',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TARGET_RATIO: '0.75',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_ROWS: '100',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_BYTES: '1000000',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MIN_SESSION_AGE_DAYS: '0',
        PROJECT_DATA_EVENT_LOG_CLEANUP_BATCH_ROWS: '100',
        PROJECT_DATA_EVENT_LOG_CLEANUP_MIN_SESSION_AGE_DAYS: '0',
      },
      async () => {
        await runInDurableObject(stub, async (instance) => instance.alarm());

        const after = await runInDurableObject(stub, async (_instance, state) => {
          const sql = state.storage.sql;
          const messages = sql
            .exec(
              `SELECT id, tool_metadata
               FROM chat_messages
               WHERE id IN (?, ?, ?, ?)
               ORDER BY id ASC`,
              seeded.terminalTool,
              seeded.normalizedTool,
              seeded.activeTool,
              seeded.sleepingTool
            )
            .toArray() as Array<{ id: string; tool_metadata: string }>;
          const activityRows = sql
            .exec(
              `SELECT id
               FROM activity_events
               WHERE id IN (?, ?, ?, ?)
               ORDER BY id ASC`,
              ...seeded.terminalActivityIds,
              ...seeded.activeActivityIds
            )
            .toArray() as Array<{ id: string }>;
          const acpRows = sql
            .exec(
              `SELECT id
               FROM acp_session_events
               WHERE id IN (?, ?, ?, ?)
               ORDER BY id ASC`,
              ...seeded.terminalAcpEventIds,
              ...seeded.activeAcpEventIds
            )
            .toArray() as Array<{ id: string }>;
          return { messages, activityRows, acpRows, databaseSize: sql.databaseSize };
        });

        const messageById = new Map(after.messages.map((row) => [row.id, row]));
        const terminalMeta = JSON.parse(
          messageById.get(seeded.terminalTool)?.tool_metadata ?? '{}'
        ) as Record<string, unknown>;
        const normalizedMeta = JSON.parse(
          messageById.get(seeded.normalizedTool)?.tool_metadata ?? '{}'
        ) as Record<string, unknown>;
        const activeMeta = JSON.parse(
          messageById.get(seeded.activeTool)?.tool_metadata ?? '{}'
        ) as Record<string, unknown>;
        const sleepingMeta = JSON.parse(
          messageById.get(seeded.sleepingTool)?.tool_metadata ?? '{}'
        ) as Record<string, unknown>;
        const activityIds = new Set(after.activityRows.map((row) => row.id));
        const acpEventIds = new Set(after.acpRows.map((row) => row.id));

        expect(terminalMeta.content).toBeUndefined();
        expect(terminalMeta.contentSize).toBeGreaterThan(0);
        expect(normalizedMeta.contentSize).toBe(64 * 1024);
        expect(Array.isArray(activeMeta.content)).toBe(true);
        expect(Array.isArray(sleepingMeta.content)).toBe(true);
        expect(seeded.terminalActivityIds.some((id) => activityIds.has(id))).toBe(false);
        expect(seeded.terminalAcpEventIds.some((id) => acpEventIds.has(id))).toBe(false);
        expect(seeded.activeActivityIds.every((id) => activityIds.has(id))).toBe(true);
        expect(seeded.activeAcpEventIds.every((id) => acpEventIds.has(id))).toBe(true);
        expect(after.databaseSize).toBeGreaterThan(Math.floor(limitBytes * 0.75));

        const telemetry = await readTelemetry(projectId);
        expect(telemetry?.cleanup_health).toBe('target_unreachable');
        expect(telemetry?.last_error).toMatch(/cleanup target unreachable/i);
        expect(telemetry?.last_alert_reason).toBe('cleanup_target_unreachable');
        expect(telemetry?.category_breakdown_json).toContain('activeOrSleepingSessionBytes');

        const history = await readTelemetryHistory(projectId);
        expect(history.some((row) => row.cleanup_health === 'target_unreachable')).toBe(true);

        const alerts = await readProjectDataStorageAlerts(projectId);
        const alert = alerts.find((row) =>
          row.message.includes('ProjectData storage cleanup target unreachable')
        );
        expect(alert?.level).toBe('error');
        expect(alert?.message).toContain('bytes/day');
        expect(alert?.message).toContain('days to limit');

        const context = parseAlertContext(alert ?? { context: null });
        expect(context.alertReason).toBe('cleanup_target_unreachable');
        expect(context.cleanupHealth).toBe('target_unreachable');
        expect(context.reclaimableBytes).toBe(0);
      }
    );
  });

  it('service measurement writes ProjectData storage telemetry directly', async () => {
    const projectId = `storage-service-measure-${crypto.randomUUID()}`;
    await seedProjectGraph(projectId);
    await projectDataService.createSession(testEnv, projectId, null, 'Measured via service');

    const measurement = await projectDataService.measureProjectDataStorage(testEnv, projectId);
    const telemetry = await readTelemetry(projectId);
    const firstHistory = await readTelemetryHistory(projectId);

    expect(measurement).toMatchObject({
      projectId,
      limitBytes: DEFAULT_PROJECT_DATA_STORAGE_LIMIT_BYTES,
      status: 'ok',
    });
    expect(telemetry?.project_id).toBe(projectId);
    expect(telemetry?.database_size_bytes).toBe(measurement?.databaseSizeBytes);
    expect(firstHistory).toHaveLength(1);
    expect(firstHistory[0]?.project_id).toBe(projectId);

    await projectDataService.measureProjectDataStorage(testEnv, projectId);
    const secondHistory = await readTelemetryHistory(projectId);
    expect(secondHistory.length).toBeGreaterThanOrEqual(2);
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
