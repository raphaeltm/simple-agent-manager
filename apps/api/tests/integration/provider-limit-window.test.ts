import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { credentialLimitReferenceKey } from '../../src/services/credential-limit-events/values';
import { newProviderLimitWait } from '../../src/services/provider-limit-policy';
import { rejectedProviderWindow } from '../../src/services/provider-limit-window';
import { createAllSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

const NOW = Date.parse('2026-10-12T09:00:00Z');
const REF = 'cc_credentials:shared';
describe('exact credential rejection windows and durable intent', () => {
  let sqlite: Database.Database;
  let env: Env;
  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    env = { DATABASE: createSqliteD1(sqlite) } as Env;
  });
  afterEach(() => sqlite.close());
  function observation(
    project: string,
    window: string,
    status: string,
    at = NOW,
    reset: number | null = NOW + 60_000,
    reference = REF
  ) {
    sqlite
      .prepare(
        'INSERT INTO credential_limit_windows(project_id,credential_reference,window_type,status,observed_at,updated_at,resets_at)VALUES(?,?,?,?,?,?,?)'
      )
      .run(project, reference, window, status, at, at, reset);
  }
  it('shares rejection across projects but latest healthy sample wins for the same window', async () => {
    observation('other-project', 'claude.session', 'rejected');
    expect(await rejectedProviderWindow(env, REF, NOW)).toMatchObject({ resetsAt: NOW + 60_000 });
    observation('this-project', 'claude.session', 'allowed', NOW + 1);
    expect(await rejectedProviderWindow(env, REF, NOW + 1)).toBeNull();
  });
  it('a healthy session window cannot clear an independent weekly rejection', async () => {
    observation('other-project', 'claude.weekly', 'rejected', NOW, NOW + 7 * 24 * 60 * 60_000);
    observation('this-project', 'claude.session', 'allowed', NOW + 1);
    expect(await rejectedProviderWindow(env, REF, NOW + 1)).toMatchObject({
      resetsAt: NOW + 7 * 24 * 60 * 60_000,
    });
  });
  it('a future healthy observation cannot supersede a current rejection', async () => {
    observation('current', 'claude.session', 'rejected');
    observation('future', 'claude.session', 'allowed', NOW + 60_000);
    expect(await rejectedProviderWindow(env, REF, NOW)).toMatchObject({ resetsAt: NOW + 60_000 });
  });
  it.each(['unrelated', 'expired', 'future', 'stale-unknown'] as const)(
    'ignores %s evidence',
    async (shape) => {
      observation(
        'project',
        'window',
        'rejected',
        shape === 'future' ? NOW + 1 : shape === 'stale-unknown' ? NOW - 120_001 : NOW,
        shape === 'expired' ? NOW : shape === 'stale-unknown' ? null : NOW + 60_000,
        shape === 'unrelated' ? 'cc_credentials:other' : REF
      );
      expect(await rejectedProviderWindow(env, REF, NOW)).toBeNull();
    }
  );
  it('long references use the same collision-resistant key as the producer', async () => {
    const long = REF + 'x'.repeat(1000);
    const key = await credentialLimitReferenceKey(long);
    observation('project', 'window', 'rejected', NOW, NOW + 60_000, key!);
    expect(await rejectedProviderWindow(env, long, NOW)).toMatchObject({ credentialKey: key });
    expect(await rejectedProviderWindow(env, long + 'different', NOW)).toBeNull();
  });
  it('a persisted wait closes the marker-write gap until a newer successful observation', async () => {
    const wait = newProviderLimitWait({
      taskId: 'task',
      origin: 'callback',
      incidentId: 'workspace:agent:1',
      credentialKey: REF,
      previous: null,
      now: NOW,
      resetsAt: NOW + 60_000,
    });
    sqlite
      .prepare(
        "INSERT INTO tasks(id,user_id,project_id,status,admission_state,provider_limit_wait_json)VALUES('task','user','project','in_progress','provider_limit_waiting',?)"
      )
      .run(JSON.stringify(wait));
    expect(await rejectedProviderWindow(env, REF, NOW)).toMatchObject({ resetsAt: wait.resetsAt });
    observation('project', 'provider.prompt_rejection', 'allowed', NOW + 1);
    expect(await rejectedProviderWindow(env, REF, NOW + 1)).toBeNull();
  });
  it('expired blocked intents cannot crowd a current markerless rejection out of admission', async () => {
    const insert = sqlite.prepare(
      "INSERT INTO tasks(id,user_id,project_id,status,admission_state,provider_limit_wait_json)VALUES(?,'user','project','in_progress','provider_limit_blocked',?)"
    );
    for (let i = 0; i <= 100; i++) {
      const wait = newProviderLimitWait({
        taskId: `old-${i}`,
        origin: 'callback',
        incidentId: `old-${i}`,
        credentialKey: REF,
        previous: null,
        now: NOW - 60_000,
        resetsAt: NOW - 1,
      });
      insert.run(`old-${i}`, JSON.stringify({ ...wait, phase: 'blocked' }));
    }
    const current = newProviderLimitWait({
      taskId: 'current',
      origin: 'callback',
      incidentId: 'current',
      credentialKey: REF,
      previous: null,
      now: NOW,
      resetsAt: NOW + 60_000,
    });
    insert.run('current', JSON.stringify(current));
    expect(await rejectedProviderWindow(env, REF, NOW)).toMatchObject({
      resetsAt: NOW + 60_000,
      observedAt: NOW,
    });
  });
});
