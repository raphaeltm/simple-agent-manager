/**
 * Agent email's on-switch and the setup's attempt record, read and written through a real
 * SQLite `platform_settings` table.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { log } from '../../../src/lib/logger';
import { findAdminSetting } from '../../../src/services/admin-settings-registry';
import {
  activeAgentEmailSender,
  AGENT_EMAIL_SETUP_KEY,
  agentEmailConfig,
  type AgentEmailSetupAttempt,
  claimSetupAttempt,
  completeAgentEmailSetup,
  isAgentEmailOn,
  readAgentEmailSetup,
  readSetupAttempt,
  replaceSetupAttempt,
} from '../../../src/services/agent-email/setup-state';
import { createAllSchemaTables, createMemoryKv, createSqliteD1 } from '../../helpers/sqlite-d1';

const BASE_DOMAIN = 'fixture.example';
const DOMAIN = `agents.${BASE_DOMAIN}`;
const ATTEMPT_KEY = `agent_email.setup_attempt:${DOMAIN}`;

describe('agent email on-switch and setup attempt', () => {
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
    vi.restoreAllMocks();
    sqlite.close();
  });

  function writeRow(key: string, value: string) {
    sqlite
      .prepare(
        `INSERT INTO platform_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, 'admin-1')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value, new Date().toISOString());
  }

  const record = (domain = DOMAIN) => ({
    domain,
    enabledAt: '2026-10-23T08:00:00.000Z',
    mainDomainChanges: [],
    zoneChanges: [],
  });

  const attempt = (overrides: Partial<AgentEmailSetupAttempt> = {}): AgentEmailSetupAttempt => ({
    domain: DOMAIN,
    startedAt: '2026-10-23T08:00:00.000Z',
    startedBy: 'admin-1',
    baseline: [{ type: 'MX', content: 'mx.example.net', priority: 10 }],
    allowed: [{ type: 'TXT', content: 'v=spf1 include:_spf.mx.cloudflare.net ~all' }],
    zoneChanges: ['subaddressing'],
    owner: 'run-1',
    leaseUntil: '2999-01-01T00:00:00.000Z',
    ...overrides,
  });

  /** Turns agent email on as a setup run does: from an attempt it owns. */
  async function completeFromAttempt(updatedBy = 'admin-1') {
    const owned = await claimSetupAttempt(env, attempt());
    expect(await completeAgentEmailSetup(env, record(), updatedBy, owned)).toBe(true);
  }

  describe('on-switch', () => {
    it('is off with the binding alone, and on once the setup completed for this domain', async () => {
      expect(await isAgentEmailOn(env)).toBe(false);
      expect(await agentEmailConfig(env)).toEqual({ enabled: false, domain: null });
      expect(await activeAgentEmailSender(env)).toBeNull();

      await completeFromAttempt();

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
      writeRow(AGENT_EMAIL_SETUP_KEY, JSON.stringify(record()));
      const withoutBinding = { ...env, AGENT_EMAIL: undefined } as Env;
      expect(await isAgentEmailOn(withoutBinding)).toBe(false);
      expect(await activeAgentEmailSender(withoutBinding)).toBeNull();
      expect(await isAgentEmailOn(env)).toBe(true);
    });

    it('is off when the record names another domain, as after BASE_DOMAIN changed', async () => {
      writeRow(AGENT_EMAIL_SETUP_KEY, JSON.stringify(record('agents.old.example')));
      expect(await isAgentEmailOn(env)).toBe(false);
      expect(await agentEmailConfig(env)).toEqual({ enabled: false, domain: null });
    });

    it('reads the record on every check, so a change takes effect at once', async () => {
      writeRow(AGENT_EMAIL_SETUP_KEY, JSON.stringify(record()));
      expect(await isAgentEmailOn(env)).toBe(true);
      sqlite.prepare('DELETE FROM platform_settings').run();
      expect(await isAgentEmailOn(env)).toBe(false);
    });

    it('treats an unreadable record as off and reports it', async () => {
      const error = vi.spyOn(log, 'error');
      for (const value of ['not json', JSON.stringify({ domain: DOMAIN }), JSON.stringify([1])]) {
        writeRow(AGENT_EMAIL_SETUP_KEY, value);
        expect(await readAgentEmailSetup(env), value).toBeNull();
        expect(await isAgentEmailOn(env), value).toBe(false);
      }
      expect(error).toHaveBeenCalledWith('agent_email.setup_record_unreadable', {
        key: AGENT_EMAIL_SETUP_KEY,
      });
    });

    it('reports agent email off while the store cannot be read, and the gates fail', async () => {
      const error = vi.spyOn(log, 'error');
      writeRow(AGENT_EMAIL_SETUP_KEY, JSON.stringify(record()));
      expect(await isAgentEmailOn(env)).toBe(true);
      const broken = {
        ...env,
        DATABASE: {
          prepare: () => {
            throw new Error('D1_ERROR: storage unavailable');
          },
        } as unknown as D1Database,
      } as Env;

      await expect(isAgentEmailOn(broken)).rejects.toThrow('storage unavailable');
      await expect(activeAgentEmailSender(broken)).rejects.toThrow('storage unavailable');
      expect(await agentEmailConfig(broken)).toEqual({ enabled: false, domain: null });
      expect(error).toHaveBeenCalledWith('agent_email.config_unavailable', {
        error: 'D1_ERROR: storage unavailable',
      });
    });

    it('keeps its keys out of the admin settings registry, which writes the same table', () => {
      expect(findAdminSetting(AGENT_EMAIL_SETUP_KEY)).toBeUndefined();
      expect(findAdminSetting(ATTEMPT_KEY)).toBeUndefined();
    });
  });

  describe('setup attempt', () => {
    it('keeps the first attempt stored: a later claim gets the first one back', async () => {
      const first = await claimSetupAttempt(env, attempt());
      expect(first.attempt).toEqual(attempt());

      const second = await claimSetupAttempt(env, attempt({ startedBy: 'admin-2', baseline: [] }));
      expect(second.attempt).toEqual(attempt());
      expect(await readSetupAttempt(env, DOMAIN)).toEqual(first);
    });

    it('replaces an attempt only if no other run changed it since it was read', async () => {
      const read = await claimSetupAttempt(env, attempt());
      const next = attempt({ baseline: [], startedBy: 'admin-2' });
      expect(await replaceSetupAttempt(env, read, next)).toBe(true);
      expect((await readSetupAttempt(env, DOMAIN))?.attempt).toEqual(next);

      // `read` is now stale: another run's write landed after it.
      expect(await replaceSetupAttempt(env, read, attempt({ startedBy: 'admin-3' }))).toBe(false);
      expect((await readSetupAttempt(env, DOMAIN))?.attempt).toEqual(next);
    });

    it('completes by turning agent email on and dropping the attempt together', async () => {
      await completeFromAttempt();
      expect(await isAgentEmailOn(env)).toBe(true);
      expect(await readSetupAttempt(env, DOMAIN)).toBeNull();
    });

    it('lets no run complete once its lease has lapsed', async () => {
      const lapsed = await claimSetupAttempt(
        env,
        attempt({ leaseUntil: '2000-01-01T00:00:00.000Z' })
      );
      expect(await completeAgentEmailSetup(env, record(), 'admin-1', lapsed)).toBe(false);
      expect(await isAgentEmailOn(env)).toBe(false);
      expect(await readSetupAttempt(env, DOMAIN)).toEqual(lapsed);
    });

    it('lets no attempt complete without a lease owner, since its finishing mark names the owner', async () => {
      const unowned = await claimSetupAttempt(env, attempt({ owner: null }));
      expect(await completeAgentEmailSetup(env, record(), 'admin-1', unowned)).toBe(false);
      expect(await isAgentEmailOn(env)).toBe(false);
      expect(await readSetupAttempt(env, DOMAIN)).toEqual(unowned);
    });

    it('reads an attempt stored before the lease existed as unleased', async () => {
      const legacy: Record<string, unknown> = { ...attempt() };
      delete legacy.owner;
      delete legacy.leaseUntil;
      writeRow(ATTEMPT_KEY, JSON.stringify(legacy));
      const read = await readSetupAttempt(env, DOMAIN);
      expect(read?.attempt).toMatchObject({
        baseline: legacy.baseline,
        owner: null,
        leaseUntil: null,
      });
      // The exact stored text is kept, so a compare-and-set on it still works.
      expect(read?.stored).toBe(JSON.stringify(legacy));
      expect(await replaceSetupAttempt(env, read!, attempt({ owner: 'run-2' }))).toBe(true);
    });

    it('lets only the run that still owns the attempt complete', async () => {
      const owned = await claimSetupAttempt(env, attempt());
      // Another run took the lease over after this one's lapsed.
      const takeover = attempt({ owner: 'run-2', startedBy: 'admin-2' });
      expect(await replaceSetupAttempt(env, owned, takeover)).toBe(true);

      expect(await completeAgentEmailSetup(env, record(), 'admin-1', owned)).toBe(false);
      expect(await isAgentEmailOn(env)).toBe(false);
      expect((await readSetupAttempt(env, DOMAIN))?.attempt).toEqual(takeover);

      // Control: the run that owns it now completes.
      const current = await readSetupAttempt(env, DOMAIN);
      expect(await completeAgentEmailSetup(env, record(), 'admin-2', current!)).toBe(true);
      expect(await isAgentEmailOn(env)).toBe(true);
    });

    it('refuses an unreadable attempt rather than starting over without its baseline', async () => {
      const error = vi.spyOn(log, 'error');
      writeRow(ATTEMPT_KEY, '{"domain":"agents.fixture.example"}');
      await expect(readSetupAttempt(env, DOMAIN)).rejects.toThrow('is unreadable');
      expect(error).toHaveBeenCalledWith('agent_email.setup_record_unreadable', {
        key: ATTEMPT_KEY,
      });
    });

    it('keeps attempts for different domains apart', async () => {
      await claimSetupAttempt(env, attempt());
      expect(await readSetupAttempt(env, 'agents.other.example')).toBeNull();
    });
  });
});
