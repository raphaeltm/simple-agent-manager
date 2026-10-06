import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { isValidGitRefName } from './branch-name';
import { getExternalInstallationId } from './github-installation-ids';

/**
 * Result of ensuring a workspace's checkout branch exists on the remote.
 *
 * The distinction between `missing` and `unknown` is load-bearing. A runtime
 * whose clone has no base-branch fallback (the standalone/cf-container agent —
 * `packages/vm-agent/internal/server/standalone_workspace.go` runs a bare
 * `git clone --branch <branch>`) is guaranteed to fail on `missing`, so it may
 * refuse to provision. It must NOT refuse on `unknown`/`skipped`: those mean the
 * check could not run, and the branch may well be present — turning those into
 * hard failures would break launches that work today (e.g. a project whose
 * GitHub installation row is owned by another member).
 */
export type EnsureWorkspaceBranchResult =
  /** The branch is on the remote — pre-existing, or created by this call. */
  | { status: 'ready'; detail: 'exists' | 'created' }
  /** The guard does not apply (branch is the base, or the provider has no ref API). */
  | { status: 'skipped'; reason: string }
  /** Confirmed absent and could not be created — a `--branch` clone WILL fail. */
  | { status: 'missing'; reason: string }
  /** The check could not run; the branch may or may not exist. */
  | { status: 'unknown'; reason: string };

export interface EnsureWorkspaceBranchInput {
  projectId: string;
  /** `owner/repo` for GitHub projects. */
  repository: string;
  /** `github` | `gitlab` | `artifacts`; anything else is treated as `github`. */
  repoProvider: string | null | undefined;
  /** `github_installations.id` (the internal row id, not the GitHub numeric id). */
  installationId: string | null | undefined;
  /** Owner of the workspace/task; scopes the installation and GitLab lookups. */
  userId: string;
  /** The branch the runtime will check out. */
  branch: string;
  /** Existing branch to create `branch` from when it is absent. */
  baseBranch: string;
  /**
   * Invoked immediately before any remote write. Lets the TaskRunner DO abort a
   * superseded replacement before it mutates the repository
   * (`assertRecoveryAuthority`). Throwing here propagates to the caller.
   */
  beforeRemoteWrite?: () => Promise<void>;
}

/**
 * Ensure the checkout branch exists on the remote before a workspace clones it.
 *
 * Shared by both runtimes so the guard cannot drift again: the VM path
 * (`durable-objects/task-runner/workspace-branch.ts`) treats every non-`ready`
 * result as best-effort because `bootstrap.go` can still clone `baseBranch` and
 * `git checkout -b`, while the Instant path (`services/instant-session.ts`)
 * fails closed on `missing`.
 *
 * PRECONDITION — this function WRITES to the caller's repository (it creates a
 * ref) using a GitHub App installation token. It authenticates the installation
 * but does NOT re-verify that `userId` still has live access to `repository`.
 * Every caller MUST already have done so on this request:
 *   - `routes/mcp/dispatch-tool.ts` → `requireRepositoryOwnerAccess()`
 *   - `routes/chat-start.ts` → `requireRepositoryUserAccess()`
 *   - `durable-objects/task-runner/*` → the dispatch/submit route that started it
 * A new caller that skips that check would be able to create refs on a
 * repository the user no longer has access to. See
 * `.claude/rules/61-guards-must-cover-every-runtime.md`.
 */
export async function ensureWorkspaceBranchOnRemote(
  env: Env,
  input: EnsureWorkspaceBranchInput
): Promise<EnsureWorkspaceBranchResult> {
  const branch = input.branch.trim();
  const baseBranch = input.baseBranch.trim() || 'main';

  if (!branch) {
    return { status: 'skipped', reason: 'no checkout branch requested' };
  }
  if (branch === baseBranch) {
    return { status: 'skipped', reason: 'checkout branch is the base branch' };
  }

  // `dispatch_task` accepts an explicit `branch` that is only checked for
  // non-emptiness, and this guard turns it into a ref CREATE on the caller's
  // repository. Validate the name server-side before any provider write rather
  // than relying on the caller to have sanitized it (rule 51). A name git would
  // reject cannot exist on any remote either, so `missing` is accurate and gives
  // the caller an actionable error instead of a 422 from the provider.
  if (!isValidGitRefName(branch)) {
    return { status: 'missing', reason: 'branch name is not a valid git ref' };
  }

  switch (normalizeRepoProvider(input.repoProvider)) {
    case 'artifacts':
      // The Artifacts binding exposes no ref API; the clone is the only check.
      return { status: 'skipped', reason: 'artifacts provider has no branch API' };
    case 'gitlab':
      return ensureGitLabBranch(env, input, branch, baseBranch);
    default:
      return ensureGitHubBranch(env, input, branch, baseBranch);
  }
}

function normalizeRepoProvider(value: string | null | undefined): string {
  return value === 'gitlab' || value === 'artifacts' ? value : 'github';
}

