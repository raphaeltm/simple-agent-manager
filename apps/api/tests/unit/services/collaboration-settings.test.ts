import { DEFAULT_COMMENT_NOTIFICATION_WINDOW_MS } from '@simple-agent-manager/shared';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import {
  getCommentMentionsMax,
  getCommentNotificationWindowMs,
  getSessionAccessMaxGrants,
} from '../../../src/services/collaboration-settings';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';

/**
 * Each getter is a thin wrapper around the real admin-settings resolver
 * (`resolveAdminSetting`). These tests drive that resolver against a real D1-backed
 * admin-settings store (`createAdminSettingsEnv`) rather than mocking it, so the
 * default/override/outage behavior proven here is the behavior production gets.
 */

let sqlite: Database.Database;
let env: Env;

beforeEach(() => {
  ({ sqlite, env } = createAdminSettingsEnv());
});

afterEach(() => {
  vi.restoreAllMocks();
  sqlite.close();
});

function setOverride(key: string, value: unknown): void {
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO platform_settings (key, value, updated_at, updated_by)
       VALUES (?, ?, '2026-01-01T00:00:00Z', NULL)`
    )
    .run(key, JSON.stringify(value));
}

function breakAdminSettingsRead(): void {
  vi.spyOn(env.DATABASE, 'prepare').mockImplementation(() => {
    throw new Error('simulated D1 outage');
  });
}

describe('getSessionAccessMaxGrants', () => {
  it('returns the code default when nothing is configured', async () => {
    expect(await getSessionAccessMaxGrants(env)).toBe(10);
  });

  it('returns an admin-configured override', async () => {
    setOverride('collaboration.sessionAccessMaxGrants', 7);

    expect(await getSessionAccessMaxGrants(env)).toBe(7);
  });

  it('falls back to the default when the stored override value is invalid', async () => {
    setOverride('collaboration.sessionAccessMaxGrants', 0); // below the registry's min:1

    expect(await getSessionAccessMaxGrants(env)).toBe(10);
  });

  it('falls back to the default when the admin settings read fails', async () => {
    breakAdminSettingsRead();

    expect(await getSessionAccessMaxGrants(env)).toBe(10);
  });
});

describe('getCommentMentionsMax', () => {
  it('returns the code default when nothing is configured', async () => {
    expect(await getCommentMentionsMax(env)).toBe(10);
  });

  it('returns an admin-configured override', async () => {
    setOverride('collaboration.commentMentionsMax', 3);

    expect(await getCommentMentionsMax(env)).toBe(3);
  });

  it('falls back to the default when the stored override value is invalid', async () => {
    setOverride('collaboration.commentMentionsMax', 0); // below the registry's min:1

    expect(await getCommentMentionsMax(env)).toBe(10);
  });

  it('falls back to the default when the admin settings read fails', async () => {
    breakAdminSettingsRead();

    expect(await getCommentMentionsMax(env)).toBe(10);
  });
});

describe('getCommentNotificationWindowMs', () => {
  it('returns the code default (in ms) when nothing is configured', async () => {
    expect(await getCommentNotificationWindowMs(env)).toBe(DEFAULT_COMMENT_NOTIFICATION_WINDOW_MS);
  });

  it('returns an admin-configured override, converting seconds to milliseconds', async () => {
    setOverride('collaboration.commentNotificationWindowSeconds', 120);

    expect(await getCommentNotificationWindowMs(env)).toBe(120_000);
  });

  it('falls back to the default when the stored override value is invalid', async () => {
    setOverride('collaboration.commentNotificationWindowSeconds', 10); // below the registry's min:60

    expect(await getCommentNotificationWindowMs(env)).toBe(DEFAULT_COMMENT_NOTIFICATION_WINDOW_MS);
  });

  it('falls back to the default when the admin settings read fails', async () => {
    breakAdminSettingsRead();

    expect(await getCommentNotificationWindowMs(env)).toBe(DEFAULT_COMMENT_NOTIFICATION_WINDOW_MS);
  });
});
