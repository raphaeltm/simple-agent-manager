/**
 * Vertical slice for the Instant checkout-branch guard (rule 35).
 *
 * `instant-session-branch-guard.test.ts` mocks `services/workspace-branch`
 * wholesale, so it proves the decision logic but NOT the wiring. This file runs
 * the real `acceptInstantSession` → real `services/workspace-branch` → real
 * `github-app.ensureBranchExists` chain, mocking only the system boundaries:
 * the GitHub HTTP API, D1 (a real SQLite engine), and the container/node
 * primitives.
 *
 * It is the test that catches a field-name or base-branch mistake between the
 * two modules — e.g. passing `defaultBranch` where the service expects
 * `baseBranch`, or forwarding the wrong installation id.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
  gitSource: { resolveWorkspaceGitSource: vi.fn() },
  ulid: vi.fn(),
}));

vi.mock('../../../src/lib/logger', () => ({ log: mocks.log, createModuleLogger: () => mocks.log }));
vi.mock('../../../src/services/jwt', () => mocks.jwt);
vi.mock('../../../src/services/node-agent', () => mocks.nodeAgent);
vi.mock('../../../src/services/nodes', () => mocks.nodes);
vi.mock('../../../src/services/project-data', () => mocks.projectData);
vi.mock('../../../src/services/vm-agent-container', () => mocks.container);
vi.mock('../../../src/services/workspace-git-source', () => mocks.gitSource);
vi.mock('../../../src/lib/ulid', () => ({ ulid: mocks.ulid }));

// Avoid real crypto when github-app mints the installation token.
vi.mock('jose', () => {
  class MockSignJWT {
    setProtectedHeader() {
      return this;
    }
    setIssuedAt() {
      return this;
    }
    setIssuer() {
      return this;
    }
    setExpirationTime() {
      return this;
    }
    async sign() {
      return 'mock-jwt';
    }
  }
  return { importPKCS8: vi.fn().mockResolvedValue('mock-key'), SignJWT: MockSignJWT };
});
vi.mock('../../../src/lib/runtime-validation', () => ({
  readResponseJson: vi.fn().mockImplementation(async (response: Response) => response.json()),
  expectJsonRecord: vi.fn().mockImplementation((val: unknown) => val),
}));

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import {
  acceptInstantSession,
  InstantBranchUnavailableError,
} from '../../../src/services/instant-session';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const GENERATED_OUTPUT_BRANCH = 'sam/fix-chat-fontmarkdown-regression-6gtq6t';
const EXTERNAL_INSTALLATION_ID = '987654321';

const project = {
  id: 'project-1',
  repository: 'raphaeltm/simple-agent-manager',
  defaultBranch: 'main',
  installationId: 'inst-row-1',
  repoProvider: 'github',
} as never;

let sqlite: Database.Database;
let env: Env;
let fetchMock: ReturnType<typeof vi.fn>;

function makeDb() {
  const inserts: unknown[] = [];
  return {
    inserts,
    db: {
      insert: vi.fn(() => ({
        values: vi.fn((value: unknown) => {
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

/** URLs the GitHub boundary saw, in order. */
function requestedUrls(): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

beforeEach(() => {
  vi.clearAllMocks();

  sqlite = new Database(':memory:');
  // Built from the drizzle definitions so the fixture cannot drift from the
  // real schema (rule 28). `platform_credentials` stays empty, so github-app's
  // real resolvePlatformConfig falls back to env vars — the
  // environment-fallback deployment shape.
  createSchemaTables(sqlite, [
    schema.platformCredentials,
    schema.platformSettings,
    schema.githubInstallations,
  ]);
  sqlite
    .prepare(
      `INSERT INTO github_installations (id, user_id, installation_id, external_installation_id)
       VALUES (?, ?, ?, ?)`
    )
    .run('inst-row-1', 'user-1', 'legacy-123', EXTERNAL_INSTALLATION_ID);

  env = {
    BASE_DOMAIN: 'example.com',
    CF_CONTAINER_ENABLED: 'true',
    CF_CONTAINER_VM_AGENT_PORT: '8080',
    GITHUB_APP_ID: 'test-app-id',
    GITHUB_APP_PRIVATE_KEY: btoa('test-private-key'),
    DATABASE: createSqliteD1(sqlite),
  } as unknown as Env;

  mocks.ulid.mockReturnValue('workspace-1');
  mocks.jwt.signCallbackToken.mockResolvedValue('workspace-callback-token');
  mocks.jwt.signNodeCallbackToken.mockResolvedValue('node-callback-token');
  mocks.nodes.createNodeRecord.mockResolvedValue({ id: 'node-1' });
  mocks.projectData.createSession.mockResolvedValue('chat-session-1');
  mocks.projectData.persistMessage.mockResolvedValue(undefined);
  mocks.container.requireVmAgentContainer.mockReturnValue(undefined);
  mocks.gitSource.resolveWorkspaceGitSource.mockResolvedValue({
    repoProvider: 'github',
    cloneUrl: null,
    repositoryHost: null,
    repositoryPath: null,
  });

  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  sqlite.close();
  vi.unstubAllGlobals();
});

