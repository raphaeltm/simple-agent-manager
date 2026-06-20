/**
 * Unit tests for `scheduled/trial-expire.ts`.
 *
 * Verifies:
 *   - Rows with status ∈ {pending, ready} AND expires_at < now are selected
 *   - Selected rows are updated to status='expired'
 *   - Expired anonymous-trial workspaces/nodes are cleaned up
 *   - When no candidates exist, no update is issued and `expired=0`
 *   - Counter DO is NOT called (slot is legitimately consumed)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

const { mockSelect, mockSelectFrom, mockUpdate, mockUpdateSet, mockUpdateWhere } =
  vi.hoisted(() => {
    const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
    const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });
    const mockUpdate = vi.fn().mockReturnValue({ set: mockUpdateSet });

    const mockSelectFrom = vi.fn();
    const mockSelect = vi.fn().mockReturnValue({ from: mockSelectFrom });

    return {
      mockSelect,
      mockSelectFrom,
      mockUpdate,
      mockUpdateSet,
      mockUpdateWhere,
    };
  });

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn().mockReturnValue({
    select: mockSelect,
    update: mockUpdate,
  }),
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
  inArray: vi.fn((_col: unknown, vals: unknown) => ({ type: 'inArray', vals })),
  lt: vi.fn((_col: unknown, val: unknown) => ({ type: 'lt', val })),
}));

vi.mock('../../../src/db/schema', () => ({
  trials: {
    id: 'id',
    status: 'status',
    expiresAt: 'expires_at',
  },
}));

const {
  deleteWorkspaceOnNodeMock,
  deleteNodeResourcesMock,
  persistErrorMock,
  stopSessionMock,
  cleanupWorkspaceActivityMock,
} = vi.hoisted(() => ({
  deleteWorkspaceOnNodeMock: vi.fn(async () => {}),
  deleteNodeResourcesMock: vi.fn(async () => {}),
  persistErrorMock: vi.fn(async () => {}),
  stopSessionMock: vi.fn(async () => {}),
  cleanupWorkspaceActivityMock: vi.fn(async () => {}),
}));

vi.mock('../../../src/services/node-agent', () => ({
  deleteWorkspaceOnNode: deleteWorkspaceOnNodeMock,
}));

vi.mock('../../../src/services/nodes', () => ({
  deleteNodeResources: deleteNodeResourcesMock,
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

const { runTrialExpireSweep } = await import(
  '../../../src/scheduled/trial-expire'
);

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

function makeEnv(options: {
  expiredProjects?: MockExpiredProject[];
  workspaces?: MockWorkspace[];
  activeWorkspaceCount?: number;
} = {}): Env {
  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn(() => ({
      all: vi.fn(async () => {
        if (sql.includes('WITH resolved_trials')) {
          return { results: options.expiredProjects ?? [] };
        }
        if (sql.includes('FROM workspaces') && sql.includes('project_id = ?')) {
          return { results: options.workspaces ?? [] };
        }
        return { results: [] };
      }),
      first: vi.fn(async () => {
        if (sql.includes('COUNT(*) as active_count')) {
          return { active_count: options.activeWorkspaceCount ?? 0 };
        }
        return null;
      }),
      run: vi.fn(async () => ({ meta: { changes: 1 } })),
    })),
  }));

  return {
    DATABASE: { prepare },
    OBSERVABILITY_DATABASE: {},
  } as unknown as Env;
}

/**
 * Drizzle chain: `.select(...).from(...).where(...).limit(...)`. The final
 * `.limit()` resolves to the row array.
 */
function buildSelectChain(rows: unknown[]) {
  return {
    where: vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue(rows),
    }),
  };
}

