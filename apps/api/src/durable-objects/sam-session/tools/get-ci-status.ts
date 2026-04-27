/**
 * SAM get_ci_status tool — check GitHub Actions CI status for a project.
 *
 * Resolves the user's GitHub token from encrypted credentials, then queries
 * the GitHub Actions API for recent workflow runs on the default branch.
 */
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../../db/schema';
import type { Env } from '../../../env';
import { log } from '../../../lib/logger';
import { getCredentialEncryptionKey } from '../../../lib/secrets';
import { decrypt } from '../../../services/encryption';
import type { AnthropicToolDef, ToolContext } from '../types';

const DEFAULT_CI_RUNS_LIMIT = 5;
const DEFAULT_GITHUB_TIMEOUT_MS = 10_000;
const REPO_FORMAT_RE = /^[\w.-]+\/[\w.-]+$/;

export const getCiStatusDef: AnthropicToolDef = {
  name: 'get_ci_status',
  description:
    'Check GitHub Actions CI status for a project. ' +
    'Shows recent workflow runs on the default branch with their status and conclusion.',
  input_schema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The project ID to check CI status for.',
      },
    },
    required: ['projectId'],
  },
};

export async function getCiStatus(
  input: { projectId: string },
  ctx: ToolContext,
): Promise<unknown> {
  const env = ctx.env as unknown as Env;
  const db = drizzle(env.DATABASE, { schema });

  if (!input.projectId?.trim()) {
    return { error: 'projectId is required.' };
  }

  // Verify ownership and get repository info
  const [project] = await db
    .select({
      id: schema.projects.id,
      repository: schema.projects.repository,
      defaultBranch: schema.projects.defaultBranch,
    })
    .from(schema.projects)
    .where(
      and(
        eq(schema.projects.id, input.projectId),
        eq(schema.projects.userId, ctx.userId),
      ),
    )
    .limit(1);

  if (!project) {
    return { error: 'Project not found or not owned by you.' };
  }

  if (!project.repository) {
    return { status: 'no_repository', note: 'No repository configured for this project.' };
  }

  if (!REPO_FORMAT_RE.test(project.repository)) {
    return { error: 'Invalid repository format.' };
  }

  // Resolve GitHub token from user credentials
  const ghToken = await getUserGitHubToken(db, ctx.userId, env);
  if (!ghToken) {
    return {
      status: 'no_credentials',
      note: 'No GitHub token available. CI status requires GitHub credentials in Settings.',
    };
  }

  const branch = project.defaultBranch || 'main';
  const runsLimit = Number(env.SAM_CI_RUNS_LIMIT) || DEFAULT_CI_RUNS_LIMIT;
  const timeoutMs = Number(env.SAM_GITHUB_TIMEOUT_MS) || DEFAULT_GITHUB_TIMEOUT_MS;

  try {
    const apiUrl = `https://api.github.com/repos/${project.repository}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=${runsLimit}`;

    const res = await fetch(apiUrl, {
      headers: {
        Authorization: `Bearer ${ghToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'SAM/1.0',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      return {
        status: 'api_error',
        note: `GitHub API returned ${res.status}`,
        repository: project.repository,
      };
    }

    const data = await res.json() as {
      workflow_runs?: Array<{
        id: number;
        name: string;
        status: string;
        conclusion: string | null;
        html_url: string;
        created_at: string;
      }>;
    };

    const runs = (data.workflow_runs ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      conclusion: r.conclusion,
      url: r.html_url,
      createdAt: r.created_at,
    }));

    // Determine overall status
    let overallStatus = 'no_runs';
    if (runs.length > 0) {
      const hasRunning = runs.some((r) => r.status === 'in_progress' || r.status === 'queued');
      const hasFailed = runs.some((r) => r.conclusion === 'failure');
      if (hasRunning) overallStatus = 'running';
      else if (hasFailed) overallStatus = 'failed';
      else overallStatus = 'passed';
    }

    return {
      repository: project.repository,
      branch,
      overallStatus,
      runs,
    };
  } catch (err) {
    log.warn('sam.get_ci_status.failed', {
      projectId: input.projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      status: 'error',
      note: `Failed to fetch CI status: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Get the user's GitHub token from encrypted credentials.
 * Returns null if not available.
 */
async function getUserGitHubToken(
  db: ReturnType<typeof drizzle>,
  userId: string,
  env: Env,
): Promise<string | null> {
  try {
    const [cred] = await db
      .select({
        encryptedToken: schema.credentials.encryptedToken,
        iv: schema.credentials.iv,
      })
      .from(schema.credentials)
      .where(
        and(
          eq(schema.credentials.userId, userId),
          eq(schema.credentials.provider, 'github'),
        ),
      )
      .limit(1);

    if (!cred) return null;

    const encryptionKey = getCredentialEncryptionKey(env);
    return await decrypt(cred.encryptedToken, cred.iv, encryptionKey);
  } catch (e) {
    log.warn('sam.get_ci_status.github_token_failed', { userId, error: String(e) });
    return null;
  }
}