describe('acceptInstantSession — real branch guard against the GitHub boundary', () => {
  it('creates the never-pushed output branch from the project default before provisioning', async () => {
    fetchMock
      // getInstallationToken
      .mockResolvedValueOnce(
        Response.json({ token: 'installation-token', expires_at: '2026-12-31T00:00:00Z' })
      )
      // branch lookup → absent (this is the production condition)
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      // default branch ref → sha
      .mockResolvedValueOnce(
        Response.json({ ref: 'refs/heads/main', object: { sha: 'deadbeefcafe' } })
      )
      // create ref
      .mockResolvedValueOnce(
        Response.json({ ref: `refs/heads/${GENERATED_OUTPUT_BRANCH}` }, { status: 201 })
      );

    const { db } = makeDb();
    const accepted = await acceptInstantSession(
      db as never,
      env,
      launchInput(GENERATED_OUTPUT_BRANCH)
    );

    expect(accepted.branch).toBe(GENERATED_OUTPUT_BRANCH);

    const urls = requestedUrls();
    // Correct installation id resolved out of D1 and used to mint the token.
    expect(urls[0]).toBe(
      `https://api.github.com/app/installations/${EXTERNAL_INSTALLATION_ID}/access_tokens`
    );
    // Correct owner/repo and branch.
    expect(urls[1]).toBe(
      `https://api.github.com/repos/raphaeltm/simple-agent-manager/branches/${encodeURIComponent(GENERATED_OUTPUT_BRANCH)}`
    );
    // Correct BASE branch — a `defaultBranch`/`baseBranch` field mix-up shows up here.
    expect(urls[2]).toBe(
      'https://api.github.com/repos/raphaeltm/simple-agent-manager/git/ref/heads/main'
    );
    expect(urls[3]).toBe('https://api.github.com/repos/raphaeltm/simple-agent-manager/git/refs');

    const createCall = fetchMock.mock.calls[3]?.[1] as RequestInit;
    expect(JSON.parse(String(createCall.body))).toEqual({
      ref: `refs/heads/${GENERATED_OUTPUT_BRANCH}`,
      sha: 'deadbeefcafe',
    });

    expect(mocks.nodes.createNodeRecord).toHaveBeenCalledTimes(1);
  });

  it('does not touch GitHub at all when the branch is the project default', async () => {
    const { db } = makeDb();

    await acceptInstantSession(db as never, env, launchInput(null));

    // The browser Instant chat path must add zero latency.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.nodes.createNodeRecord).toHaveBeenCalledTimes(1);
  });

  it('refuses to provision when the ref is absent and cannot be created', async () => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json({ token: 'installation-token', expires_at: '2026-12-31T00:00:00Z' })
      )
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        Response.json({ ref: 'refs/heads/main', object: { sha: 'deadbeefcafe' } })
      )
      // creation rejected (e.g. the App lacks contents:write)
      .mockResolvedValueOnce(new Response('forbidden', { status: 403 }));

    const { db, inserts } = makeDb();

    await expect(
      acceptInstantSession(db as never, env, launchInput(GENERATED_OUTPUT_BRANCH))
    ).rejects.toBeInstanceOf(InstantBranchUnavailableError);

    expect(mocks.nodes.createNodeRecord).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
    expect(mocks.container.launchVmAgentContainer).not.toHaveBeenCalled();
  });

  it('proceeds when GitHub is unhealthy — an unrunnable check must not block a launch', async () => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json({ token: 'installation-token', expires_at: '2026-12-31T00:00:00Z' })
      )
      // 500 on the lookup: we learned nothing, so this is `unknown`, not `missing`.
      .mockResolvedValueOnce(new Response(null, { status: 500 }));

    const { db } = makeDb();

    const accepted = await acceptInstantSession(
      db as never,
      env,
      launchInput(GENERATED_OUTPUT_BRANCH)
    );

    expect(accepted.branch).toBe(GENERATED_OUTPUT_BRANCH);
    expect(mocks.nodes.createNodeRecord).toHaveBeenCalledTimes(1);
  });

  it('proceeds when the GitHub call THROWS, not just when it errors', async () => {
    // A rejected fetch is a different code path from a 500 response and was the
    // real gap review caught: an unguarded await here escaped acceptInstantSession
    // and hard-failed the task, contradicting "unknown never blocks".
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const { db } = makeDb();
    const accepted = await acceptInstantSession(
      db as never,
      env,
      launchInput(GENERATED_OUTPUT_BRANCH)
    );

    expect(accepted.branch).toBe(GENERATED_OUTPUT_BRANCH);
    expect(mocks.nodes.createNodeRecord).toHaveBeenCalledTimes(1);
  });

  it('treats an already-existing branch as ready without creating a ref', async () => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json({ token: 'installation-token', expires_at: '2026-12-31T00:00:00Z' })
      )
      .mockResolvedValueOnce(Response.json({ name: GENERATED_OUTPUT_BRANCH }));

    const { db } = makeDb();
    await acceptInstantSession(db as never, env, launchInput(GENERATED_OUTPUT_BRANCH));

    expect(requestedUrls()).toHaveLength(2);
    expect(requestedUrls().some((url) => url.endsWith('/git/refs'))).toBe(false);
  });

  it('wins the create race (422) instead of failing the launch', async () => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json({ token: 'installation-token', expires_at: '2026-12-31T00:00:00Z' })
      )
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        Response.json({ ref: 'refs/heads/main', object: { sha: 'deadbeefcafe' } })
      )
      // A sibling dispatch created it between our check and our create.
      .mockResolvedValueOnce(new Response(null, { status: 422 }));

    const { db } = makeDb();

    await expect(
      acceptInstantSession(db as never, env, launchInput(GENERATED_OUTPUT_BRANCH))
    ).resolves.toMatchObject({ branch: GENERATED_OUTPUT_BRANCH });
    expect(mocks.nodes.createNodeRecord).toHaveBeenCalledTimes(1);
  });
});
