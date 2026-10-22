import { readFileSync } from 'node:fs';

import type Database from 'better-sqlite3';

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
