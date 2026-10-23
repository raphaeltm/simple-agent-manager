import { readFileSync } from 'node:fs';

import type Database from 'better-sqlite3';

import type { Env } from '../../src/env';
import { agentEmailDomain } from '../../src/services/agent-email/address';
import { AGENT_EMAIL_SETUP_KEY } from '../../src/services/agent-email/setup-state';

/**
 * The agent email tables exactly as the shipped migrations create them (unique dedupe index
 * included), for tests that build their schema from SQL. 0204's checkpoint widening is left
 * out: it needs the full task_submission_checkpoints table.
 */
export function createAgentEmailTables(sqlite: Database.Database): void {
  const migration = (name: string) =>
    readFileSync(new URL(`../../src/db/migrations/${name}`, import.meta.url), 'utf8');
  sqlite.exec(
    migration('0204_agent_email_triggers.sql').split('-- Widen task_submission_checkpoints')[0]!
  );
  sqlite.exec(migration('0205_agent_email_durable_intake.sql'));
}

/**
 * Writes the record a successful admin setup leaves (`services/agent-email/setup.ts`), so a test
 * env with the `AGENT_EMAIL` binding behaves like a deployment an admin has turned agent email on
 * for. Without it the binding alone leaves agent email off.
 */
export async function markAgentEmailSetUp(env: Env, updatedBy = 'user-1'): Promise<void> {
  const enabledAt = new Date().toISOString();
  const record = {
    domain: agentEmailDomain(env.BASE_DOMAIN),
    enabledAt,
    mainDomainChanges: [],
    zoneChanges: [],
  };
  await env.DATABASE.prepare(
    `INSERT INTO platform_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by`
  )
    .bind(AGENT_EMAIL_SETUP_KEY, JSON.stringify(record), enabledAt, updatedBy)
    .run();
}
