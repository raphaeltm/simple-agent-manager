/**
 * Discriminating cross-tenant regression for `cleanupTaskRun`'s caller-scoped teardown guard.
 *
 * PR #1740 widened task lifecycle routes from owner-scoped to project-scoped so any member with
 * `task:write` may cancel a shared task. That made the COMPUTE teardown path a cross-tenant
 * vulnerability: `/status` -> `cleanupTerminalTaskResourcesOrThrow` -> `cleanupTaskRun` matched the
 * workspace by id alone, so cancelling another member's task tore down THAT member's workspace and
 * node. The fix threads `requiredUserId` (the caller) into the workspace lookup.
 *
 * These tests run against a REAL in-memory SQLite engine (`createSqliteD1`), so the `requiredUserId`
 * WHERE predicate is genuinely evaluated by a SQL engine. The mock-based tests they supplement
 * hardcoded an empty workspace result, so they passed even with the guard deleted — the exact
 * non-discriminating pattern flagged by the security-auditor (HIGH-1) and test-engineer (CRITICAL)
 * reviews of this PR, and banned for auth code by rules 02/28.
 *
 * Every attack case is paired with an owner-path control proving teardown DOES happen for the
 * legitimate owner — so a green attack assertion can never come from cleanup being broken outright.
 */
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  stopWorkspaceOnNode: vi.fn(),
  markIdle: vi.fn(),
  stopNodeResources: vi.fn(),
  scheduleWorkspaceDeletion: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../src/services/node-agent', () => ({
  stopWorkspaceOnNode: (...args: unknown[]) => mocks.stopWorkspaceOnNode(...args),
}));
vi.mock('../../../src/services/node-lifecycle', () => ({
  markIdle: (...args: unknown[]) => mocks.markIdle(...args),
}));
vi.mock('../../../src/services/nodes', () => ({
  stopNodeResources: (...args: unknown[]) => mocks.stopNodeResources(...args),
}));
vi.mock('../../../src/lib/logger', () => ({ log: mocks.log }));

import { cleanupTaskRun } from '../../../src/services/task-runner';

const VICTIM = 'user-victim';
const ATTACKER = 'user-attacker';
const CREATOR = 'user-creator';
const RUNNER = 'user-runner';
const PROJECT = 'project-shared';

let sqlite: Database.Database;
let env: Env;

/**
 * Seed the shared-project fixture: a task created by VICTIM, running on a workspace and node that
 * VICTIM owns. ATTACKER is a different member of the same project — the route-level `task:write`
 * capability check passes for them, which is exactly why the cleanup layer must scope by caller.
 */
async function seedVictimTaskRun(runtime: 'vm' | 'cf-container'): Promise<void> {
  const db = drizzle(env.DATABASE, { schema });
  await db.insert(schema.nodes).values({
    id: 'node-victim',
    userId: VICTIM,
    name: 'victim-node',
    status: 'running',
    runtime,
    warmSince: null,
  } as typeof schema.nodes.$inferInsert);
  await db.insert(schema.workspaces).values({
    id: 'ws-victim',
    nodeId: 'node-victim',
    projectId: PROJECT,
    userId: VICTIM,
    name: 'victim-ws',
    repository: 'org/repo',
    vmSize: 'small',
    vmLocation: 'nbg1',
    status: 'running',
  } as typeof schema.workspaces.$inferInsert);
  await db.insert(schema.tasks).values({
    id: 'task-victim',
    projectId: PROJECT,
    userId: VICTIM,
    workspaceId: 'ws-victim',
    autoProvisionedNodeId: 'node-victim',
    title: 'Victim task',
    status: 'in_progress',
  } as typeof schema.tasks.$inferInsert);
}

/**
 * Seed the divergent-owner fixture this PR newly makes reachable: CREATOR created the task, but
 * RUNNER executed it (project-scoped `/run` or `/delegate`), so the workspace and node belong to
 * RUNNER while `task.userId` still says CREATOR. Before this PR `/run` required task ownership, so
 * this state was structurally impossible.
 */
