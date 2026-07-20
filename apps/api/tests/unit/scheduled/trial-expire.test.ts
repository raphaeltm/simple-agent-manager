/**
 * Unit tests for `scheduled/trial-expire.ts`.
 *
 * Verifies:
 *   - Expiration uses a guarded D1 update and counts affected rows
 *   - Expired trial-owned resources are reaped even after project claim
 *   - Whole-node cleanup marks D1 rows deleted only after strict cloud deletion
 *   - Shared-node workspace cleanup keeps rows visible when VM-agent deletion fails
 *   - D1 agent_sessions are closed for deleted trial workspaces
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

const {
  deleteWorkspaceOnNodeMock,
  deleteNodeResourcesStrictMock,
  persistErrorMock,
  stopSessionMock,
  cleanupWorkspaceActivityMock,
} = vi.hoisted(() => ({
  deleteWorkspaceOnNodeMock: vi.fn(async () => {}),
  deleteNodeResourcesStrictMock: vi.fn(async () => {}),
  persistErrorMock: vi.fn(async () => {}),
  stopSessionMock: vi.fn(async () => {}),
  cleanupWorkspaceActivityMock: vi.fn(async () => {}),
}));

vi.mock('../../../src/services/node-agent', () => ({
  deleteWorkspaceOnNode: deleteWorkspaceOnNodeMock,
}));

vi.mock('../../../src/services/nodes', () => ({
  deleteNodeResourcesStrict: deleteNodeResourcesStrictMock,
}));

vi.mock('../../../src/services/observability', () => ({
  persistError: persistErrorMock,
}));

vi.mock('../../../src/services/project-data', () => ({
  stopSession: stopSessionMock,
  cleanupWorkspaceActivity: cleanupWorkspaceActivityMock,
}));

vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: vi.fn((err: unknown) => ({
    error: err instanceof Error ? err.message : String(err),
  })),
}));

const { runTrialExpireSweep } = await import('../../../src/scheduled/trial-expire');

interface MockExpiredProject {
  trial_id: string;
  project_id: string;
}

interface MockWorkspace {
  id: string;
  node_id: string | null;
  user_id: string;
  project_id: string | null;
  chat_session_id: string | null;
  status: string;
}

interface PreparedCall {
  sql: string;
  binds: unknown[];
}

interface MockEnv extends Env {
  __calls: PreparedCall[];
}

function makeEnv(
  options: {
    expireChanges?: number;
    expiredProjects?: MockExpiredProject[];
    workspaces?: MockWorkspace[];
    workspacesByInvocation?: MockWorkspace[][];
    existingClaim?: { status: string; updated_at: string };
    activeOtherCount?: number;
    activeAfterCount?: number;
    linkChanges?: number;
    workspaceDeleteChanges?: number;
    nodeClaimChanges?: number;
    nodeDeleteChanges?: number;
    envOverrides?: Partial<Env>;
  } = {}
): MockEnv {
  const calls: PreparedCall[] = [];
  let workspaceQueryCount = 0;
  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn((...binds: unknown[]) => {
      calls.push({ sql, binds });
      return {
        all: vi.fn(async () => {
          if (sql.includes('WITH resolved_trials')) {
            return { results: options.expiredProjects ?? [] };
          }
          if (sql.includes('FROM workspaces') && sql.includes('project_id = ?')) {
            return {
              results:
                options.workspacesByInvocation?.[workspaceQueryCount++] ?? options.workspaces ?? [],
            };
          }
          return { results: [] };
        }),
        first: vi.fn(async () => {
          if (sql.includes('SELECT status, updated_at')) {
            return options.existingClaim ?? null;
          }
          if (sql.includes('COUNT(*) as active_count') && sql.includes('id NOT IN')) {
            return { active_count: options.activeOtherCount ?? 0 };
          }
          if (sql.includes('COUNT(*) as active_count')) {
            return { active_count: options.activeAfterCount ?? 0 };
          }
          return null;
        }),
        run: vi.fn(async () => {
          if (sql.includes("SET status = 'expired'")) {
            return { meta: { changes: options.expireChanges ?? 0 } };
          }
          if (sql.includes('SET project_id = ?')) {
            return { meta: { changes: options.linkChanges ?? 1 } };
          }
          if (sql.includes("SET status = 'destroying'")) {
            return { meta: { changes: options.nodeClaimChanges ?? 1 } };
          }
          if (sql.includes('UPDATE workspaces') && sql.includes("status = 'deleted'")) {
            return { meta: { changes: options.workspaceDeleteChanges ?? 1 } };
          }
          if (sql.includes('UPDATE nodes') && sql.includes("status = 'deleted'")) {
            return { meta: { changes: options.nodeDeleteChanges ?? 1 } };
          }
          return { meta: { changes: 1 } };
        }),
      };
    }),
  }));

  return {
    DATABASE: { prepare },
    OBSERVABILITY_DATABASE: {},
    __calls: calls,
    ...options.envOverrides,
  } as unknown as MockEnv;
}

function baseWorkspace(overrides: Partial<MockWorkspace> = {}): MockWorkspace {
  return {
    id: 'ws_old',
    node_id: 'node_old',
    user_id: 'system_anonymous_trials',
    project_id: 'proj_old',
    chat_session_id: 'chat_old',
    status: 'running',
    ...overrides,
  };
}

describe('runTrialExpireSweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('expires rows using a guarded D1 update and returns actual affected rows', async () => {
    const env = makeEnv({
      expireChanges: 2,
      envOverrides: { TRIAL_EXPIRE_BATCH_SIZE: '999999' } as Partial<Env>,
    });

    const res = await runTrialExpireSweep(env, 1_700_000_000_000);

    expect(res).toEqual({
      expired: 2,
      projectsLinked: 0,
      workspacesDeleted: 0,
      nodesDeleted: 0,
      cleanupErrors: 0,
    });
    const expireCall = env.__calls.find((call) => call.sql.includes("SET status = 'expired'"));
    expect(expireCall?.sql).toContain("status IN ('pending', 'ready')");
    expect(expireCall?.sql).toContain('claimed_by_user_id IS NULL');
    expect(expireCall?.sql).toContain('expires_at < ?');
    expect(expireCall?.sql).toContain('LIMIT ?');
    expect(expireCall?.binds).toEqual([1_700_000_000_000, 5000]);
  });

  it('selects expired claimed trials and guards legacy fallback projects by creator', async () => {
    const env = makeEnv({
      envOverrides: { TRIAL_CLEANUP_BATCH_SIZE: '999999' } as Partial<Env>,
    });

    await runTrialExpireSweep(env, 1_700_000_000_000);

    const cleanupSelect = env.__calls.find((call) => call.sql.includes('WITH resolved_trials'));
    expect(cleanupSelect?.sql).toContain("t.status IN ('expired', 'claimed')");
    expect(cleanupSelect?.sql).not.toContain('p.user_id = ?');
    expect(cleanupSelect?.sql).toContain('p.created_by = ?');
    expect(cleanupSelect?.sql).toContain('w.user_id = ?');
    expect(cleanupSelect?.binds).toEqual([
      'system_anonymous_trials',
      1_700_000_000_000,
      'system_anonymous_trials',
      100,
    ]);
  });

  it('deletes expired trial workspaces and their now-empty node after strict cloud deletion', async () => {
    const env = makeEnv({
      expiredProjects: [{ trial_id: 'trial_old', project_id: 'proj_old' }],
      workspaces: [baseWorkspace()],
      activeOtherCount: 0,
      activeAfterCount: 0,
    });

    const res = await runTrialExpireSweep(env, 1_700_000_000_000);

    expect(res).toMatchObject({
      expired: 0,
      projectsLinked: 1,
      workspacesDeleted: 1,
      nodesDeleted: 1,
      cleanupErrors: 0,
    });
    expect(deleteWorkspaceOnNodeMock).not.toHaveBeenCalled();
    expect(deleteNodeResourcesStrictMock).toHaveBeenCalledWith(
      'node_old',
      'system_anonymous_trials',
      env
    );
    const nodeClaim = env.__calls.find((call) => call.sql.includes("SET status = 'destroying'"));
    expect(nodeClaim?.sql).toContain("status NOT IN ('deleted', 'destroyed', 'destroying')");
    expect(nodeClaim?.sql).not.toContain("'error'");
    expect(stopSessionMock).toHaveBeenCalledWith(env, 'proj_old', 'chat_old');
    expect(cleanupWorkspaceActivityMock).toHaveBeenCalledWith(env, 'proj_old', 'ws_old');
    const agentSessionUpdate = env.__calls.find((call) =>
      call.sql.includes('UPDATE agent_sessions')
    );
    expect(agentSessionUpdate?.sql).toContain("status = 'completed'");
    const computeUsageUpdate = env.__calls.find((call) =>
      call.sql.includes('UPDATE compute_usage')
    );
    expect(computeUsageUpdate?.sql).toContain('ended_at IS NULL');
  });

  it('finalizes local resources once when strict deletion reports a conclusively absent VM', async () => {
    deleteNodeResourcesStrictMock.mockResolvedValueOnce({ providerVm: 'already-absent' });
    const env = makeEnv({
      expiredProjects: [{ trial_id: 'trial_old', project_id: 'proj_old' }],
      workspacesByInvocation: [[baseWorkspace()], []],
      activeOtherCount: 0,
      activeAfterCount: 0,
    });

    const first = await runTrialExpireSweep(env, 1_700_000_000_000);
    const second = await runTrialExpireSweep(env, 1_700_000_000_000);

    expect(first).toMatchObject({ workspacesDeleted: 1, nodesDeleted: 1, cleanupErrors: 0 });
    expect(second).toMatchObject({ workspacesDeleted: 0, nodesDeleted: 0, cleanupErrors: 0 });
    expect(deleteNodeResourcesStrictMock).toHaveBeenCalledTimes(1);
    expect(stopSessionMock).toHaveBeenCalledTimes(1);
    expect(cleanupWorkspaceActivityMock).toHaveBeenCalledTimes(1);
    expect(persistErrorMock).not.toHaveBeenCalled();
  });

  it('treats a fresh concurrent node deletion claim as in progress without an error', async () => {
    const env = makeEnv({
      expiredProjects: [{ trial_id: 'trial_old', project_id: 'proj_old' }],
      workspaces: [baseWorkspace()],
      activeOtherCount: 0,
      nodeClaimChanges: 0,
      existingClaim: {
        status: 'destroying',
        updated_at: new Date(1_700_000_000_000).toISOString(),
      },
    });

    const result = await runTrialExpireSweep(env, 1_700_000_000_000);

    expect(result).toMatchObject({ workspacesDeleted: 0, nodesDeleted: 0, cleanupErrors: 0 });
    expect(deleteNodeResourcesStrictMock).not.toHaveBeenCalled();
    expect(persistErrorMock).not.toHaveBeenCalled();
    expect(env.__calls.some((call) => call.sql.includes('SELECT status, updated_at'))).toBe(true);
  });

  it.each(['deleted', 'destroyed'])(
    'treats a node made %s by the claim owner as terminal without a false error',
    async (status) => {
      const env = makeEnv({
        expiredProjects: [{ trial_id: 'trial_old', project_id: 'proj_old' }],
        workspaces: [baseWorkspace()],
        activeOtherCount: 0,
        nodeClaimChanges: 0,
        existingClaim: {
          status,
          updated_at: new Date(1_700_000_000_000).toISOString(),
        },
      });

      const result = await runTrialExpireSweep(env, 1_700_000_000_000);

      expect(result).toMatchObject({ workspacesDeleted: 0, nodesDeleted: 0, cleanupErrors: 0 });
      expect(deleteNodeResourcesStrictMock).not.toHaveBeenCalled();
      expect(persistErrorMock).not.toHaveBeenCalled();
    }
  );

  it('does not mark workspaces or nodes deleted when strict cloud deletion fails', async () => {
    deleteNodeResourcesStrictMock.mockRejectedValueOnce(new Error('Hetzner API outage'));
    const env = makeEnv({
      expiredProjects: [{ trial_id: 'trial_old', project_id: 'proj_old' }],
      workspaces: [baseWorkspace()],
      activeOtherCount: 0,
      activeAfterCount: 0,
    });

    const res = await runTrialExpireSweep(env, 1_700_000_000_000);

    expect(res).toMatchObject({
      workspacesDeleted: 0,
      nodesDeleted: 0,
      cleanupErrors: 1,
    });
    expect(env.__calls.some((call) => call.sql.includes('UPDATE workspaces'))).toBe(false);
    expect(env.__calls.some((call) => call.sql.includes("SET status = 'error'"))).toBe(true);
    expect(env.__calls.some((call) => call.sql.includes("SET status = 'running'"))).toBe(false);
    expect(persistErrorMock).toHaveBeenCalledTimes(1);
  });

  it('keeps shared-node workspace visible when VM-agent workspace deletion fails', async () => {
    deleteWorkspaceOnNodeMock.mockRejectedValueOnce(new Error('workspace still busy'));
    const env = makeEnv({
      expiredProjects: [{ trial_id: 'trial_old', project_id: 'proj_old' }],
      workspaces: [baseWorkspace({ node_id: 'node_shared' })],
      activeOtherCount: 1,
    });

    const res = await runTrialExpireSweep(env, 1_700_000_000_000);

    expect(res).toMatchObject({
      workspacesDeleted: 0,
      nodesDeleted: 0,
      cleanupErrors: 1,
    });
    expect(deleteWorkspaceOnNodeMock).toHaveBeenCalledWith(
      'node_shared',
      'ws_old',
      env,
      'system_anonymous_trials'
    );
    expect(deleteNodeResourcesStrictMock).not.toHaveBeenCalled();
    expect(env.__calls.some((call) => call.sql.includes('UPDATE workspaces'))).toBe(false);
  });

  it('deletes only the trial workspace on a shared node after VM-agent success', async () => {
    const env = makeEnv({
      expiredProjects: [{ trial_id: 'trial_old', project_id: 'proj_old' }],
      workspaces: [baseWorkspace({ node_id: 'node_shared' })],
      activeOtherCount: 1,
    });

    const res = await runTrialExpireSweep(env, 1_700_000_000_000);

    expect(res).toMatchObject({
      workspacesDeleted: 1,
      nodesDeleted: 0,
      cleanupErrors: 0,
    });
    expect(deleteWorkspaceOnNodeMock).toHaveBeenCalledTimes(1);
    expect(deleteNodeResourcesStrictMock).not.toHaveBeenCalled();
    const activeCountCall = env.__calls.find((call) =>
      call.sql.includes('COUNT(*) as active_count')
    );
    expect(activeCountCall?.sql).not.toContain('user_id = ?');
    expect(activeCountCall?.sql).toContain('id NOT IN');
  });

  it('swallows observability persistence failures after cleanup errors', async () => {
    deleteNodeResourcesStrictMock.mockRejectedValueOnce(new Error('delete failed'));
    persistErrorMock.mockRejectedValueOnce(new Error('observability down'));
    const env = makeEnv({
      expiredProjects: [{ trial_id: 'trial_old', project_id: 'proj_old' }],
      workspaces: [baseWorkspace()],
      activeOtherCount: 0,
      activeAfterCount: 0,
    });

    const res = await runTrialExpireSweep(env, 1_700_000_000_000);

    expect(res.cleanupErrors).toBe(1);
    expect(persistErrorMock).toHaveBeenCalledTimes(1);
  });
});
