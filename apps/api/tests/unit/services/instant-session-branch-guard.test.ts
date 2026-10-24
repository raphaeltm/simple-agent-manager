/**
 * Regression tests for the production incident where every MCP-dispatched
 * Instant (cf-container) task died with:
 *
 *   Node Agent request failed: 500 {"error":"standalone git clone failed: exit
 *   status 128: ... fatal: Remote branch sam/<slug>-<suffix> not found in
 *   upstream origin"}
 *
 * 35 production tasks between 2026-07-29 and 2026-08-19. `dispatch_task`
 * generates a brand-new `sam/<slug>-<suffix>` output branch and hands it to the
 * standalone agent, whose clone is a bare `git clone --branch <branch>` with no
 * base-branch fallback (`standalone_workspace.go:99-124`). The VM runtime has
 * had the `ensureBranchExists` precondition since 2026-06-02; the Instant
 * runtime shipped without it.
 *
 * DISCRIMINATING: `ensures the branch on the remote BEFORE any container
 * resource is allocated` fails against the pre-fix code, where no ensure call
 * existed at all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  jwt: { signCallbackToken: vi.fn(), signNodeCallbackToken: vi.fn() },
  nodeAgent: {
    createAgentSessionOnNode: vi.fn(),
    createWorkspaceOnNode: vi.fn(),
    getCfContainerCreateWorkspaceTimeoutMs: vi.fn(),
    startAgentSessionOnNode: vi.fn(),
    waitForNodeAgentReady: vi.fn(),
  },
  nodes: { createNodeRecord: vi.fn() },
  projectData: {
    createAcpSession: vi.fn(),
    createSession: vi.fn(),
    getAcpSession: vi.fn(),
    persistMessage: vi.fn(),
    transitionAcpSession: vi.fn(),
    failSession: vi.fn(),
  },
  container: {
    destroyVmAgentContainer: vi.fn(),
    getVmAgentContainerConfig: vi.fn(),
    launchVmAgentContainer: vi.fn(),
    requireVmAgentContainer: vi.fn(),
    runContainerPhase: vi.fn(),
  },
  branch: { ensureWorkspaceBranchOnRemote: vi.fn(), logWorkspaceBranchResult: vi.fn() },
  gitSource: { resolveWorkspaceGitSource: vi.fn() },
  ulid: vi.fn(),
}));

vi.mock('../../../src/services/jwt', () => mocks.jwt);
vi.mock('../../../src/services/node-agent', () => mocks.nodeAgent);
vi.mock('../../../src/services/nodes', () => mocks.nodes);
vi.mock('../../../src/services/project-data', () => mocks.projectData);
vi.mock('../../../src/services/vm-agent-container', () => mocks.container);
vi.mock('../../../src/services/workspace-branch', () => mocks.branch);
vi.mock('../../../src/services/workspace-git-source', () => mocks.gitSource);
vi.mock('../../../src/lib/ulid', () => ({ ulid: mocks.ulid }));

import {
  acceptInstantSession,
  InstantBranchUnavailableError,
} from '../../../src/services/instant-session';

/** The exact production shape: a freshly generated, never-pushed output branch. */
const GENERATED_OUTPUT_BRANCH = 'sam/fix-chat-fontmarkdown-regression-6gtq6t';

const project = {
  id: 'project-1',
  repository: 'raphaeltm/simple-agent-manager',
  defaultBranch: 'main',
  installationId: 'installation-1',
  repoProvider: 'github',
} as never;

const env = {
  BASE_DOMAIN: 'example.com',
  CF_CONTAINER_ENABLED: 'true',
  CF_CONTAINER_VM_AGENT_PORT: '8080',
} as never;

/** Records the order of the cross-boundary calls we care about. */
let callOrder: string[];

function makeDb() {
  const inserts: unknown[] = [];
  return {
    inserts,
    db: {
      insert: vi.fn(() => ({
        values: vi.fn((value: unknown) => {
          callOrder.push('insertWorkspaceRow');
          inserts.push(value);
          return Promise.resolve();
        }),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
      })),
    },
  };
}

