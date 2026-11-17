import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { appendReverseTunnelMigrations } from '../../../../../scripts/selfhost/reverse-tunnel-migrations';
import { REVERSE_TUNNEL_MIGRATIONS } from '../../../src/selfhost/reverse-tunnel-migrations';
import { API_SRC, collectImportGraph, REPO_ROOT, selfhostOnlyFindings } from '../../helpers/selfhost-only-modules';

describe('self-host-only placement', () => {
  it('keeps reverse implementation out of the real Worker import graph', () => {
    const graph = collectImportGraph(resolve(API_SRC, 'index.ts'));
    expect(graph.files.length).toBeGreaterThan(100);
    expect(graph.files).toContain('apps/api/src/services/node-provisioning-ingress.ts');
    expect(selfhostOnlyFindings(graph)).toEqual([]);
    expect(selfhostOnlyFindings(collectImportGraph(resolve(API_SRC, 'selfhost/reverse-tunnel/transport.ts'))).length).toBeGreaterThan(0);
  });
  it('projects own migration into the same database, preserves shared links and refuses collisions', () => {
    const scratchRoot = join(REPO_ROOT, '.tmp'); mkdirSync(scratchRoot, { recursive: true });
    const scratch = mkdtempSync(join(scratchRoot, 'l17a-migration-'));
    try {
      const shared = join(scratch, '0001_shared.sql'); writeFileSync(shared, 'CREATE TABLE shared_test (id TEXT);');
      const target = join(scratch, 'flat'); mkdirSync(target);
      symlinkSync(shared, join(target, '0001_shared.sql'));
      appendReverseTunnelMigrations(resolve(API_SRC, '..'), target);
      appendReverseTunnelMigrations(resolve(API_SRC, '..'), target);
      const db = new Database(':memory:');
      for (const file of readdirSync(target).sort()) db.exec(readFileSync(join(target, file), 'utf8'));
      db.prepare("INSERT INTO node_reverse_tunnel_leases(id,node_id,user_id,runtime_incarnation_id,port,credential_hash,created_at,updated_at) VALUES('lease','node','user','inc',20000,'hash','now','now')").run();
      // Additive renamed migration upgrades a box with old0232 table without losing its leases.
      for (const file of REVERSE_TUNNEL_MIGRATIONS) db.exec(readFileSync(join(API_SRC, file), 'utf8'));
      expect(db.prepare('SELECT COUNT(*) AS n FROM node_reverse_tunnel_leases').get()).toEqual({ n: 1 });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='shared_test'").get()).toBeTruthy();
      db.close();
      const collisionDir = join(scratch, 'collision'); mkdirSync(collisionDir);
      writeFileSync(join(collisionDir, '0255_node_reverse_tunnel_leases.sql'), 'shared migration');
      expect(() => appendReverseTunnelMigrations(resolve(API_SRC, '..'), collisionDir)).toThrow('collision');
      expect(readdirSync(join(API_SRC, 'db/migrations'))).not.toContain('0255_node_reverse_tunnel_leases.sql');
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
});
