/** Tests for explicit control-plane activity writes. */
import { runMigrations } from '@simple-agent-manager/project-data/internal/do/migrations';
import { upsertActivityState } from '@simple-agent-manager/project-data/internal/do/session-state';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSqlStorage } from './sql-storage-test-utils';

describe('explicit session activity transitions', () => {
  let db: Database.Database;
  let sql: SqlStorage;

  beforeEach(() => {
    db = new Database(':memory:');
    sql = createSqlStorage(db);
    runMigrations(sql);
  });

  afterEach(() => db.close());

  it('allows an authoritative control-plane path to end a prompt explicitly', () => {
    upsertActivityState(sql, 'sess-1', { activity: 'prompting' });
    upsertActivityState(sql, 'sess-1', { activity: 'idle', source: 'control_plane' });

    const row = sql
      .exec('SELECT activity, activity_source FROM session_state WHERE session_id = ?', 'sess-1')
      .toArray()[0];
    expect(row).toMatchObject({ activity: 'idle', activity_source: 'control_plane' });
  });
});
