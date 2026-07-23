import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

/**
 * Migration 0097_byo_nodes.sql must be purely additive: it adds node_class/transport/tunnel_id/
 * tunnel_name and an index, and every pre-existing node row must silently become 'managed' so its
 * lifecycle, billing, and quota behavior is unchanged. See .claude/rules/31-migration-safety.md.
 */
describe('0097_byo_nodes migration', () => {
  const readMigration = (filename: string) =>
    readFileSync(join(process.cwd(), 'src/db/migrations', filename), 'utf8');

  function seedNodesTable(db: DatabaseSync) {
    // Minimal subset of the real nodes table sufficient to exercise the ALTERs.
    db.exec(`
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        runtime TEXT NOT NULL DEFAULT 'vm',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO nodes (id, user_id, name, status, runtime)
      VALUES
        ('node-managed-1', 'user-1', 'existing cloud node', 'running', 'vm'),
        ('node-managed-2', 'user-2', 'existing cf node', 'running', 'cf-container');
    `);
  }

  it('adds the four columns and defaults every existing row to managed / null transport', () => {
    const db = new DatabaseSync(':memory:');
    seedNodesTable(db);

    db.exec(readMigration('0097_byo_nodes.sql'));

    const rows = db
      .prepare(`SELECT id, node_class, transport, tunnel_id, tunnel_name FROM nodes ORDER BY id`)
      .all();

    expect(rows).toEqual([
      {
        id: 'node-managed-1',
        node_class: 'managed',
        transport: null,
        tunnel_id: null,
        tunnel_name: null,
      },
      {
        id: 'node-managed-2',
        node_class: 'managed',
        transport: null,
        tunnel_id: null,
        tunnel_name: null,
      },
    ]);
  });

  it('enforces NOT NULL on node_class (new inserts must specify or default it)', () => {
    const db = new DatabaseSync(':memory:');
    seedNodesTable(db);
    db.exec(readMigration('0097_byo_nodes.sql'));

    // Default applies when node_class is omitted.
    db.exec(`INSERT INTO nodes (id, user_id, name) VALUES ('node-3', 'user-3', 'new managed')`);
    const managed = db.prepare(`SELECT node_class FROM nodes WHERE id = 'node-3'`).get() as {
      node_class: string;
    };
    expect(managed.node_class).toBe('managed');

    // A user-owned row round-trips its class + tunnel metadata.
    db.exec(
      `INSERT INTO nodes (id, user_id, name, node_class, transport, tunnel_id, tunnel_name)
       VALUES ('node-byo', 'user-3', 'home server', 'user-owned', 'cloudflare-tunnel', 'tunnel-uuid', 'byo-tunnel')`
    );
    const byo = db
      .prepare(
        `SELECT node_class, transport, tunnel_id, tunnel_name FROM nodes WHERE id = 'node-byo'`
      )
      .get();
    expect(byo).toEqual({
      node_class: 'user-owned',
      transport: 'cloudflare-tunnel',
      tunnel_id: 'tunnel-uuid',
      tunnel_name: 'byo-tunnel',
    });
  });

  it('creates the node_class index used by cleanup/scheduling queries', () => {
    const db = new DatabaseSync(':memory:');
    seedNodesTable(db);
    db.exec(readMigration('0097_byo_nodes.sql'));

    const idx = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_nodes_node_class'`
      )
      .get() as { name: string } | undefined;
    expect(idx?.name).toBe('idx_nodes_node_class');
  });

  it('is additive: it contains no DROP TABLE / DELETE / destructive statements', () => {
    const sql = readMigration('0097_byo_nodes.sql').toUpperCase();
    expect(sql).not.toContain('DROP TABLE');
    expect(sql).not.toContain('DELETE FROM');
    expect(sql).not.toContain('PRAGMA FOREIGN_KEYS=OFF');
    // Only ADD COLUMN alterations and a CREATE INDEX.
    expect(sql).toContain('ADD COLUMN NODE_CLASS');
  });
});