async function seedDivergentOwnerTaskRun(runtime: 'vm' | 'cf-container'): Promise<void> {
  const db = drizzle(env.DATABASE, { schema });
  await db.insert(schema.nodes).values({
    id: 'node-runner',
    userId: RUNNER,
    name: 'runner-node',
    status: 'running',
    runtime,
    warmSince: null,
  } as typeof schema.nodes.$inferInsert);
  await db.insert(schema.workspaces).values({
    id: 'ws-runner',
    nodeId: 'node-runner',
    projectId: PROJECT,
    userId: RUNNER,
    name: 'runner-ws',
    repository: 'org/repo',
    vmSize: 'small',
    vmLocation: 'nbg1',
    status: 'running',
  } as typeof schema.workspaces.$inferInsert);
  await db.insert(schema.tasks).values({
    id: 'task-divergent',
    projectId: PROJECT,
    userId: CREATOR,
    workspaceId: 'ws-runner',
    autoProvisionedNodeId: 'node-runner',
    title: 'Task created by one member, run by another',
    status: 'in_progress',
  } as typeof schema.tasks.$inferInsert);
}

async function readWorkspaceStatus(workspaceId = 'ws-victim'): Promise<string | undefined> {
  const db = drizzle(env.DATABASE, { schema });
  const [row] = await db
    .select({ status: schema.workspaces.status })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  return row?.status;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.stopWorkspaceOnNode.mockResolvedValue(undefined);
  mocks.markIdle.mockResolvedValue(undefined);
  mocks.stopNodeResources.mockResolvedValue(undefined);
  mocks.scheduleWorkspaceDeletion.mockResolvedValue(undefined);

  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.nodes, schema.workspaces, schema.tasks]);

  env = {
    DATABASE: createSqliteD1(sqlite),
    TASK_RUN_CLEANUP_DELAY_MS: '0',
    NODE_LIFECYCLE: {
      idFromName: (id: string) => id,
      get: () => ({ scheduleWorkspaceDeletion: mocks.scheduleWorkspaceDeletion }),
    },
  } as unknown as Env;
});

afterEach(() => {
  sqlite.close();
});

describe('cleanupTaskRun — cross-tenant compute teardown (real SQLite)', () => {
  it('ATTACK (vm): a project member cancelling another member task tears down nothing', async () => {
    await seedVictimTaskRun('vm');

    await cleanupTaskRun('task-victim', env, undefined, ATTACKER);

    expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();
    expect(mocks.stopNodeResources).not.toHaveBeenCalled();
    expect(mocks.markIdle).not.toHaveBeenCalled();
    expect(mocks.scheduleWorkspaceDeletion).not.toHaveBeenCalled();
    // The victim's workspace row must be untouched — not flipped to 'stopped'.
    expect(await readWorkspaceStatus()).toBe('running');
    expect(mocks.log.info).toHaveBeenCalledWith(
      'task_run.cleanup.skipped_owner_mismatch',
      expect.objectContaining({
        taskId: 'task-victim',
        workspaceId: 'ws-victim',
        requiredUserId: ATTACKER,
        action: 'skipped',
      })
    );
  });

  it('CONTROL (vm): the workspace owner still gets a full teardown', async () => {
    await seedVictimTaskRun('vm');

    await cleanupTaskRun('task-victim', env, undefined, VICTIM);

    expect(mocks.stopWorkspaceOnNode).toHaveBeenCalledWith('node-victim', 'ws-victim', env, VICTIM);
    expect(mocks.markIdle).toHaveBeenCalledWith(env, 'node-victim', VICTIM, undefined);
    expect(mocks.scheduleWorkspaceDeletion).toHaveBeenCalledWith('ws-victim', VICTIM);
    expect(await readWorkspaceStatus()).toBe('stopped');
  });

  it('ATTACK (cf-container): a project member cannot destroy another member container node', async () => {
    await seedVictimTaskRun('cf-container');

    await cleanupTaskRun('task-victim', env, undefined, ATTACKER);

    expect(mocks.stopNodeResources).not.toHaveBeenCalled();
    expect(await readWorkspaceStatus()).toBe('running');
  });

  it('CONTROL (cf-container): the owner still destroys their own container node', async () => {
    await seedVictimTaskRun('cf-container');

    await cleanupTaskRun('task-victim', env, undefined, VICTIM);

    expect(mocks.stopNodeResources).toHaveBeenCalledWith('node-victim', VICTIM, env);
  });

  it('CONTROL (internal caller): omitting requiredUserId still cleans up as the task owner', async () => {
    // The TaskRunner DO and cron sweeps call cleanupTaskRun without a caller identity. The guard is
    // opt-in, so those paths must keep working — otherwise the fix would strand real teardown work.
    await seedVictimTaskRun('vm');

    await cleanupTaskRun('task-victim', env);

    expect(mocks.stopWorkspaceOnNode).toHaveBeenCalledWith('node-victim', 'ws-victim', env, VICTIM);
    expect(await readWorkspaceStatus()).toBe('stopped');
    expect(mocks.log.info).not.toHaveBeenCalledWith(
      'task_run.cleanup.skipped_owner_mismatch',
      expect.anything()
    );
  });
});