async function ensureGitHubBranch(
  env: Env,
  input: EnsureWorkspaceBranchInput,
  branch: string,
  baseBranch: string
): Promise<EnsureWorkspaceBranchResult> {
  try {
    return await ensureGitHubBranchUnguarded(env, input, branch, baseBranch);
  } catch (err) {
    // A THROW is not evidence the ref is absent — a rejected fetch, a GitHub
    // App misconfiguration, or a malformed response body all land here. The
    // Instant path fails closed on `missing`, so letting an exception escape
    // would turn a transient GitHub blip into a failed task, which is exactly
    // what the missing/unknown split exists to prevent. Mirrors the GitLab arm.
    // `beforeRemoteWrite` rejections must still propagate: they mean this
    // replacement lost its recovery authority and must not keep provisioning.
    if (err instanceof BeforeRemoteWriteError) throw err.cause;
    return { status: 'unknown', reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Wraps a `beforeRemoteWrite` rejection so the guard's catch can re-throw it. */
class BeforeRemoteWriteError extends Error {
  constructor(readonly cause: unknown) {
    super('beforeRemoteWrite rejected');
  }
}

async function runBeforeRemoteWrite(input: EnsureWorkspaceBranchInput): Promise<void> {
  try {
    await input.beforeRemoteWrite?.();
  } catch (err) {
    throw new BeforeRemoteWriteError(err);
  }
}

async function ensureGitHubBranchUnguarded(
  env: Env,
  input: EnsureWorkspaceBranchInput,
  branch: string,
  baseBranch: string
): Promise<EnsureWorkspaceBranchResult> {
  const repoParts = input.repository.split('/');
  const owner = repoParts[0];
  const repo = repoParts[1];
  if (repoParts.length !== 2 || !owner || !repo) {
    return { status: 'unknown', reason: `repository "${input.repository}" is not "owner/repo"` };
  }

  if (!input.installationId) {
    return { status: 'unknown', reason: 'project has no GitHub installation' };
  }

  const installation = await env.DATABASE.prepare(
    `SELECT installation_id AS installationId, external_installation_id AS externalInstallationId
     FROM github_installations
     WHERE id = ? AND user_id = ?`
  )
    .bind(input.installationId, input.userId)
    .first<{ installationId: string; externalInstallationId: string | null }>();

  if (!installation) {
    // Shared/multiplayer projects can store the installation under another
    // member's user id. The clone's own token route resolves those by row id
    // after an explicit access check, so widening this lookup is a separate,
    // security-reviewed change — until then, report `unknown` (never `missing`)
    // so the launch proceeds exactly as it does today.
    return { status: 'unknown', reason: 'GitHub installation not found for this user' };
  }

  const { ensureBranchExists } = await import('./github-app');
  await runBeforeRemoteWrite(input);
  const outcome = await ensureBranchExists(
    getExternalInstallationId(installation),
    owner,
    repo,
    branch,
    baseBranch,
    env
  );

  switch (outcome.status) {
    case 'exists':
      return { status: 'ready', detail: 'exists' };
    case 'created':
      return { status: 'ready', detail: 'created' };
    case 'missing':
      return { status: 'missing', reason: outcome.reason };
    default:
      return { status: 'unknown', reason: outcome.reason };
  }
}

async function ensureGitLabBranch(
  env: Env,
  input: EnsureWorkspaceBranchInput,
  branch: string,
  baseBranch: string
): Promise<EnsureWorkspaceBranchResult> {
  try {
    const { ensureGitLabBranchExists, getProjectGitLabRepository } = await import('./gitlab');
    // NOTE: `acceptInstantSession` resolves the same GitLab metadata again via
    // resolveWorkspaceGitSource. That second read is bounded to GitLab projects
    // launching on a non-default branch; threading the numeric project id
    // through WorkspaceGitSource to dedupe it would couple two unrelated
    // contracts for a rare path (rule 60 tradeoff, taken deliberately).
    const metadata = await getProjectGitLabRepository(
      drizzle(env.DATABASE, { schema }),
      input.projectId
    );
    if (!metadata) {
      return { status: 'unknown', reason: 'GitLab repository metadata is missing' };
    }

    await runBeforeRemoteWrite(input);
    const created = await ensureGitLabBranchExists({
      env,
      userId: input.userId,
      projectId: metadata.gitlabProjectId,
      branch,
      ref: baseBranch,
    });
    return { status: 'ready', detail: created ? 'created' : 'exists' };
  } catch (err) {
    if (err instanceof BeforeRemoteWriteError) throw err.cause;
    // ensureGitLabBranchExists throws for both "lookup failed" and "create
    // failed" without distinguishing them, so we cannot claim positive evidence
    // that the ref is absent. Stay conservative and let the clone decide.
    return {
      status: 'unknown',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Log a non-`ready` result at a severity that matches how much we actually know.
 * Shared so both runtimes emit the same diagnostic shape.
 */
export function logWorkspaceBranchResult(
  event: string,
  result: EnsureWorkspaceBranchResult,
  details: Record<string, unknown>
): void {
  if (result.status === 'ready') {
    log.info(`${event}.ok`, { ...details, detail: result.detail });
    return;
  }
  if (result.status === 'skipped') {
    log.debug(`${event}.skipped`, { ...details, reason: result.reason });
    return;
  }
  log.warn(`${event}.${result.status}`, { ...details, reason: result.reason });
}
