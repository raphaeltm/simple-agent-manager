import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendNotificationMock } = vi.hoisted(() => ({ sendNotificationMock: vi.fn() }));
vi.mock('../../../src/services/notification', () => ({ sendNotification: sendNotificationMock }));

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import {
  DEFAULT_PROJECT_DATA_STORAGE_HARD_CAP_BYTES,
  runProjectDataStorageAlerts,
} from '../../../src/scheduled/project-data-storage-alerts';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const GB = 1e9;
const CAP = DEFAULT_PROJECT_DATA_STORAGE_HARD_CAP_BYTES;

function setup(overrides: Partial<Record<keyof Env, string>> = {}) {
  const sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [
    schema.users,
    schema.projects,
    schema.projectDataArchiveCircuitBreakers,
    schema.projectDataStorageTelemetry,
  ]);
  const kv = new Map<string, string>();
  const env = {
    DATABASE: createSqliteD1(sqlite),
    KV: {
      get: vi.fn(async (key: string) => kv.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        kv.set(key, value);
      }),
    },
    NOTIFICATION: {},
    ...overrides,
  } as unknown as Env;
  // Real superadmins, plus a normal user and the system trial sentinel that must never be paged.
  const user = sqlite.prepare('INSERT INTO users (id, role, status) VALUES (?, ?, ?)');
  user.run('admin-1', 'superadmin', 'active');
  user.run('admin-2', 'superadmin', 'active');
  user.run('user-1', 'user', 'active');
  user.run('system_anonymous_trials', 'superadmin', 'system');
  return { sqlite, env, kv };
}

function seedProject(sqlite: Database.Database, id: string, name: string): void {
  sqlite.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run(id, name);
}

function seedBreaker(
  sqlite: Database.Database,
  projectId: string,
  state: 'open' | 'frozen' | 'closed',
  since: number,
  reason = 'poison_threshold:3/3:attempts_exhausted:Error'
): void {
  sqlite
    .prepare(
      `INSERT INTO project_data_archive_circuit_breakers (project_id, state, reason, opened_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET state = excluded.state, reason = excluded.reason,
         opened_at = excluded.opened_at, updated_at = excluded.updated_at`
    )
    .run(projectId, state, reason, state === 'closed' ? null : since, since);
}

function seedTelemetry(
  sqlite: Database.Database,
  projectId: string,
  databaseSizeBytes: number,
  measuredAt: number,
  cleanupHealth: string | null = null
): void {
  sqlite
    .prepare(
      `INSERT INTO project_data_storage_telemetry
         (project_id, measured_at, database_size_bytes, limit_bytes, usage_ratio, status,
          cleanup_health, created_at, updated_at)
       VALUES (?, ?, ?, 10000000000, ?, 'degraded', ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET measured_at = excluded.measured_at,
         database_size_bytes = excluded.database_size_bytes, cleanup_health = excluded.cleanup_health`
    )
    .run(
      projectId,
      measuredAt,
      databaseSizeBytes,
      databaseSizeBytes / 1e10,
      cleanupHealth,
      measuredAt,
      measuredAt
    );
}

type SentNotification = {
  type: string;
  urgency: string;
  title: string;
  body: string;
  actionUrl: string;
  metadata: Record<string, unknown>;
};

function sent(): Array<{ userId: string; notification: SentNotification }> {
  return sendNotificationMock.mock.calls.map(([, userId, notification]) => ({
    userId: userId as string,
    notification: notification as SentNotification,
  }));
}