function launchInput(branch: string | null) {
  return {
    taskId: 'task-1',
    project,
    userId: 'user-1',
    initialPrompt: 'do the thing',
    displayMessage: 'do the thing',
    agentType: 'claude-code',
    branch,
    taskMode: 'task',
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  callOrder = [];
  mocks.ulid.mockReturnValue('workspace-1');
  mocks.jwt.signCallbackToken.mockResolvedValue('workspace-callback-token');
  mocks.jwt.signNodeCallbackToken.mockResolvedValue('node-callback-token');
  mocks.nodes.createNodeRecord.mockImplementation(() => {
    callOrder.push('createNodeRecord');
    return Promise.resolve({ id: 'node-1' });
  });
  mocks.projectData.createSession.mockResolvedValue('chat-session-1');
  mocks.projectData.persistMessage.mockResolvedValue(undefined);
  mocks.container.requireVmAgentContainer.mockReturnValue(undefined);
  mocks.container.launchVmAgentContainer.mockImplementation(() => {
    callOrder.push('launchContainer');
    return Promise.resolve();
  });
  mocks.container.runContainerPhase.mockImplementation((_phase, _detail, fn) => {
    callOrder.push('containerPhase');
    return fn();
  });
  mocks.gitSource.resolveWorkspaceGitSource.mockResolvedValue({
    repoProvider: 'github',
    cloneUrl: null,
    repositoryHost: null,
    repositoryPath: null,
  });
  mocks.branch.ensureWorkspaceBranchOnRemote.mockImplementation(() => {
    callOrder.push('ensureBranch');
    return Promise.resolve({ status: 'ready', detail: 'created' });
  });
});

describe('acceptInstantSession — checkout branch guard', () => {
  it('ensures the branch on the remote BEFORE any container resource is allocated', async () => {
    const { db } = makeDb();

    await acceptInstantSession(db as never, env, launchInput(GENERATED_OUTPUT_BRANCH));

    expect(mocks.branch.ensureWorkspaceBranchOnRemote).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        projectId: 'project-1',
        repository: 'raphaeltm/simple-agent-manager',
        repoProvider: 'github',
        installationId: 'installation-1',
        userId: 'user-1',
        branch: GENERATED_OUTPUT_BRANCH,
        baseBranch: 'main',
      })
    );
    // Ordering is the point: ensuring the ref after the node/workspace exists
    // would still burn a container on every failure.
    expect(callOrder.indexOf('ensureBranch')).toBeGreaterThanOrEqual(0);
    expect(callOrder.indexOf('ensureBranch')).toBeLessThan(callOrder.indexOf('createNodeRecord'));
    expect(callOrder.indexOf('ensureBranch')).toBeLessThan(
      callOrder.indexOf('insertWorkspaceRow')
    );
    // acceptInstantSession must not have reached container allocation at all.
    expect(callOrder).not.toContain('launchContainer');
    expect(callOrder).not.toContain('containerPhase');
  });

  it('fails closed on `missing` without allocating a node, workspace, or container', async () => {
    mocks.branch.ensureWorkspaceBranchOnRemote.mockResolvedValue({
      status: 'missing',
      reason: 'branch creation failed (403)',
    });
    const { db, inserts } = makeDb();

    const promise = acceptInstantSession(db as never, env, launchInput(GENERATED_OUTPUT_BRANCH));

    await expect(promise).rejects.toBeInstanceOf(InstantBranchUnavailableError);
    await expect(promise).rejects.toThrow(GENERATED_OUTPUT_BRANCH);
    await expect(promise).rejects.toThrow('branch creation failed (403)');

    expect(mocks.nodes.createNodeRecord).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
    expect(mocks.projectData.createSession).not.toHaveBeenCalled();
    expect(mocks.container.launchVmAgentContainer).not.toHaveBeenCalled();
  });

  it('proceeds on `unknown` — an unrunnable check must not fail a launch that works today', async () => {
    mocks.branch.ensureWorkspaceBranchOnRemote.mockResolvedValue({
      status: 'unknown',
      reason: 'GitHub installation not found for this user',
    });
    const { db } = makeDb();

    const accepted = await acceptInstantSession(
      db as never,
      env,
      launchInput(GENERATED_OUTPUT_BRANCH)
    );

    expect(accepted.branch).toBe(GENERATED_OUTPUT_BRANCH);
    expect(mocks.nodes.createNodeRecord).toHaveBeenCalledTimes(1);
  });

  it('proceeds on `skipped`', async () => {
    mocks.branch.ensureWorkspaceBranchOnRemote.mockResolvedValue({
      status: 'skipped',
      reason: 'artifacts provider has no branch API',
    });
    const { db } = makeDb();

    await expect(
      acceptInstantSession(db as never, env, launchInput(GENERATED_OUTPUT_BRANCH))
    ).resolves.toMatchObject({ branch: GENERATED_OUTPUT_BRANCH });
  });

  it('passes the project default branch as the base when no branch is requested', async () => {
    const { db } = makeDb();

    const accepted = await acceptInstantSession(db as never, env, launchInput(null));

    // The browser Instant chat path: branch === base, so the shared helper
    // short-circuits and costs nothing (asserted in workspace-branch.test.ts).
    expect(accepted.branch).toBe('main');
    expect(mocks.branch.ensureWorkspaceBranchOnRemote).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ branch: 'main', baseBranch: 'main' })
    );
  });
});
