/**
 * `operations.operatorNodeDeletionAllowAgentSessions` through the real admin-settings resolver.
 *
 * Owner decision (ask 01M7RX9S6DG1NDNKPPHARGBT96): agents may relay a person's check by default.
 * The switch is a trust boundary, so an unreadable settings store must fail closed instead of
 * falling back to the permissive default (CodeRabbit / Codex review on PR #2904).
 */
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '../../../src/env';
import {
  __resetAdminSettingsCacheForTest,
  resolveAdminSetting,
  updateAdminSettings,
} from '../../../src/services/admin-settings';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';

const NAME = 'operations.operatorNodeDeletionAllowAgentSessions' as const;

let sqlite: Database.Database;
let env: Env;

beforeEach(() => {
  __resetAdminSettingsCacheForTest();
  ({ sqlite, env } = createAdminSettingsEnv());
});
afterEach(() => {
  sqlite.close();
  __resetAdminSettingsCacheForTest();
});

function unreadable(base: Env): Env {
  return {
    ...base,
    DATABASE: {
      prepare: () => {
        throw new Error('D1 unavailable');
      },
      batch: () => Promise.reject(new Error('D1 unavailable')),
    },
  } as unknown as Env;
}

describe('operator node deletion agent-session setting', () => {
  it('allows agent sessions by default when nothing is stored', async () => {
    expect(await resolveAdminSetting(env, NAME)).toBe(true);
  });

  it('honours an explicit off', async () => {
    await updateAdminSettings(env, {
      changes: [{ name: NAME, value: false }],
      actorUserId: 'admin',
    });
    __resetAdminSettingsCacheForTest();
    expect(await resolveAdminSetting(env, NAME)).toBe(false);
  });

  it('fails closed when the settings store cannot be read on a fresh isolate', async () => {
    await updateAdminSettings(env, {
      changes: [{ name: NAME, value: false }],
      actorUserId: 'admin',
    });
    // A fresh isolate: nothing remembered, and the settings read fails.
    __resetAdminSettingsCacheForTest();
    expect(await resolveAdminSetting(unreadable(env), NAME)).toBe(false);
  });
});
