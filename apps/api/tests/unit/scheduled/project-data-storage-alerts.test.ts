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

/**
 * KV with Cloudflare's expiry semantics on the test clock: `put` honours `expirationTtl`, `get`
 * hides expired keys, and `list` pages by prefix and, like KV before it purges, may still return
 * an expired key with its `expiration`.
 */
function createKv(clock: { now: number }, pageSize = 1000) {
  const entries = new Map<string, { value: string; expiration?: number }>();
  const isLive = (entry: { expiration?: number }) =>
    entry.expiration === undefined || entry.expiration * 1000 > clock.now;
  return {
    entries,
    get: vi.fn(async (key: string) => {
      const entry = entries.get(key);
      return entry && isLive(entry) ? entry.value : null;
    }),
    put: vi.fn(async (key: string, value: string, options?: { expirationTtl?: number }) => {
      entries.set(key, {
        value,
        expiration: options?.expirationTtl
          ? Math.floor(clock.now / 1000) + options.expirationTtl
          : undefined,
      });
    }),
    list: vi.fn(async ({ prefix = '', cursor }: { prefix?: string; cursor?: string } = {}) => {
      const names = [...entries.keys()].filter((name) => name.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const complete = start + pageSize >= names.length;
      return {
        keys: names
          .slice(start, start + pageSize)
          .map((name) => ({ name, expiration: entries.get(name)!.expiration })),
        list_complete: complete,
        ...(complete ? {} : { cursor: String(start + pageSize) }),
      };
    }),
  };
}

function setup(overrides: Partial<Record<keyof Env, string>> = {}, kvPageSize = 1000) {
  const sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [
    schema.users,
    schema.projects,
    schema.projectDataArchiveCircuitBreakers,
    schema.projectDataStorageTelemetry,
  ]);
  const clock = { now: NOW };
  const kv = createKv(clock, kvPageSize);
  const env = {
    DATABASE: createSqliteD1(sqlite),
    KV: kv,
    NOTIFICATION: {},
    ...overrides,
  } as unknown as Env;
  /** One cron tick at `at`, with KV on the same clock. */
  const tick = (at: number) => {
    clock.now = at;
    return runProjectDataStorageAlerts(env, at);
  };
  // Real superadmins, plus a normal user and the system trial sentinel that must never be paged.
  const user = sqlite.prepare('INSERT INTO users (id, role, status) VALUES (?, ?, ?)');
  user.run('admin-1', 'superadmin', 'active');
  user.run('admin-2', 'superadmin', 'active');
  user.run('user-1', 'user', 'active');
  user.run('system_anonymous_trials', 'superadmin', 'system');
  return { sqlite, env, kv, tick };
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
    const { sqlite, tick } = setup();
    seedProject(sqlite, 'project-sam', 'SAM');
    seedBreaker(sqlite, 'project-sam', 'open', NOW - 5 * 24 * HOUR);

    const first = await tick(NOW);

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
    const second = await tick(NOW + 5 * 60 * 1000);
    expect(second).toMatchObject({ alerts: 0, notificationsSent: 0, throttled: 2 });
    expect(sendNotificationMock).toHaveBeenCalledTimes(2);
  });

  it('stays quiet for closed breakers and small projects, while still paging the open one', async () => {
    const { sqlite, tick } = setup();
    seedProject(sqlite, 'project-calm', 'Calm');
    seedBreaker(sqlite, 'project-calm', 'closed', NOW - HOUR);
    seedTelemetry(sqlite, 'project-calm', 4 * GB, NOW - 10 * 60 * 1000);
    seedProject(sqlite, 'project-stuck', 'Stuck');
    seedBreaker(sqlite, 'project-stuck', 'open', NOW - HOUR);

    await tick(NOW);

    expect(new Set(sent().map((entry) => entry.notification.metadata.projectId))).toEqual(
      new Set(['project-stuck'])
    );
  });

  it('escalates a frozen breaker, as a new episode, once its project nears the hard cap', async () => {
    const { sqlite, tick } = setup();
    seedProject(sqlite, 'project-held', 'Held');
    seedBreaker(sqlite, 'project-held', 'frozen', NOW - 2 * HOUR, 'operator hold');
    seedTelemetry(sqlite, 'project-held', 9 * GB, NOW - 10 * 60 * 1000);

    await tick(NOW);
    expect(sent().map((entry) => entry.notification.urgency)).toEqual(['medium', 'medium']);

    seedTelemetry(sqlite, 'project-held', Math.ceil(CAP * 0.97), NOW);
    sendNotificationMock.mockClear();
    await tick(NOW + 5 * 60 * 1000);

    const kinds = sent().map((entry) => [
      entry.notification.metadata.alertKind,
      entry.notification.urgency,
    ]);
    expect(kinds).toContainEqual(['breaker_frozen', 'high']);
    expect(kinds).toContainEqual(['near_wall', 'high']);
  });

  it('reports a near-cap project and says so when its telemetry is stale', async () => {
    const { sqlite, tick } = setup();
    seedProject(sqlite, 'project-fresh', 'Fresh');
    seedTelemetry(sqlite, 'project-fresh', Math.ceil(CAP * 0.96), NOW - 10 * 60 * 1000);
    seedProject(sqlite, 'project-silent', 'Silent');
    seedTelemetry(sqlite, 'project-silent', Math.ceil(CAP * 0.98), NOW - 5 * HOUR);

    await tick(NOW);

    const byProject = new Map(
      sent().map((entry) => [entry.notification.metadata.projectId, entry.notification])
    );
    expect(byProject.get('project-fresh')).toMatchObject({
      urgency: 'high',
      title: 'Fresh storage is near the 10 GiB hard cap',
      metadata: { alertKind: 'near_wall', stale: false },
    });
    // Stale is not calmer: the object may be closer to the cap than its last measurement.
    expect(byProject.get('project-silent')).toMatchObject({
      urgency: 'high',
      title: 'Silent storage is near the 10 GiB hard cap (telemetry stale)',
      metadata: { alertKind: 'near_wall_stale', stale: true },
    });
    expect(byProject.get('project-silent')!.body).toContain(new Date(NOW - 5 * HOUR).toISOString());
  });

  it('names the configured hard cap rather than a fixed size', async () => {
    const twoGib = 2 * 1024 * 1024 * 1024;
    const { sqlite, tick } = setup({ PROJECT_DATA_STORAGE_HARD_CAP_BYTES: String(twoGib) });
    seedProject(sqlite, 'project-small-cap', 'Small cap');
    seedTelemetry(sqlite, 'project-small-cap', Math.ceil(twoGib * 0.97), NOW);

    await tick(NOW);

    expect(sent()[0]!.notification).toMatchObject({
      title: 'Small cap storage is near the 2 GiB hard cap',
      metadata: { alertKind: 'near_wall', hardCapBytes: twoGib },
    });
  });

  it('pages when automatic cleanup cannot reach its target, even below the wall', async () => {
    const { sqlite, tick } = setup();
    seedProject(sqlite, 'project-cleanup', 'Cleanup');
    seedTelemetry(sqlite, 'project-cleanup', 5 * GB, NOW - 10 * 60 * 1000, 'target_unreachable');

    await tick(NOW);

    expect(sent()[0]!.notification).toMatchObject({
      urgency: 'medium',
      metadata: { alertKind: 'cleanup_unreachable', projectId: 'project-cleanup' },
    });
  });

  it('retries a failed delivery after the backoff instead of suppressing it for the window', async () => {
    const { sqlite, tick } = setup();
    seedProject(sqlite, 'project-sam', 'SAM');
    seedBreaker(sqlite, 'project-sam', 'open', NOW - HOUR);
    sendNotificationMock.mockImplementation(async (_env: Env, userId: string) => {
      if (userId === 'admin-1' && sendNotificationMock.mock.calls.length === 1) {
        throw new Error('NotificationService unavailable');
      }
      return { id: 'notification' };
    });

    const first = await tick(NOW);
    expect(first).toMatchObject({ notificationsSent: 1, deliveryFailures: 1 });

    // Inside the 15-minute backoff the failed recipient is not retried yet...
    const second = await tick(NOW + 5 * 60 * 1000);
    expect(second).toMatchObject({ notificationsSent: 0, throttled: 2, deliveryFailures: 0 });
    // ...and after it, well inside the 6-hour window, it is.
    const third = await tick(NOW + 20 * 60 * 1000);
    expect(third).toMatchObject({ notificationsSent: 1, throttled: 1, deliveryFailures: 0 });
    expect(sent().map((entry) => entry.userId)).toEqual(['admin-1', 'admin-2', 'admin-1']);
  });

  it('sends nothing when the throttle stamps cannot all be read', async () => {
    // A failed list, and a list still incomplete after the page budget, both fail closed.
    for (const scenario of ['list_failed', 'list_truncated'] as const) {
      sendNotificationMock.mockClear();
      const { sqlite, kv, tick } =
        scenario === 'list_failed'
          ? setup()
          : setup({ PROJECT_DATA_STORAGE_ALERT_THROTTLE_LIST_MAX_PAGES: '2' }, 1);
      seedProject(sqlite, 'project-sam', 'SAM');
      seedBreaker(sqlite, 'project-sam', 'open', NOW - HOUR);
      if (scenario === 'list_failed') {
        kv.list.mockRejectedValue(new Error('KV unavailable'));
      } else {
        // Three live stamps from other alerts, one per page: two pages cannot see them all.
        for (const key of ['a', 'b', 'c']) {
          await kv.put(`project-data-storage-alert:breaker_open:${key}:1:admin-1`, 'x', {
            expirationTtl: 3600,
          });
        }
      }

      const stats = await tick(NOW);

      expect(stats).toMatchObject({ candidates: 1, alerts: 0, deliveryFailures: 1 });
      expect(sendNotificationMock).not.toHaveBeenCalled();
    }
    // Control: the same truncated store with enough pages sends.
    sendNotificationMock.mockClear();
    const { sqlite, kv, tick } = setup(
      { PROJECT_DATA_STORAGE_ALERT_THROTTLE_LIST_MAX_PAGES: '4' },
      1
    );
    seedProject(sqlite, 'project-sam', 'SAM');
    seedBreaker(sqlite, 'project-sam', 'open', NOW - HOUR);
    for (const key of ['a', 'b', 'c']) {
      await kv.put(`project-data-storage-alert:breaker_open:${key}:1:admin-1`, 'x', {
        expirationTtl: 3600,
      });
    }
    expect(await tick(NOW)).toMatchObject({ alerts: 1, notificationsSent: 2 });
  });

  it('alerts again when a breaker re-opens inside the window', async () => {
    const { sqlite, tick } = setup();
    seedProject(sqlite, 'project-sam', 'SAM');
    seedBreaker(sqlite, 'project-sam', 'open', NOW - HOUR);
    await tick(NOW);
    expect(sendNotificationMock).toHaveBeenCalledTimes(2);

    // Closed by an operator, then opened again by a new systemic failure.
    seedBreaker(sqlite, 'project-sam', 'open', NOW + 10 * 60 * 1000);
    await tick(NOW + 15 * 60 * 1000);
    expect(sendNotificationMock).toHaveBeenCalledTimes(4);
  });

  it('ranks open breakers ahead of older frozen ones before the scan limit', async () => {
    const { sqlite, tick } = setup({ PROJECT_DATA_STORAGE_ALERT_SCAN_LIMIT: '1' });
    seedProject(sqlite, 'project-held-a', 'Held A');
    seedBreaker(sqlite, 'project-held-a', 'frozen', NOW - 3 * HOUR, 'operator hold');
    seedProject(sqlite, 'project-held-b', 'Held B');
    seedBreaker(sqlite, 'project-held-b', 'frozen', NOW - 2 * HOUR, 'operator hold');
    seedProject(sqlite, 'project-stuck', 'Stuck');
    seedBreaker(sqlite, 'project-stuck', 'open', NOW - HOUR);

    const stats = await tick(NOW);

    // The severity window of one is the stopped drain, ahead of two older freezes; the rotating
    // window adds the first project by id. The tick says it saw only part of the set.
    expect(stats).toMatchObject({ candidates: 2, scanTruncated: true });
    expect(sent()[0]!.notification.metadata.projectId).toBe('project-stuck');
    expect(new Set(sent().map((entry) => entry.notification.metadata.projectId))).toEqual(
      new Set(['project-stuck', 'project-held-a'])
    );
  });

  it('sends an escalated freeze ahead of a routine one when the cap bites', async () => {
    const { sqlite, tick } = setup({ PROJECT_DATA_STORAGE_ALERT_MAX_ALERTS_PER_TICK: '2' });
    seedProject(sqlite, 'project-routine', 'Routine');
    seedBreaker(sqlite, 'project-routine', 'frozen', NOW - 3 * HOUR, 'operator hold');
    seedTelemetry(sqlite, 'project-routine', 4 * GB, NOW);
    seedProject(sqlite, 'project-urgent', 'Urgent');
    seedBreaker(sqlite, 'project-urgent', 'frozen', NOW - 2 * HOUR, 'operator hold');
    seedTelemetry(sqlite, 'project-urgent', Math.ceil(CAP * 0.97), NOW);

    await tick(NOW);

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

  it('reads the largest objects first and every condition within a few ticks', async () => {
    const { sqlite, tick } = setup({ PROJECT_DATA_STORAGE_ALERT_SCAN_LIMIT: '2' });
    // Inserted smallest first, so an unordered LIMIT would read the wrong rows. The cleanup
    // condition shares the query and is the mildest of all.
    seedProject(sqlite, 'project-cleanup', 'Cleanup');
    seedTelemetry(sqlite, 'project-cleanup', 5 * GB, NOW, 'target_unreachable');
    for (const percent of [95, 96, 97, 98, 99]) {
      seedProject(sqlite, `project-${percent}`, `At ${percent}`);
      seedTelemetry(sqlite, `project-${percent}`, Math.ceil((CAP * percent) / 100), NOW);
    }
    const delivered = new Set<unknown>();
    const runTick = async (at: number) => {
      sendNotificationMock.mockClear();
      const stats = await tick(at);
      const projects = sent().map((entry) => entry.notification.metadata.projectId);
      projects.forEach((project) => delivered.add(project));
      return { stats, projects };
    };

    const first = await runTick(NOW);
    // The two largest are always in the window, and the tick discloses that it is truncated.
    expect(first.stats).toMatchObject({ scanTruncated: true });
    expect(first.projects.slice(0, 2)).toEqual(['project-99', 'project-99']);
    expect(delivered).toContain('project-98');
    // The rotating window walks the rest by project id until every condition was delivered.
    await runTick(NOW + 5 * 60 * 1000);
    await runTick(NOW + 10 * 60 * 1000);
    expect(delivered).toEqual(
      new Set([
        'project-95',
        'project-96',
        'project-97',
        'project-98',
        'project-99',
        'project-cleanup',
      ])
    );
  });

  it('treats exactly the wall ratio as near the wall', async () => {
    const { sqlite, tick } = setup();
    const wallBytes = Math.floor(CAP * 0.95);
    seedProject(sqlite, 'project-at-wall', 'At wall');
    seedTelemetry(sqlite, 'project-at-wall', wallBytes, NOW);
    seedProject(sqlite, 'project-below-wall', 'Below wall');
    seedTelemetry(sqlite, 'project-below-wall', wallBytes - 1, NOW);

    await tick(NOW);

    expect(new Set(sent().map((entry) => entry.notification.metadata.projectId))).toEqual(
      new Set(['project-at-wall'])
    );
  });

  it('never lets throttled conditions starve the ones ranked after them', async () => {
    const { sqlite, tick } = setup({ PROJECT_DATA_STORAGE_ALERT_MAX_ALERTS_PER_TICK: '1' });
    seedProject(sqlite, 'project-a', 'A');
    seedBreaker(sqlite, 'project-a', 'open', NOW - 2 * HOUR);
    seedProject(sqlite, 'project-b', 'B');
    seedBreaker(sqlite, 'project-b', 'open', NOW - HOUR);
    const FIVE_MINUTES = 5 * 60 * 1000;
    const projectsSentAt = async (at: number) => {
      sendNotificationMock.mockClear();
      const stats = await tick(at);
      return {
        stats,
        projects: [...new Set(sent().map((e) => e.notification.metadata.projectId))],
      };
    };
    // B's first delivery to admin-2 fails, so B must come back for admin-2 alone.
    sendNotificationMock.mockImplementation(async (_env: Env, userId: string, notification) => {
      if (
        userId === 'admin-2' &&
        (notification as SentNotification).metadata.projectId === 'project-b'
      ) {
        sendNotificationMock.mockImplementation(async () => ({ id: 'notification' }));
        throw new Error('NotificationService unavailable');
      }
      return { id: 'notification' };
    });

    // Tick 1: the budget of one goes to the older breaker; B is due but deferred.
    let result = await projectsSentAt(NOW);
    expect(result.projects).toEqual(['project-a']);
    expect(result.stats).toMatchObject({ alerts: 1, deferred: 1 });
    // Tick 2: A is throttled and costs no slot, so B is sent (admin-2's copy fails).
    result = await projectsSentAt(NOW + FIVE_MINUTES);
    expect(result.projects).toEqual(['project-b']);
    expect(result.stats).toMatchObject({
      alerts: 1,
      deferred: 0,
      throttled: 2,
      deliveryFailures: 1,
    });
    // Tick 3: admin-2's failed copy of B waits out its backoff; nothing else is due.
    result = await projectsSentAt(NOW + 2 * FIVE_MINUTES);
    expect(result.stats).toMatchObject({ alerts: 0, deferred: 0, throttled: 4 });
    // After the backoff, only admin-2's failed copy of B is due.
    result = await projectsSentAt(NOW + 4 * FIVE_MINUTES);
    expect(sent().map((entry) => entry.userId)).toEqual(['admin-2']);
    expect(result.projects).toEqual(['project-b']);
    // After the window both are due again, and the order repeats: every condition comes round.
    result = await projectsSentAt(NOW + 7 * HOUR);
    expect(result.projects).toEqual(['project-a']);
    result = await projectsSentAt(NOW + 7 * HOUR + FIVE_MINUTES);
    expect(result.projects).toEqual(['project-b']);
  });

  it('reaches conditions beyond both scan windows within a few ticks', async () => {
    const { sqlite, tick } = setup({
      PROJECT_DATA_STORAGE_ALERT_SCAN_LIMIT: '2',
      PROJECT_DATA_STORAGE_ALERT_MAX_ALERTS_PER_TICK: '10',
    });
    // Severity order (oldest first) is the reverse of id order, so the two windows differ.
    for (const [index, id] of [
      'project-1',
      'project-2',
      'project-3',
      'project-4',
      'project-5',
    ].entries()) {
      seedProject(sqlite, id, id);
      seedBreaker(sqlite, id, 'open', NOW - (index + 1) * HOUR);
    }
    const ticks: unknown[][] = [];
    for (const at of [NOW, NOW + 5 * 60 * 1000, NOW + 10 * 60 * 1000]) {
      sendNotificationMock.mockClear();
      await tick(at);
      ticks.push([...new Set(sent().map((entry) => entry.notification.metadata.projectId))]);
    }

    // Tick 1: the two oldest (severity) and the first two by id (rotation).
    expect(new Set(ticks[0])).toEqual(
      new Set(['project-5', 'project-4', 'project-1', 'project-2'])
    );
    // Tick 2: the rotation moves on and reaches the one no fixed window would ever read.
    expect(ticks[1]).toEqual(['project-3']);
    // Tick 3: everything is throttled; the rotation wrapped without re-sending anything.
    expect(ticks[2]).toEqual([]);
  });

  it('sends a condition read by both windows once', async () => {
    const { sqlite, tick } = setup({ PROJECT_DATA_STORAGE_ALERT_SCAN_LIMIT: '2' });
    // Oldest first is also id order, so the severity and rotating windows read the same rows.
    for (const [index, id] of ['project-1', 'project-2', 'project-3'].entries()) {
      seedProject(sqlite, id, id);
      seedBreaker(sqlite, id, 'open', NOW - (10 - index) * HOUR);
    }

    await tick(NOW);

    expect(
      sent().map((entry) => `${entry.notification.metadata.projectId}:${entry.userId}`)
    ).toEqual(['project-1:admin-1', 'project-1:admin-2', 'project-2:admin-1', 'project-2:admin-2']);
  });

  it('keeps a recipient whose deliveries keep failing from holding back the healthy one', async () => {
    const { sqlite, tick } = setup({ PROJECT_DATA_STORAGE_ALERT_MAX_ALERTS_PER_TICK: '1' });
    seedProject(sqlite, 'project-a', 'A');
    seedBreaker(sqlite, 'project-a', 'open', NOW - 2 * HOUR);
    seedProject(sqlite, 'project-b', 'B');
    seedBreaker(sqlite, 'project-b', 'open', NOW - HOUR);
    sendNotificationMock.mockImplementation(async (_env: Env, userId: string) => {
      if (userId === 'admin-1') throw new Error('push endpoint gone');
      return { id: 'notification' };
    });
    const healthyGot = () =>
      sent()
        .filter((entry) => entry.userId === 'admin-2')
        .map((entry) => entry.notification.metadata.projectId);

    await tick(NOW);
    await tick(NOW + 5 * 60 * 1000);
    // A's failing copy is backed off, so B gets the slot and reaches the healthy recipient.
    expect(healthyGot()).toEqual(['project-a', 'project-b']);
    // The failing recipient is still retried, once per backoff, not suppressed for good.
    await tick(NOW + 20 * 60 * 1000);
    expect(
      sent()
        .filter((entry) => entry.userId === 'admin-1')
        .map((e) => e.notification.metadata.projectId)
    ).toEqual(['project-a', 'project-b', 'project-a']);
  });

  it('ranks a freeze whose own project is near the wall ahead of older routine freezes', async () => {
    const { sqlite, tick } = setup({
      PROJECT_DATA_STORAGE_ALERT_SCAN_LIMIT: '2',
      PROJECT_DATA_STORAGE_ALERT_MAX_ALERTS_PER_TICK: '1',
    });
    for (const [index, age] of [5, 4, 3].entries()) {
      seedProject(sqlite, `project-routine-${index}`, `Routine ${index}`);
      seedBreaker(sqlite, `project-routine-${index}`, 'frozen', NOW - age * HOUR, 'operator hold');
      seedTelemetry(sqlite, `project-routine-${index}`, 4 * GB, NOW);
    }
    seedProject(sqlite, 'project-urgent', 'Urgent');
    seedBreaker(sqlite, 'project-urgent', 'frozen', NOW - HOUR, 'operator hold');
    seedTelemetry(sqlite, 'project-urgent', Math.ceil(CAP * 0.97), NOW);
    const alertsAt = async (at: number) => {
      sendNotificationMock.mockClear();
      await tick(at);
      return [
        ...new Set(
          sent().map(
            (e) =>
              `${e.notification.metadata.projectId}:${e.notification.metadata.alertKind}:${e.notification.urgency}`
          )
        ),
      ];
    };

    // The newest freeze is the only near-wall one, yet it is read ahead of three older ones,
    // and its near-wall condition taking this tick's slot does not keep the escalation out.
    expect(await alertsAt(NOW)).toEqual(['project-urgent:near_wall:high']);
    expect(await alertsAt(NOW + 5 * 60 * 1000)).toEqual(['project-urgent:breaker_frozen:high']);
    expect(await alertsAt(NOW + 10 * 60 * 1000)).toEqual([
      'project-routine-0:breaker_frozen:medium',
    ]);
  });
});
