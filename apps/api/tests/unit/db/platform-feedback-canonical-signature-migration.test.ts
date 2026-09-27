import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  join(process.cwd(), 'src/db/migrations/0173_platform_feedback_canonical_signature.sql'),
  'utf8'
);

describe('platform feedback canonical signature migration', () => {
  it('adds a nullable unique alias without rewriting existing signatures', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE platform_feedback_triages (
        signature TEXT PRIMARY KEY,
        source TEXT NOT NULL
      );
      INSERT INTO platform_feedback_triages (signature, source) VALUES ('legacy-a', 'api');
    `);

    db.exec(migration);
    expect(
      db
        .prepare(
          'SELECT signature, canonical_signature FROM platform_feedback_triages WHERE signature = ?'
        )
        .get('legacy-a')
    ).toEqual({ signature: 'legacy-a', canonical_signature: null });

    db.prepare(
      'UPDATE platform_feedback_triages SET canonical_signature = ? WHERE signature = ?'
    ).run('canonical-a', 'legacy-a');
    db.prepare('INSERT INTO platform_feedback_triages (signature, source) VALUES (?, ?)').run(
      'legacy-b',
      'api'
    );
    expect(() =>
      db
        .prepare('UPDATE platform_feedback_triages SET canonical_signature = ? WHERE signature = ?')
        .run('canonical-a', 'legacy-b')
    ).toThrow();
  });
});
