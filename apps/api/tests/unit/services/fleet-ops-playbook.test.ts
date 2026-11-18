/**
 * The playbook reaches `get_instructions` only in the Operations project while the debugger
 * tools are not off. Settings are read through the real resolvers over real SQL.
 */
import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import {
  OPERATIONS_PLAYBOOK,
  resolveOperationsPlaybook,
} from '../../../src/services/fleet-ops/playbook';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

function envWithMode(mode: string | null): Env {
  const sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.platformSettings, schema.platformCredentials]);
  sqlite.exec(
    readFileSync(
      new URL('../../../src/db/migrations/0196_admin_settings.sql', import.meta.url),
      'utf8'
    )
  );
  if (mode) {
    sqlite
      .prepare('INSERT INTO platform_settings (key, value, updated_at) VALUES (?, ?, ?)')
      .run('operations.debuggerTools', mode, '2026-11-03T00:00:00Z');
  }
  return {
    DATABASE: createSqliteD1(sqlite),
    PLATFORM_FEEDBACK_PROJECT_ID: 'proj-ops',
  } as unknown as Env;
}

describe('resolveOperationsPlaybook', () => {
  it('returns the playbook in the Operations project when the tools are on', async () => {
    expect(await resolveOperationsPlaybook(envWithMode('read'), 'proj-ops')).toBe(
      OPERATIONS_PLAYBOOK
    );
  });

  it('returns nothing in any other project', async () => {
    expect(await resolveOperationsPlaybook(envWithMode('read'), 'proj-app')).toBeNull();
  });

  it('returns nothing when the tools are off, including the default', async () => {
    expect(await resolveOperationsPlaybook(envWithMode('off'), 'proj-ops')).toBeNull();
    expect(await resolveOperationsPlaybook(envWithMode(null), 'proj-ops')).toBeNull();
  });

  it('covers the order of work and the no-raw-logs rule', () => {
    const text = OPERATIONS_PLAYBOOK.join('\n');
    expect(text).toContain('ops_find_anomalies');
    expect(text.indexOf('ops_find_anomalies')).toBeLessThan(text.indexOf('ops_timeline'));
    expect(text).toContain('Preserve the exact symptom');
    expect(text).toContain('Never paste raw log lines');
    expect(text).toContain('scrub script');
  });
});
