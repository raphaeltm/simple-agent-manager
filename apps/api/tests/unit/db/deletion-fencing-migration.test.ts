import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

describe('0137 deletion fencing migration', () => {
  it('adds the strict runtime-termination proof marker without inferring proof from status', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`CREATE TABLE nodes (id TEXT PRIMARY KEY, status TEXT NOT NULL)`);
      sqlite.exec(`INSERT INTO nodes (id, status) VALUES ('legacy-deleted', 'deleted')`);
      sqlite.exec(
        readFileSync(join(process.cwd(), 'src/db/migrations/0137_deletion_fencing.sql'), 'utf8')
      );

      const columns = sqlite.prepare(`PRAGMA table_info('nodes')`).all() as Array<{ name: string }>;
      const row = sqlite
        .prepare('SELECT runtime_termination_confirmed_at AS proof FROM nodes WHERE id = ?')
        .get('legacy-deleted') as { proof: string | null };
      expect(columns.map((column) => column.name)).toContain('runtime_termination_confirmed_at');
      expect(row.proof).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it('adds workspace-runtime proof fields without blessing legacy deleted labels', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`CREATE TABLE workspaces (id TEXT PRIMARY KEY, status TEXT NOT NULL)`);
      sqlite.exec(`INSERT INTO workspaces (id, status) VALUES ('legacy-deleted', 'deleted')`);
      sqlite.exec(
        readFileSync(
          join(process.cwd(), 'src/db/migrations/0139_workspace_runtime_deletion_proof.sql'),
          'utf8'
        )
      );

      const columns = sqlite.prepare(`PRAGMA table_info('workspaces')`).all() as Array<{
        name: string;
      }>;
      const row = sqlite
        .prepare(
          `SELECT runtime_deletion_confirmed_at AS confirmedAt,
                  runtime_deletion_proof AS proof
             FROM workspaces
            WHERE id = ?`
        )
        .get('legacy-deleted') as { confirmedAt: string | null; proof: string | null };
      expect(columns.map((column) => column.name)).toEqual(
        expect.arrayContaining(['runtime_deletion_confirmed_at', 'runtime_deletion_proof'])
      );
      expect(row).toEqual({ confirmedAt: null, proof: null });
    } finally {
      sqlite.close();
    }
  });

  it('assigns an opaque runtime incarnation to the currently represented legacy runtime', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`CREATE TABLE nodes (id TEXT PRIMARY KEY, status TEXT NOT NULL)`);
      sqlite.exec(`INSERT INTO nodes (id, status) VALUES ('legacy-running', 'running')`);
      sqlite.exec(
        readFileSync(
          join(process.cwd(), 'src/db/migrations/0140_node_runtime_incarnation.sql'),
          'utf8'
        )
      );

      const row = sqlite
        .prepare('SELECT runtime_incarnation_id AS incarnationId FROM nodes WHERE id = ?')
        .get('legacy-running') as { incarnationId: string | null };
      expect(row.incarnationId).toMatch(/^[a-f0-9]{32}$/);
    } finally {
      sqlite.close();
    }
  });

  it('adds provider credential fingerprint storage without trusting a mutable legacy row', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`CREATE TABLE nodes (id TEXT PRIMARY KEY, status TEXT NOT NULL)`);
      sqlite.exec(`INSERT INTO nodes (id, status) VALUES ('legacy-running', 'running')`);
      sqlite.exec(
        readFileSync(
          join(
            process.cwd(),
            'src/db/migrations/0141_node_provider_credential_fingerprint.sql'
          ),
          'utf8'
        )
      );

      const columns = sqlite.prepare(`PRAGMA table_info('nodes')`).all() as Array<{
        name: string;
      }>;
      const row = sqlite
        .prepare(
          'SELECT placement_credential_fingerprint AS fingerprint FROM nodes WHERE id = ?'
        )
        .get('legacy-running') as { fingerprint: string | null };
      expect(columns.map((column) => column.name)).toContain('placement_credential_fingerprint');
      expect(row.fingerprint).toBeNull();
    } finally {
      sqlite.close();
    }
  });
});
