/**
 * Deployment heartbeat status compare-and-set (state-machine audit D7).
 *
 * The heartbeat reads `deployment_environments.status`, decides `starting → active/error`
 * from that read, then writes. A stop that lands between the read and the write must win.
 * The guard is a SQL predicate, so it runs against a real SQLite engine (rule 28), and the
 * concurrent stop is injected at the exact midpoint: right after the heartbeat's read of
 * `deployment_environments` returns (rule 62, controlled ordering).
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { applyDeploymentHeartbeat } from '../../../src/routes/node-heartbeat-deployment';
import { createRacingD1 } from '../../helpers/racing-d1';
import { createAllSchemaTables } from '../../helpers/sqlite-d1';

const lifecycleEvents = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('../../../src/services/project-lifecycle-events', () => ({
  recordDeploymentEnvironmentLifecycleEventBestEffort: vi.fn(
    async (_env: unknown, event: Record<string, unknown>) => {
      lifecycleEvents.push(event);
    }
  ),
  recordDeploymentReleaseLifecycleEventBestEffort: vi.fn(async () => undefined),
}));

const NODE_ID = 'node-deploy-1';
const ENV_ID = 'env-1';
const NOW = '2026-11-10T12:00:00.000Z';

let sqlite: Database.Database;
let afterEnvironmentRead: (() => void) | null;

function racingD1(): D1Database {
  const race = createRacingD1(sqlite, 'deployment_environments');
  const hook = afterEnvironmentRead;
  if (hook) {
    race.afterNextRead(() => {
      afterEnvironmentRead = null;
      hook();
    });
  }
  return race.d1;
}

function seedEnvironment(status: string): void {
  sqlite
    .prepare(
      `INSERT INTO deployment_environments (id, project_id, name, status, node_id)
       VALUES (?, 'project-1', 'production', ?, ?)`
    )
    .run(ENV_ID, status, NODE_ID);
}

function environmentRow(): { status: string; observed_status: string | null } {
  return sqlite
    .prepare('SELECT status, observed_status FROM deployment_environments WHERE id = ?')
    .get(ENV_ID) as { status: string; observed_status: string | null };
}

async function heartbeat(deploymentStatus: string): Promise<Record<string, unknown>> {
  const database = racingD1();
  const db = drizzle(database, { schema });
  const response: Record<string, unknown> = {};
  const waitUntil = vi.fn((work: Promise<unknown>) => void work);
  const c = {
    env: { DATABASE: database },
    executionCtx: { waitUntil },
  } as unknown as Parameters<typeof applyDeploymentHeartbeat>[0]['c'];
  await applyDeploymentHeartbeat({
    c,
    db,
    node: { providerInstanceId: 'server-1' },
    nodeId: NODE_ID,
    deployment: {
      environments: [{ environmentId: ENV_ID, appliedSeq: 1, status: deploymentStatus }],
    },
    now: NOW,
    response,
  });
  await Promise.all(waitUntil.mock.calls.map(([work]) => work));
  return response;
}

describe('deployment heartbeat environment status compare-and-set', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    afterEnvironmentRead = null;
    lifecycleEvents.length = 0;
  });

  it('promotes starting → active when nothing changed concurrently (control)', async () => {
    seedEnvironment('starting');

    const response = await heartbeat('applied');

    expect(environmentRow()).toEqual({ status: 'active', observed_status: 'applied' });
    expect(lifecycleEvents).toEqual([
      expect.objectContaining({ lifecycle: 'active', status: 'active', fromStatus: 'starting' }),
    ]);
    // Liveness: the environment is still advertised to the node.
    expect(response.deployment).toEqual(
      expect.objectContaining({ environments: [{ environmentId: ENV_ID }] })
    );
  });

  it('does not overwrite a stop that lands between the read and the write', async () => {
    seedEnvironment('starting');
    afterEnvironmentRead = () => {
      sqlite
        .prepare(`UPDATE deployment_environments SET status = 'stopping' WHERE id = ?`)
        .run(ENV_ID);
    };

    await heartbeat('applied');

    expect(afterEnvironmentRead).toBeNull(); // the race was actually injected
    expect(environmentRow().status).toBe('stopping');
    expect(lifecycleEvents).toEqual([]);
  });

  it('does not overwrite a concurrent start failure with error→active', async () => {
    seedEnvironment('starting');
    afterEnvironmentRead = () => {
      sqlite
        .prepare(`UPDATE deployment_environments SET status = 'error' WHERE id = ?`)
        .run(ENV_ID);
    };

    await heartbeat('applied');

    expect(environmentRow().status).toBe('error');
    expect(lifecycleEvents).toEqual([]);
  });

  it('still records observations for an active environment that did not change', async () => {
    seedEnvironment('active');

    await heartbeat('applied');

    expect(environmentRow()).toEqual({ status: 'active', observed_status: 'applied' });
  });
});
