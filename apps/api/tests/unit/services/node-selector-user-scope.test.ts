/**
 * Regression pin for the userId-scoped scheduling invariant (security-critique #7, rule 28).
 *
 * `selectNodeForTaskRun` MUST only ever return a node owned by the userId it is passed (the task
 * SUBMITTER). A forked task whose credential attribution belongs to another project member must
 * never be scheduled onto — nor leak a credential onto — that member's node. Before BYO this was a
 * "wrong billing" bug; once a node is a machine the platform doesn't control, it becomes "run
 * adversarial work on someone else's hardware", so the invariant is pinned here with a faithful DB.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { selectNodeForTaskRun } from '../../../src/services/node-selector';

vi.mock('../../../src/services/node-lifecycle', () => ({ tryClaim: vi.fn() }));

let sqlite: Database.Database | null = null;

function createDb() {
  sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      vm_size TEXT NOT NULL DEFAULT 'medium',
      vm_location TEXT NOT NULL DEFAULT 'nbg1',
      cloud_provider TEXT,
      provider_instance_id TEXT,
      ip_address TEXT,
      backend_dns_record_id TEXT,
      last_heartbeat_at TEXT,
      agent_ready_at TEXT,
      health_status TEXT NOT NULL DEFAULT 'unhealthy',
      heartbeat_stale_after_seconds INTEGER NOT NULL DEFAULT 180,
      last_metrics TEXT,
      warm_since TEXT,
      credential_source TEXT DEFAULT 'user',
      credential_attribution_user_id TEXT,
      credential_attribution_project_id TEXT,
      credential_attribution_source TEXT DEFAULT 'user',
      offboarding_status TEXT,
      offboarding_blocked_reason TEXT,
      offboarding_blocked_at TEXT,
      node_role TEXT NOT NULL DEFAULT 'workspace',
      node_mode TEXT NOT NULL DEFAULT 'shared',
      runtime TEXT NOT NULL DEFAULT 'vm',
      node_class TEXT NOT NULL DEFAULT 'managed',
      transport TEXT,
      tunnel_id TEXT,
      tunnel_name TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      node_id TEXT,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running'
    );
  `);
  return drizzle(sqlite, { schema });
}

function seedHealthyNode(id: string, userId: string): void {
  sqlite
    ?.prepare(`
      INSERT INTO nodes (id, user_id, name, status, vm_size, vm_location, health_status, last_metrics, node_role, runtime, node_class)
      VALUES (?, ?, ?, 'running', 'medium', 'nbg1', 'healthy', ?, 'workspace', 'vm', 'managed')
    `)
    .run(id, userId, `node-${id}`, JSON.stringify({ cpuLoadAvg1: 0.1, memoryPercent: 10 }));
}

// No warm-pool path: taskId omitted so step 0 is skipped and NODE_LIFECYCLE is never touched.
const env = {} as never;

afterEach(() => {
  sqlite?.close();
  sqlite = null;
  vi.clearAllMocks();
});

describe('selectNodeForTaskRun userId scoping', () => {
  it('never selects a node owned by a DIFFERENT user (forked-task cross-tenant guard)', async () => {
    const db = createDb();
    // Only the attribution/other user owns a healthy node; the submitter owns none.
    seedHealthyNode('attacker-node', 'attribution-user');

    const result = await selectNodeForTaskRun(db, 'submitter-user', env);

    expect(result).toBeNull();
  });

  it('selects the submitter’s own node', async () => {
    const db = createDb();
    seedHealthyNode('own-node', 'submitter-user');

    const result = await selectNodeForTaskRun(db, 'submitter-user', env);

    expect(result?.id).toBe('own-node');
  });

  it('picks the submitter’s node and ignores another user’s node in the same pool', async () => {
    const db = createDb();
    seedHealthyNode('own-node', 'submitter-user');
    seedHealthyNode('other-node', 'attribution-user');

    const result = await selectNodeForTaskRun(db, 'submitter-user', env);

    expect(result?.id).toBe('own-node');
  });
});