describe('ProjectData storage superadmin alerts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendNotificationMock.mockResolvedValue({ id: 'notification' });
  });

  it('pages every real superadmin once per window while a project breaker is open', async () => {
    const { sqlite, env } = setup();
    seedProject(sqlite, 'project-sam', 'SAM');
    seedBreaker(sqlite, 'project-sam', 'open', NOW - 5 * 24 * HOUR);

    const first = await runProjectDataStorageAlerts(env, NOW);

    expect(first).toMatchObject({ alerts: 1, notificationsSent: 2, throttled: 0 });
    expect(sent().map((entry) => entry.userId)).toEqual(['admin-1', 'admin-2']);
    expect(sent()[0]!.notification).toMatchObject({
      type: 'cron_failure',
      urgency: 'high',
      actionUrl: '/admin/storage',
      title: 'Archive drain stopped: SAM',
      metadata: { alertKind: 'breaker_open', projectId: 'project-sam' },
    });
    expect(sent()[0]!.notification.body).toContain(new Date(NOW - 5 * 24 * HOUR).toISOString());

    // The next tick inside the window is throttled for both recipients.
    const second = await runProjectDataStorageAlerts(env, NOW + 5 * 60 * 1000);
    expect(second).toMatchObject({ alerts: 1, notificationsSent: 0, throttled: 2 });
    expect(sendNotificationMock).toHaveBeenCalledTimes(2);
  });

  it('stays quiet for closed breakers and small projects, while still paging the open one', async () => {
    const { sqlite, env } = setup();
    seedProject(sqlite, 'project-calm', 'Calm');
    seedBreaker(sqlite, 'project-calm', 'closed', NOW - HOUR);
    seedTelemetry(sqlite, 'project-calm', 4 * GB, NOW - 10 * 60 * 1000);
    seedProject(sqlite, 'project-stuck', 'Stuck');
    seedBreaker(sqlite, 'project-stuck', 'open', NOW - HOUR);

    await runProjectDataStorageAlerts(env, NOW);

    expect(new Set(sent().map((entry) => entry.notification.metadata.projectId))).toEqual(
      new Set(['project-stuck'])
    );
  });

  it('escalates a frozen breaker, as a new episode, once its project nears the hard cap', async () => {
    const { sqlite, env } = setup();
    seedProject(sqlite, 'project-held', 'Held');
    seedBreaker(sqlite, 'project-held', 'frozen', NOW - 2 * HOUR, 'operator hold');
    seedTelemetry(sqlite, 'project-held', 9 * GB, NOW - 10 * 60 * 1000);

    await runProjectDataStorageAlerts(env, NOW);
    expect(sent().map((entry) => entry.notification.urgency)).toEqual(['medium', 'medium']);

    seedTelemetry(sqlite, 'project-held', Math.ceil(CAP * 0.97), NOW);
    sendNotificationMock.mockClear();
    await runProjectDataStorageAlerts(env, NOW + 5 * 60 * 1000);

    const kinds = sent().map((entry) => [entry.notification.metadata.alertKind, entry.notification.urgency]);
    expect(kinds).toContainEqual(['breaker_frozen', 'high']);
    expect(kinds).toContainEqual(['near_wall', 'high']);
  });

  it('reports a near-cap project and says so when its telemetry is stale', async () => {
    const { sqlite, env } = setup();
    seedProject(sqlite, 'project-fresh', 'Fresh');
    seedTelemetry(sqlite, 'project-fresh', Math.ceil(CAP * 0.96), NOW - 10 * 60 * 1000);
    seedProject(sqlite, 'project-silent', 'Silent');
    seedTelemetry(sqlite, 'project-silent', Math.ceil(CAP * 0.98), NOW - 5 * HOUR);

    await runProjectDataStorageAlerts(env, NOW);

    const byProject = new Map(
      sent().map((entry) => [entry.notification.metadata.projectId, entry.notification])
    );
    expect(byProject.get('project-fresh')).toMatchObject({
      urgency: 'high',
      title: 'Fresh storage is near the 10 GiB hard cap',
      metadata: { alertKind: 'near_wall', stale: false },
    });
    expect(byProject.get('project-silent')).toMatchObject({
      title: 'Silent storage is near the 10 GiB hard cap (telemetry stale)',
      metadata: { alertKind: 'near_wall_stale', stale: true },
    });
    expect(byProject.get('project-silent')!.body).toContain(new Date(NOW - 5 * HOUR).toISOString());
  });

  it('names the configured hard cap rather than a fixed size', async () => {
    const twoGib = 2 * 1024 * 1024 * 1024;
    const { sqlite, env } = setup({ PROJECT_DATA_STORAGE_HARD_CAP_BYTES: String(twoGib) });
    seedProject(sqlite, 'project-small-cap', 'Small cap');
    seedTelemetry(sqlite, 'project-small-cap', Math.ceil(twoGib * 0.97), NOW);

    await runProjectDataStorageAlerts(env, NOW);

    expect(sent()[0]!.notification).toMatchObject({
      title: 'Small cap storage is near the 2 GiB hard cap',
      metadata: { alertKind: 'near_wall', hardCapBytes: twoGib },
    });
  });

  it('pages when automatic cleanup cannot reach its target, even below the wall', async () => {
    const { sqlite, env } = setup();
    seedProject(sqlite, 'project-cleanup', 'Cleanup');
    seedTelemetry(sqlite, 'project-cleanup', 5 * GB, NOW - 10 * 60 * 1000, 'target_unreachable');

    await runProjectDataStorageAlerts(env, NOW);

    expect(sent()[0]!.notification).toMatchObject({
      urgency: 'medium',
      metadata: { alertKind: 'cleanup_unreachable', projectId: 'project-cleanup' },
    });
  });

  it('retries a failed delivery on the next tick instead of suppressing it', async () => {
    const { sqlite, env } = setup();
    seedProject(sqlite, 'project-sam', 'SAM');
    seedBreaker(sqlite, 'project-sam', 'open', NOW - HOUR);
    sendNotificationMock.mockImplementation(async (_env: Env, userId: string) => {
      if (userId === 'admin-1' && sendNotificationMock.mock.calls.length === 1) {
        throw new Error('NotificationService unavailable');
      }
      return { id: 'notification' };
    });

    const first = await runProjectDataStorageAlerts(env, NOW);
    expect(first).toMatchObject({ notificationsSent: 1, deliveryFailures: 1 });

    const second = await runProjectDataStorageAlerts(env, NOW + 5 * 60 * 1000);
    expect(second).toMatchObject({ notificationsSent: 1, throttled: 1, deliveryFailures: 0 });
    expect(sent().map((entry) => entry.userId)).toEqual(['admin-1', 'admin-2', 'admin-1']);
  });

  it('fails closed for a recipient whose throttle cannot be read', async () => {
    const { sqlite, env } = setup();
    seedProject(sqlite, 'project-sam', 'SAM');
    seedBreaker(sqlite, 'project-sam', 'open', NOW - HOUR);
    vi.mocked(env.KV.get).mockRejectedValue(new Error('KV unavailable'));

    const stats = await runProjectDataStorageAlerts(env, NOW);

    expect(stats).toMatchObject({ alerts: 1, notificationsSent: 0, deliveryFailures: 2 });
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it('alerts again when a breaker re-opens inside the window', async () => {
    const { sqlite, env } = setup();
    seedProject(sqlite, 'project-sam', 'SAM');
    seedBreaker(sqlite, 'project-sam', 'open', NOW - HOUR);
    await runProjectDataStorageAlerts(env, NOW);
    expect(sendNotificationMock).toHaveBeenCalledTimes(2);

    // Closed by an operator, then opened again by a new systemic failure.
    seedBreaker(sqlite, 'project-sam', 'open', NOW + 10 * 60 * 1000);
    await runProjectDataStorageAlerts(env, NOW + 15 * 60 * 1000);
    expect(sendNotificationMock).toHaveBeenCalledTimes(4);
  });

  it('ranks open breakers ahead of older frozen ones before applying the per-tick cap', async () => {
    const { sqlite, env } = setup({ PROJECT_DATA_STORAGE_ALERT_MAX_ALERTS_PER_TICK: '1' });
    seedProject(sqlite, 'project-held-a', 'Held A');
    seedBreaker(sqlite, 'project-held-a', 'frozen', NOW - 3 * HOUR, 'operator hold');
    seedProject(sqlite, 'project-held-b', 'Held B');
    seedBreaker(sqlite, 'project-held-b', 'frozen', NOW - 2 * HOUR, 'operator hold');
    seedProject(sqlite, 'project-stuck', 'Stuck');
    seedBreaker(sqlite, 'project-stuck', 'open', NOW - HOUR);

    const stats = await runProjectDataStorageAlerts(env, NOW);

    // The cap drops two conditions and says so; the one it keeps is the stopped drain.
    expect(stats).toMatchObject({ candidates: 2, alerts: 1 });
    expect(new Set(sent().map((entry) => entry.notification.metadata.projectId))).toEqual(
      new Set(['project-stuck'])
    );
  });

  it('sends an escalated freeze ahead of a routine one when the cap bites', async () => {
    const { sqlite, env } = setup({ PROJECT_DATA_STORAGE_ALERT_MAX_ALERTS_PER_TICK: '2' });
    seedProject(sqlite, 'project-routine', 'Routine');
    seedBreaker(sqlite, 'project-routine', 'frozen', NOW - 3 * HOUR, 'operator hold');
    seedTelemetry(sqlite, 'project-routine', 4 * GB, NOW);
    seedProject(sqlite, 'project-urgent', 'Urgent');
    seedBreaker(sqlite, 'project-urgent', 'frozen', NOW - 2 * HOUR, 'operator hold');
    seedTelemetry(sqlite, 'project-urgent', Math.ceil(CAP * 0.97), NOW);

    await runProjectDataStorageAlerts(env, NOW);

    const kinds = new Set(
      sent().map(
        (entry) =>
          `${entry.notification.metadata.projectId}:${entry.notification.metadata.alertKind}:${entry.notification.urgency}`
      )
    );
    expect(kinds).toEqual(
      new Set(['project-urgent:near_wall:high', 'project-urgent:breaker_frozen:high'])
    );
  });
});