/**
 * Regression for the divergence this PR newly makes reachable. Project-scoped `/run` and `/delegate`
 * let member B execute member A's task, so `workspace.userId` (B) and `task.userId` (A) legitimately
 * differ — impossible before this PR, when `/run` required task ownership.
 *
 * Internal callers pass no `requiredUserId`, so the fallback identity decides which node row the
 * runtime lookup finds. Falling back to `task.userId` misses the node entirely, which makes
 * `node?.runtime === 'cf-container'` read false for a node that IS a container: the code takes the
 * VM branch, marks the workspace stopped in D1, and leaves the container running and billing.
 */
describe('cleanupTaskRun — task creator differs from workspace owner (real SQLite)', () => {
  it('destroys a cf-container node when the internal caller omits requiredUserId', async () => {
    await seedDivergentOwnerTaskRun('cf-container');

    // Exactly how routes/tasks/callback.ts (the normal VM-agent completion path) calls it.
    await cleanupTaskRun('task-divergent', env);

    expect(mocks.stopNodeResources).toHaveBeenCalledWith('node-runner', RUNNER, env);
    // The cf-container branch returns early — it must NOT fall through to the VM stop path.
    expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();
    expect(await readWorkspaceStatus('ws-runner')).toBe('running');
  });

  it('uses the workspace owner for VM teardown when the internal caller omits requiredUserId', async () => {
    await seedDivergentOwnerTaskRun('vm');

    await cleanupTaskRun('task-divergent', env);

    expect(mocks.stopWorkspaceOnNode).toHaveBeenCalledWith('node-runner', 'ws-runner', env, RUNNER);
    expect(mocks.markIdle).toHaveBeenCalledWith(env, 'node-runner', RUNNER, undefined);
    expect(mocks.scheduleWorkspaceDeletion).toHaveBeenCalledWith('ws-runner', RUNNER);
    // The task creator must never be used as the compute identity.
    expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), CREATOR
    );
    expect(mocks.markIdle).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), CREATOR, expect.anything()
    );
  });

  it('still refuses teardown when a third member supplies requiredUserId (guard unaffected)', async () => {
    await seedDivergentOwnerTaskRun('cf-container');

    await cleanupTaskRun('task-divergent', env, undefined, ATTACKER);

    expect(mocks.stopNodeResources).not.toHaveBeenCalled();
    expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();
    expect(await readWorkspaceStatus('ws-runner')).toBe('running');
  });
});
