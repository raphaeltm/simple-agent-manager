/**
 * An empty running node whose only cleanup blocker is unproven workspace artifacts must
 * reach the warm pool. Before the fix the idle-orphan sweep refused it, installed a
 * backoff, and the empty-node warm handoff (later in the same tick) skipped nodes in
 * backoff, so the node stayed `running` and the stopped-node deadline never started
 * (production node 01M6MCE1, 2026-11-05: empty for five hours after three evictions).
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { sweepEmptyNodeWarmHandoff } from '../../../src/scheduled/node-cleanup/empty-node-warm-handoff';
import { sweepIdleOrphanNodes } from '../../../src/scheduled/node-cleanup/node-phases';
import { emptyResult, resolveCleanupConfig } from '../../../src/scheduled/node-cleanup/shared';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const boundary = vi.hoisted(() => ({ markIdle: vi.fn(), remove: vi.fn() }));
vi.mock('../../../src/services/observability', () => ({ persistError: vi.fn() }));
vi.mock('../../../src/services/nodes', () => ({ deleteNodeResourcesStrict: boundary.remove }));

describe('artifact-blocked empty node reaches the warm pool', () => {
  let sqlite: Database.Database;
  let env: Env;
  const now = new Date('2026-11-05T06:00:00.000Z');
  const old = '2026-11-05T01:10:00.000Z';

  beforeEach(() => {
    vi.resetAllMocks();
    boundary.markIdle.mockImplementation(async (nodeId: string) => {
      sqlite.prepare('UPDATE nodes SET warm_since = ? WHERE id = ?').run(now.toISOString(), nodeId);
      return { status: 'warm', warmSince: now.toISOString() };
    });
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    env = {
      DATABASE: createSqliteD1(sqlite),
      NODE_LIFECYCLE: {
        idFromName: (name: string) => name,
        get: () => ({ markIdle: boundary.markIdle }),
      },
    } as unknown as Env;
    sqlite.exec(`
      INSERT INTO nodes (id, user_id, status, health_status, node_role, node_class, runtime,
          provider_instance_id, runtime_incarnation_id, cloud_provider, placement_credential_source,
          placement_credential_reference, created_at, updated_at)
        VALUES ('node', 'owner', 'running', 'healthy', 'workspace', 'managed', 'vm', 'server',
          'incarnation', 'hetzner', 'platform', 'platform_credentials:credential', '${old}', '${now.toISOString()}');
      INSERT INTO tasks (id, status, auto_provisioned_node_id) VALUES ('task', 'completed', 'node');
      -- The evicted source: no deletion proof, so the node cannot be destroyed yet.
      INSERT INTO workspaces (id, node_id, user_id, project_id, status, eviction_generation, updated_at, created_at)
        VALUES ('evicted', 'node', 'owner', 'project', 'evicted', 'generation', '${old}', '${old}');
    `);
  });
  afterEach(() => sqlite.close());

  async function tick() {
    const db = drizzle(env.DATABASE, { schema });
    const config = resolveCleanupConfig(env);
    const result = emptyResult();
    // The cron's phase order: idle orphans before the empty-node handoff.
    await sweepIdleOrphanNodes(db, env, now, config, result);
    await sweepEmptyNodeWarmHandoff(db, env, now, config, result);
    return result;
  }
  const node = () =>
    sqlite
      .prepare(
        'SELECT status, warm_since AS warmSince, cleanup_backoff_until AS backoff FROM nodes'
      )
      .get() as { status: string; warmSince: string | null; backoff: string | null };

  it('hands the refused empty node to the warm pool in the same tick', async () => {
    const result = await tick();

    expect(result.orphanedNodesSkipped).toBe(1);
    expect(boundary.remove).not.toHaveBeenCalled();
    expect(boundary.markIdle).toHaveBeenCalledOnce();
    expect(boundary.markIdle).toHaveBeenCalledWith('node', 'owner', expect.any(Number));
    expect(node().warmSince).not.toBeNull();
    // A second tick does not restart the warm timer.
    await tick();
    expect(boundary.markIdle).toHaveBeenCalledOnce();
  });

  it('leaves an occupied node alone (control)', async () => {
    sqlite.exec(`INSERT INTO workspaces (id, node_id, user_id, status, updated_at, created_at)
      VALUES ('live', 'node', 'owner', 'running', '${old}', '${old}')`);
    await tick();
    expect(boundary.markIdle).not.toHaveBeenCalled();
    expect(node().warmSince).toBeNull();
  });

  it('does not hand off a node refused for a reason other than artifact proof (control)', async () => {
    // Missing teardown provenance is a refusal reason that must keep its backoff.
    sqlite.exec('UPDATE nodes SET placement_credential_source = NULL');
    await tick();
    expect(boundary.markIdle).not.toHaveBeenCalled();
    expect(node()).toMatchObject({ status: 'running', warmSince: null });
    expect(node().backoff).not.toBeNull();
  });

  it('still claims and destroys a node whose workspace has deletion proof (liveness control)', async () => {
    sqlite.exec(
      "UPDATE workspaces SET status = 'deleted', runtime_deletion_confirmed_at = '2026-11-05T02:00:00Z', runtime_deletion_proof = 'vm_agent_confirmed'"
    );
    await tick();
    expect(boundary.remove).toHaveBeenCalledOnce();
    expect(boundary.markIdle).not.toHaveBeenCalled();
  });
});
