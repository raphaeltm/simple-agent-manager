/**
 * Unit tests for notification preference storage + resolution in
 * NotificationService, focused on the storage sentinel boundary:
 *
 *   - The DO stores "global / no project" preferences as project_id = ''
 *     (SQLite UNIQUE does not treat NULL as equal), but the API surface must
 *     only ever expose projectId: null. These tests assert the round-trip
 *     '' -> null and that the DO never leaks the empty-string sentinel.
 *   - isNotificationEnabled() resolution order: project-specific > type-global
 *     > wildcard-global > default-enabled.
 *
 * Because NotificationService is a Durable Object that uses SqlStorage, we
 * exercise the real DO class against a minimal mock mirroring the subset of
 * SqlStorage semantics the preference queries rely on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fromStoredPreferenceProjectId,
  toStoredPreferenceProjectId,
} from '../../../src/durable-objects/notification-row-schemas';

// ---------------------------------------------------------------------------
// MockSqlStorage — handles notification_preferences + notifications subset
// ---------------------------------------------------------------------------

type SqlRow = Record<string, unknown>;

interface PrefRow {
  user_id: string;
  notification_type: string;
  project_id: string;
  channel: string;
  enabled: number;
}

class MockSqlStorage {
  private prefs: PrefRow[] = [];
  private notifications: SqlRow[] = [];

  exec(query: string, ...params: unknown[]): { toArray: () => SqlRow[] } {
    const trimmed = query.trim();
    const q = trimmed.toUpperCase();

    // --- notification_preferences upsert -----------------------------------
    if (q.startsWith('INSERT INTO NOTIFICATION_PREFERENCES')) {
      const [userId, notificationType, projectId, channel, enabled] = params as [
        string,
        string,
        string,
        string,
        number,
      ];
      const existing = this.prefs.find(
        (p) =>
          p.user_id === userId &&
          p.notification_type === notificationType &&
          p.project_id === projectId &&
          p.channel === channel
      );
      if (existing) {
        existing.enabled = enabled;
      } else {
        this.prefs.push({
          user_id: userId,
          notification_type: notificationType,
          project_id: projectId,
          channel,
          enabled,
        });
      }
      return { toArray: () => [] };
    }

    // --- SELECT * FROM notification_preferences WHERE user_id = ? -----------
    if (q.startsWith('SELECT * FROM NOTIFICATION_PREFERENCES')) {
      const userId = params[0] as string;
      const matched = this.prefs.filter((p) => p.user_id === userId);
      return { toArray: () => matched.map((p) => ({ ...p })) };
    }

    // --- SELECT enabled FROM notification_preferences WHERE ... -------------
    if (q.startsWith('SELECT ENABLED FROM NOTIFICATION_PREFERENCES')) {
      const isWildcard = /NOTIFICATION_TYPE\s*=\s*'\*'/.test(q);
      let userId: string;
      let notificationType: string;
      let projectId: string;
      if (isWildcard) {
        [userId, projectId] = params as [string, string];
        notificationType = '*';
      } else {
        [userId, notificationType, projectId] = params as [string, string, string];
      }
      const matched = this.prefs.filter(
        (p) =>
          p.user_id === userId &&
          p.notification_type === notificationType &&
          p.project_id === projectId &&
          p.channel === 'in_app'
      );
      return { toArray: () => matched.map((p) => ({ enabled: p.enabled })) };
    }

    // --- notifications: minimal support for createNotification -------------
    if (q.startsWith('INSERT INTO NOTIFICATIONS')) {
      this.notifications.push({
        id: params[0] as string,
        user_id: params[1] as string,
        project_id: params[2] as string | null,
        task_id: params[3] as string | null,
        session_id: params[4] as string | null,
        type: params[5] as string,
        urgency: params[6] as string,
        title: params[7] as string,
        body: params[8] as string | null,
        action_url: params[9] as string | null,
        metadata: params[10] as string | null,
        created_at: params[11] as number,
        read_at: null,
        dismissed_at: null,
      });
      return { toArray: () => [] };
    }
    if (q.startsWith('SELECT ID FROM NOTIFICATIONS')) {
      // No dedup matches needed for these tests
      return { toArray: () => [] };
    }
    if (q.startsWith('SELECT * FROM NOTIFICATIONS WHERE ID')) {
      const matched = this.notifications.filter((r) => r.id === params[0]);
      return { toArray: () => matched.map((r) => ({ ...r })) };
    }
    if (q.includes('COUNT(*)')) {
      return { toArray: () => [{ cnt: this.notifications.length }] };
    }

    // DELETE / UPDATE / other: no-op
    return { toArray: () => [] };
  }

  getNotifications(): SqlRow[] {
    return this.notifications;
  }

  getPrefs(): PrefRow[] {
    return this.prefs;
  }
}

// ---------------------------------------------------------------------------
// DO harness
// ---------------------------------------------------------------------------

function createFakeDOState(sql: MockSqlStorage) {
  return {
    storage: { sql },
    blockConcurrencyWhile: (fn: () => Promise<void>) => fn(),
    id: { toString: () => 'fake-do-id' },
    waitUntil: vi.fn(),
    acceptWebSocket: vi.fn(),
    getWebSockets: vi.fn().mockReturnValue([]),
  };
}

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      protected ctx: ReturnType<typeof createFakeDOState>,
      protected env: Record<string, string>
    ) {}
  },
  WebSocketPair: vi.fn(),
}));

vi.mock('../../../src/durable-objects/notification-migrations', () => ({
  runNotificationMigrations: vi.fn(),
}));

const { NotificationService } = await import('../../../src/durable-objects/notification');

function makeService(sql: MockSqlStorage, env: Record<string, string> = {}) {
  return new NotificationService(createFakeDOState(sql) as any, env);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('notification preference sentinel helpers', () => {
  it('toStoredPreferenceProjectId maps null/undefined to the empty sentinel', () => {
    expect(toStoredPreferenceProjectId(null)).toBe('');
    expect(toStoredPreferenceProjectId(undefined)).toBe('');
  });

  it('toStoredPreferenceProjectId passes through a real project id', () => {
    expect(toStoredPreferenceProjectId('proj-1')).toBe('proj-1');
  });

  it('fromStoredPreferenceProjectId maps the empty sentinel back to null', () => {
    expect(fromStoredPreferenceProjectId('')).toBeNull();
  });

  it('fromStoredPreferenceProjectId passes through a real project id', () => {
    expect(fromStoredPreferenceProjectId('proj-1')).toBe('proj-1');
  });
});

describe('NotificationService preference round-trip', () => {
  let sql: MockSqlStorage;
  let service: InstanceType<typeof NotificationService>;

  beforeEach(() => {
    sql = new MockSqlStorage();
    service = makeService(sql);
  });

  it('stores a global preference as the empty sentinel and reads it back as null', async () => {
    await service.updatePreference('user-1', 'task_complete', 'in_app', false);

    // Stored form uses the '' sentinel
    expect(sql.getPrefs()[0]!.project_id).toBe('');

    // API form must expose null, never ''
    const prefs = await service.getPreferences('user-1');
    expect(prefs).toHaveLength(1);
    expect(prefs[0]!.projectId).toBeNull();
    expect(prefs[0]!.notificationType).toBe('task_complete');
    expect(prefs[0]!.enabled).toBe(false);
  });

  it('does not expose an empty-string projectId for any returned preference', async () => {
    await service.updatePreference('user-1', '*', 'in_app', false);
    await service.updatePreference('user-1', 'error', 'in_app', true, 'proj-9');

    const prefs = await service.getPreferences('user-1');
    for (const pref of prefs) {
      expect(pref.projectId).not.toBe('');
    }
    const globalPref = prefs.find((p) => p.notificationType === '*');
    expect(globalPref!.projectId).toBeNull();
    const projectPref = prefs.find((p) => p.notificationType === 'error');
    expect(projectPref!.projectId).toBe('proj-9');
  });

  it('passing null and undefined projectId resolve to the same stored row (upsert dedupe)', async () => {
    await service.updatePreference('user-1', 'progress', 'in_app', true, null);
    await service.updatePreference('user-1', 'progress', 'in_app', false, undefined);

    // Only one row — the second call updated the first via ON CONFLICT
    const globalRows = sql.getPrefs().filter((p) => p.notification_type === 'progress');
    expect(globalRows).toHaveLength(1);
    expect(globalRows[0]!.enabled).toBe(0);
  });
});

describe('NotificationService isNotificationEnabled resolution', () => {
  let sql: MockSqlStorage;
  let service: InstanceType<typeof NotificationService>;

  beforeEach(() => {
    sql = new MockSqlStorage();
    service = makeService(sql);
  });

  it('defaults to enabled when no preference exists', async () => {
    expect(await service.isNotificationEnabled('user-1', 'task_complete')).toBe(true);
  });

  it('a global type-specific disable suppresses creation of that type', async () => {
    await service.updatePreference('user-1', 'task_complete', 'in_app', false);

    expect(await service.isNotificationEnabled('user-1', 'task_complete')).toBe(false);

    const result = await service.createNotification('user-1', {
      type: 'task_complete',
      urgency: 'medium',
      title: 'Task done',
      taskId: 'task-1',
      projectId: 'proj-1',
    });

    // Suppressed — no row inserted, stub returned
    expect(result.id).toBe('suppressed');
    expect(sql.getNotifications()).toHaveLength(0);
  });

  it('a wildcard global disable suppresses every type', async () => {
    await service.updatePreference('user-1', '*', 'in_app', false);

    expect(await service.isNotificationEnabled('user-1', 'error')).toBe(false);
    expect(await service.isNotificationEnabled('user-1', 'progress')).toBe(false);

    const result = await service.createNotification('user-1', {
      type: 'error',
      urgency: 'high',
      title: 'Something broke',
    });
    expect(result.id).toBe('suppressed');
    expect(sql.getNotifications()).toHaveLength(0);
  });

  it('a project-specific enable overrides a wildcard global disable', async () => {
    await service.updatePreference('user-1', '*', 'in_app', false);
    await service.updatePreference('user-1', 'task_complete', 'in_app', true, 'proj-1');

    // Within proj-1 the type is explicitly enabled
    expect(
      await service.isNotificationEnabled('user-1', 'task_complete', 'proj-1')
    ).toBe(true);

    // Outside proj-1 the wildcard global disable still applies
    expect(
      await service.isNotificationEnabled('user-1', 'task_complete', 'proj-2')
    ).toBe(false);

    const result = await service.createNotification('user-1', {
      type: 'task_complete',
      urgency: 'medium',
      title: 'Task done in proj-1',
      projectId: 'proj-1',
      taskId: 'task-7',
    });
    expect(result.id).not.toBe('suppressed');
    expect(sql.getNotifications()).toHaveLength(1);
  });

  it('a project-specific disable overrides a type-global enable', async () => {
    await service.updatePreference('user-1', 'progress', 'in_app', true);
    await service.updatePreference('user-1', 'progress', 'in_app', false, 'proj-1');

    expect(await service.isNotificationEnabled('user-1', 'progress', 'proj-1')).toBe(false);
    // A different project falls through to the type-global enable
    expect(await service.isNotificationEnabled('user-1', 'progress', 'proj-2')).toBe(true);
  });

  it('a type-global preference beats the wildcard global preference', async () => {
    await service.updatePreference('user-1', '*', 'in_app', false);
    await service.updatePreference('user-1', 'pr_created', 'in_app', true);

    expect(await service.isNotificationEnabled('user-1', 'pr_created')).toBe(true);
    expect(await service.isNotificationEnabled('user-1', 'error')).toBe(false);
  });
});