describe('runTrialExpireSweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('expires rows older than now with status pending/ready', async () => {
    const candidates = [{ id: 'trial_a' }, { id: 'trial_b' }, { id: 'trial_c' }];
    mockSelectFrom.mockReturnValueOnce(buildSelectChain(candidates));

    const res = await runTrialExpireSweep(makeEnv(), 1_700_000_000_000);

    expect(res).toEqual({
      expired: 3,
      projectsLinked: 0,
      workspacesDeleted: 0,
      nodesDeleted: 0,
      cleanupErrors: 0,
    });
    // update() was called once
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    // The set() call should be { status: 'expired' }
    expect(mockUpdateSet).toHaveBeenCalledWith({ status: 'expired' });
    // where() should use inArray of the captured ids
    const whereArg = mockUpdateWhere.mock.calls[0]?.[0] as {
      type: string;
      vals: unknown;
    };
    expect(whereArg.type).toBe('inArray');
    expect(whereArg.vals).toEqual(['trial_a', 'trial_b', 'trial_c']);
  });

  it('returns early with expired=0 when no candidates exist', async () => {
    mockSelectFrom.mockReturnValueOnce(buildSelectChain([]));

    const res = await runTrialExpireSweep(makeEnv(), 1_700_000_000_000);

    expect(res).toEqual({
      expired: 0,
      projectsLinked: 0,
      workspacesDeleted: 0,
      nodesDeleted: 0,
      cleanupErrors: 0,
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('does NOT call the TrialCounter DO (slot is consumed legitimately)', async () => {
    // Env has no TRIAL_COUNTER binding — this would throw if the code touched it.
    const env = makeEnv();
    mockSelectFrom.mockReturnValueOnce(buildSelectChain([{ id: 'trial_x' }]));
    await expect(runTrialExpireSweep(env, 1_700_000_000_000)).resolves.toMatchObject({
      expired: 1,
    });
  });

  it('deletes expired anonymous trial workspaces and their now-empty node', async () => {
    mockSelectFrom.mockReturnValueOnce(buildSelectChain([]));

    const env = makeEnv({
      expiredProjects: [{ trial_id: 'trial_old', project_id: 'proj_old' }],
      workspaces: [{
        id: 'ws_old',
        node_id: 'node_old',
        user_id: 'system_anonymous_trials',
        project_id: 'proj_old',
        chat_session_id: 'chat_old',
        status: 'running',
      }],
      activeWorkspaceCount: 0,
    });

    const res = await runTrialExpireSweep(env, 1_700_000_000_000);

    expect(res).toMatchObject({
      expired: 0,
      projectsLinked: 1,
      workspacesDeleted: 1,
      nodesDeleted: 1,
      cleanupErrors: 0,
    });
    expect(deleteWorkspaceOnNodeMock).toHaveBeenCalledWith(
      'node_old',
      'ws_old',
      env,
      'system_anonymous_trials'
    );
    expect(stopSessionMock).toHaveBeenCalledWith(env, 'proj_old', 'chat_old');
    expect(cleanupWorkspaceActivityMock).toHaveBeenCalledWith(env, 'proj_old', 'ws_old');
    expect(deleteNodeResourcesMock).toHaveBeenCalledWith(
      'node_old',
      'system_anonymous_trials',
      env
    );
  });

  it('keeps the node when another workspace is still active on it', async () => {
    mockSelectFrom.mockReturnValueOnce(buildSelectChain([]));

    const env = makeEnv({
      expiredProjects: [{ trial_id: 'trial_old', project_id: 'proj_old' }],
      workspaces: [{
        id: 'ws_old',
        node_id: 'node_shared',
        user_id: 'system_anonymous_trials',
        project_id: 'proj_old',
        chat_session_id: null,
        status: 'running',
      }],
      activeWorkspaceCount: 1,
    });

    const res = await runTrialExpireSweep(env, 1_700_000_000_000);

    expect(res).toMatchObject({
      workspacesDeleted: 1,
      nodesDeleted: 0,
      cleanupErrors: 0,
    });
    expect(deleteNodeResourcesMock).not.toHaveBeenCalled();
  });
});
