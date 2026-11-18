import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { expect, it } from 'vitest';

it('adds cleanup identity without inventing authority for existing snapshots or removing data', () => {
  const sqlite = new Database(':memory:');
  try {
    sqlite.exec(
      "CREATE TABLE session_snapshots(id TEXT PRIMARY KEY, manifest_json TEXT); INSERT INTO session_snapshots VALUES ('existing','retained')"
    );
    sqlite.exec(
      readFileSync(
        new URL('../../../src/db/migrations/0210_snapshot_cleanup_identity.sql', import.meta.url),
        'utf8'
      )
    );
    expect(sqlite.prepare('SELECT * FROM session_snapshots').get()).toEqual({
      id: 'existing',
      manifest_json: 'retained',
      cleanup_identity_json: null,
    });
    sqlite
      .prepare('UPDATE session_snapshots SET cleanup_identity_json = ?')
      .run(JSON.stringify({ workspaceGeneration: 'source' }));
    expect(sqlite.prepare('SELECT cleanup_identity_json FROM session_snapshots').get()).toEqual({
      cleanup_identity_json: '{"workspaceGeneration":"source"}',
    });
  } finally {
    sqlite.close();
  }
});
