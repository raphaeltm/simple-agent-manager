/**
 * Tests for the shared ensure-checkout-branch guard used by BOTH workspace
 * runtimes (`durable-objects/task-runner/workspace-branch.ts` for VMs,
 * `services/instant-session.ts` for cf-containers).
 *
 * The load-bearing behaviour is the `missing` vs `unknown` split: `missing` is
 * positive evidence that a `git clone --branch` will fail and is the only result
 * that may block provisioning. Everything else must let the launch proceed.
 *
 * The GitHub installation lookup is exercised against a real SQLite engine
 * (rule 28) because it is scoped by `user_id`.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  ensureBranchExists: vi.fn(),
  ensureGitLabBranchExists: vi.fn(),
  getProjectGitLabRepository: vi.fn(),
}));

vi.mock('../../../src/lib/logger', () => ({
  log: mocks.log,
  createModuleLogger: () => mocks.log,
}));
vi.mock('../../../src/services/github-app', () => ({
  ensureBranchExists: mocks.ensureBranchExists,
}));
vi.mock('../../../src/services/gitlab', () => ({
  ensureGitLabBranchExists: mocks.ensureGitLabBranchExists,
  getProjectGitLabRepository: mocks.getProjectGitLabRepository,
}));

import type { Env } from '../../../src/env';
import { ensureWorkspaceBranchOnRemote } from '../../../src/services/workspace-branch';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

const OWNER_USER = 'user-owner';
const OTHER_USER = 'user-other';
const INSTALLATION_ROW = 'inst-row-1';

let sqlite: Database.Database;
let env: Env;

function seedInstallation(ownerUserId: string): void {
  sqlite
    .prepare(
      `INSERT INTO github_installations (id, user_id, installation_id, external_installation_id)
       VALUES (?, ?, ?, ?)`
    )
    .run(INSTALLATION_ROW, ownerUserId, 'legacy-123', '987654321');
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    projectId: 'project-1',
    repository: 'acme/widgets',
    repoProvider: 'github',
    installationId: INSTALLATION_ROW,
    userId: OWNER_USER,
    branch: 'sam/new-work-abc123',
    baseBranch: 'main',
    ...overrides,
  } as Parameters<typeof ensureWorkspaceBranchOnRemote>[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE github_installations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      external_installation_id TEXT
    );
  `);
  env = { DATABASE: createSqliteD1(sqlite) } as unknown as Env;
});

afterEach(() => {
  sqlite.close();
});

describe('ensureWorkspaceBranchOnRemote — short circuits', () => {
  it('skips entirely when the checkout branch is the base branch', async () => {
    seedInstallation(OWNER_USER);

    const result = await ensureWorkspaceBranchOnRemote(
      env,
      baseInput({ branch: 'main', baseBranch: 'main' })
    );

    expect(result).toEqual({
      status: 'skipped',
      reason: 'checkout branch is the base branch',
    });
    // The browser Instant chat path always lands here, so it must cost zero
    // GitHub round-trips.
    expect(mocks.ensureBranchExists).not.toHaveBeenCalled();
  });

  it('treats an empty base branch as "main"', async () => {
    const result = await ensureWorkspaceBranchOnRemote(
      env,
      baseInput({ branch: 'main', baseBranch: '' })
    );

    expect(result.status).toBe('skipped');
    expect(mocks.ensureBranchExists).not.toHaveBeenCalled();
  });

  it('skips when no checkout branch was requested', async () => {
    const result = await ensureWorkspaceBranchOnRemote(env, baseInput({ branch: '   ' }));

    expect(result.status).toBe('skipped');
    expect(mocks.ensureBranchExists).not.toHaveBeenCalled();
  });

  it('skips the artifacts provider, which exposes no ref API', async () => {
    const result = await ensureWorkspaceBranchOnRemote(
      env,
      baseInput({ repoProvider: 'artifacts' })
    );

    expect(result).toEqual({
      status: 'skipped',
      reason: 'artifacts provider has no branch API',
    });
    expect(mocks.ensureBranchExists).not.toHaveBeenCalled();
  });
});

describe('ensureWorkspaceBranchOnRemote — GitHub', () => {
  it('reports ready/created and passes the external installation id through', async () => {
    seedInstallation(OWNER_USER);
    mocks.ensureBranchExists.mockResolvedValue({ status: 'created' });

    const result = await ensureWorkspaceBranchOnRemote(env, baseInput());

    expect(result).toEqual({ status: 'ready', detail: 'created' });
    expect(mocks.ensureBranchExists).toHaveBeenCalledWith(
      '987654321',
      'acme',
      'widgets',
      'sam/new-work-abc123',
      'main',
      env
    );
  });

  it('reports ready/exists when the ref is already on the remote', async () => {
    seedInstallation(OWNER_USER);
    mocks.ensureBranchExists.mockResolvedValue({ status: 'exists' });

    await expect(ensureWorkspaceBranchOnRemote(env, baseInput())).resolves.toEqual({
      status: 'ready',
      detail: 'exists',
    });
  });

  it('propagates `missing` — the only result that proves a --branch clone will fail', async () => {
    seedInstallation(OWNER_USER);
    mocks.ensureBranchExists.mockResolvedValue({
      status: 'missing',
      reason: 'branch creation failed (403)',
    });

    await expect(ensureWorkspaceBranchOnRemote(env, baseInput())).resolves.toEqual({
      status: 'missing',
      reason: 'branch creation failed (403)',
    });
  });

  it('propagates `unknown` when the lookup itself failed', async () => {
    seedInstallation(OWNER_USER);
    mocks.ensureBranchExists.mockResolvedValue({
      status: 'unknown',
      reason: 'branch lookup returned 500',
    });

    await expect(ensureWorkspaceBranchOnRemote(env, baseInput())).resolves.toEqual({
      status: 'unknown',
      reason: 'branch lookup returned 500',
    });
  });

  it('reports unknown (never missing) for an unparseable repository', async () => {
    seedInstallation(OWNER_USER);

    const result = await ensureWorkspaceBranchOnRemote(
      env,
      baseInput({ repository: 'not-owner-slash-repo' })
    );

    expect(result.status).toBe('unknown');
    expect(mocks.ensureBranchExists).not.toHaveBeenCalled();
  });

  it('reports unknown (never missing) when the project has no installation', async () => {
    const result = await ensureWorkspaceBranchOnRemote(env, baseInput({ installationId: null }));

    expect(result).toEqual({
      status: 'unknown',
      reason: 'project has no GitHub installation',
    });
    expect(mocks.ensureBranchExists).not.toHaveBeenCalled();
  });

  it('does NOT use an installation row owned by another user, and never reports missing', async () => {
    // Attack/foreign case: the row exists but belongs to someone else. Minting a
    // token against it would cross a tenant boundary, so the lookup must not
    // match — and the result must stay `unknown` so the launch is not blocked.
    seedInstallation(OTHER_USER);

    const result = await ensureWorkspaceBranchOnRemote(env, baseInput({ userId: OWNER_USER }));

    expect(result).toEqual({
      status: 'unknown',
      reason: 'GitHub installation not found for this user',
    });
    expect(mocks.ensureBranchExists).not.toHaveBeenCalled();
  });

  it('owner-path control: the same fixture DOES resolve for the row owner', async () => {
    // Pairs with the case above (rule 28): without this, "nothing happened"
    // would also be satisfied by the lookup being broken outright.
    seedInstallation(OTHER_USER);
    mocks.ensureBranchExists.mockResolvedValue({ status: 'created' });

    const result = await ensureWorkspaceBranchOnRemote(env, baseInput({ userId: OTHER_USER }));

    expect(result).toEqual({ status: 'ready', detail: 'created' });
    expect(mocks.ensureBranchExists).toHaveBeenCalledTimes(1);
  });

  it('runs beforeRemoteWrite before mutating the repository, and propagates its throw', async () => {
    seedInstallation(OWNER_USER);
    const boom = new Error('recovery authority revoked');
    const beforeRemoteWrite = vi.fn().mockRejectedValue(boom);

    await expect(
      ensureWorkspaceBranchOnRemote(env, baseInput({ beforeRemoteWrite }))
    ).rejects.toThrow(boom);

    expect(beforeRemoteWrite).toHaveBeenCalledTimes(1);
    expect(mocks.ensureBranchExists).not.toHaveBeenCalled();
  });
});

describe('ensureWorkspaceBranchOnRemote — GitLab', () => {
  it('creates the branch from the base ref', async () => {
    mocks.getProjectGitLabRepository.mockResolvedValue({ gitlabProjectId: 4242 });
    mocks.ensureGitLabBranchExists.mockResolvedValue(true);

    const result = await ensureWorkspaceBranchOnRemote(
      env,
      baseInput({ repoProvider: 'gitlab', baseBranch: 'trunk' })
    );

    expect(result).toEqual({ status: 'ready', detail: 'created' });
    expect(mocks.ensureGitLabBranchExists).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 4242, branch: 'sam/new-work-abc123', ref: 'trunk' })
    );
  });

  it('reports ready/exists when GitLab already has the branch', async () => {
    mocks.getProjectGitLabRepository.mockResolvedValue({ gitlabProjectId: 4242 });
    mocks.ensureGitLabBranchExists.mockResolvedValue(false);

    await expect(
      ensureWorkspaceBranchOnRemote(env, baseInput({ repoProvider: 'gitlab' }))
    ).resolves.toEqual({ status: 'ready', detail: 'exists' });
  });

  it('reports unknown when GitLab metadata is missing', async () => {
    mocks.getProjectGitLabRepository.mockResolvedValue(null);

    const result = await ensureWorkspaceBranchOnRemote(
      env,
      baseInput({ repoProvider: 'gitlab' })
    );

    expect(result.status).toBe('unknown');
    expect(mocks.ensureGitLabBranchExists).not.toHaveBeenCalled();
  });

  it('reports unknown (never missing) when GitLab throws — lookup and create are indistinguishable', async () => {
    mocks.getProjectGitLabRepository.mockResolvedValue({ gitlabProjectId: 4242 });
    mocks.ensureGitLabBranchExists.mockRejectedValue(new Error('GitLab branch create failed: 403'));

    const result = await ensureWorkspaceBranchOnRemote(
      env,
      baseInput({ repoProvider: 'gitlab' })
    );

    expect(result).toEqual({
      status: 'unknown',
      reason: 'GitLab branch create failed: 403',
    });
  });
});
