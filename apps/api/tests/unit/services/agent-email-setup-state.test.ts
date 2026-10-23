/**
 * Agent email's on-switch: the send binding plus the record the admin setup writes, read through
 * a real SQLite `platform_settings` table and the per-isolate cache.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { withRequestScopedD1Bindings } from '../../../src/lib/d1-session';
import { log } from '../../../src/lib/logger';
import { ADMIN_SETTINGS_CACHE_MAX_MS } from '../../../src/services/admin-settings-cache';
import { findAdminSetting } from '../../../src/services/admin-settings-registry';
import {
  activeAgentEmailSender,
  AGENT_EMAIL_SETUP_KEY,
  agentEmailConfig,
  isAgentEmailOn,
  readAgentEmailSetup,
  recordAgentEmailSetup,
} from '../../../src/services/agent-email/setup-state';
import { createAllSchemaTables, createMemoryKv, createSqliteD1 } from '../../helpers/sqlite-d1';

const BASE_DOMAIN = 'fixture.example';
const DOMAIN = `agents.${BASE_DOMAIN}`;

describe('agent email on-switch', () => {
  let sqlite: Database.Database;
  let env: Env;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    env = {
      DATABASE: createSqliteD1(sqlite),
      KV: createMemoryKv(),
      BASE_DOMAIN,
      AGENT_EMAIL: { send: vi.fn() } as unknown as SendEmail,
    } as Env;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    sqlite.close();
  });

  function writeRow(value: string) {
    sqlite
      .prepare(
        `INSERT INTO platform_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, 'admin-1')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(AGENT_EMAIL_SETUP_KEY, value, new Date().toISOString());
  }

  const record = (domain = DOMAIN) => ({
    domain,
    enabledAt: '2026-10-23T08:00:00.000Z',
    mainDomainChanges: [],
  });

  it('is off with the binding alone, and on once the setup recorded this domain', async () => {
    expect(await isAgentEmailOn(env)).toBe(false);
    expect(await agentEmailConfig(env)).toEqual({ enabled: false, domain: null });
    expect(await activeAgentEmailSender(env)).toBeNull();

    await recordAgentEmailSetup(env, record(), 'admin-1');

    expect(await isAgentEmailOn(env)).toBe(true);
    expect(await agentEmailConfig(env)).toEqual({ enabled: true, domain: DOMAIN });
    expect(await activeAgentEmailSender(env)).not.toBeNull();
    expect(
      sqlite
        .prepare('SELECT updated_by FROM platform_settings WHERE key = ?')
        .get(AGENT_EMAIL_SETUP_KEY)
    ).toEqual({ updated_by: 'admin-1' });
  });

  it('is off without the binding even when a setup record exists', async () => {
    writeRow(JSON.stringify(record()));
    const withoutBinding = { ...env, AGENT_EMAIL: undefined } as Env;
    expect(await isAgentEmailOn(withoutBinding)).toBe(false);
    expect(await activeAgentEmailSender(withoutBinding)).toBeNull();
    expect(await isAgentEmailOn(env)).toBe(true);
  });

  it('is off when the record names another domain, as after BASE_DOMAIN changed', async () => {
    writeRow(JSON.stringify(record('agents.old.example')));
    expect(await isAgentEmailOn(env)).toBe(false);
    expect(await agentEmailConfig(env)).toEqual({ enabled: false, domain: null });
  });

  it('treats an unreadable record as off and reports it', async () => {
    const error = vi.spyOn(log, 'error');
    for (const value of ['not json', JSON.stringify({ domain: DOMAIN }), JSON.stringify([1])]) {
      writeRow(value);
      expect(await readAgentEmailSetup(env), value).toBeNull();
      expect(await isAgentEmailOn(env), value).toBe(false);
    }
    expect(error).toHaveBeenCalledWith('agent_email.setup_record_unreadable', {
      key: AGENT_EMAIL_SETUP_KEY,
    });
  });

  it('sees agent email turned on at once, and caches it once on', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-23T08:00:00Z') });
    expect(await isAgentEmailOn(env)).toBe(false);

    // Another isolate ran the setup: an absent record was not cached, so this one sees it now.
    writeRow(JSON.stringify(record()));
    expect(await isAgentEmailOn(env)).toBe(true);

    // Once on, the record is cached for the admin settings ceiling.
    sqlite.prepare('DELETE FROM platform_settings').run();
    vi.advanceTimersByTime(ADMIN_SETTINGS_CACHE_MAX_MS - 1);
    expect(await isAgentEmailOn(env)).toBe(true);
    vi.advanceTimersByTime(2);
    expect(await isAgentEmailOn(env)).toBe(false);

    // The setup's own write refreshes the cache too.
    await recordAgentEmailSetup(env, record(), 'admin-1');
    sqlite.prepare('DELETE FROM platform_settings').run();
    expect(await isAgentEmailOn(env)).toBe(true);
  });

  it('shares the cached record across request-scoped D1 session facades', async () => {
    type SessionEnv = Parameters<typeof withRequestScopedD1Bindings>[0];
    const first = withRequestScopedD1Bindings(env as unknown as SessionEnv) as unknown as Env;
    const second = withRequestScopedD1Bindings(env as unknown as SessionEnv) as unknown as Env;
    // Liveness: these are distinct facades, as each Worker request gets.
    expect(first.DATABASE).not.toBe(second.DATABASE);
    expect(first.DATABASE).not.toBe(env.DATABASE);

    await recordAgentEmailSetup(first, record(), 'admin-1');
    // With the row gone, only the cache entry the first request wrote can say "on".
    sqlite.prepare('DELETE FROM platform_settings').run();
    expect(await isAgentEmailOn(second)).toBe(true);
    expect(await isAgentEmailOn(env)).toBe(true);
  });

  it('keeps its record out of the admin settings registry, which writes the same table', () => {
    expect(findAdminSetting(AGENT_EMAIL_SETUP_KEY)).toBeUndefined();
  });

  it('reports agent email off while the store cannot be read', async () => {
    const error = vi.spyOn(log, 'error');
    const broken = {
      ...env,
      DATABASE: {
        prepare: () => {
          throw new Error('D1_ERROR: storage unavailable');
        },
      } as unknown as D1Database,
    } as Env;

    await expect(isAgentEmailOn(broken)).rejects.toThrow('storage unavailable');
    expect(await agentEmailConfig(broken)).toEqual({ enabled: false, domain: null });
    expect(error).toHaveBeenCalledWith('agent_email.config_unavailable', {
      error: 'D1_ERROR: storage unavailable',
    });
  });
});
