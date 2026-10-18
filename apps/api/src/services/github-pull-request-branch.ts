import { drizzle } from 'drizzle-orm/d1';
import * as v from 'valibot';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import { readResponseJson } from '../lib/runtime-validation';
import { errors } from '../middleware/error';
import { requireRepositoryAccess } from '../routes/projects/_helpers';
import { getInstallationToken } from './github-app';
import { getExternalInstallationId } from './github-installation-ids';

// Shared with existing SAM GitHub reads; this adds no configuration or permission.
const DEFAULT_GITHUB_TIMEOUT_MS = 10_000;
const pullRequestSchema = v.object({
  number: v.pipe(v.number(), v.integer()),
  head: v.object({ ref: v.pipe(v.string(), v.nonEmpty()) }),
  base: v.object({ repo: v.object({ full_name: v.string() }) }),
});

/** Read current branch identity through the existing user ∩ installation gate. */
export async function resolveProjectPullRequestHeadBranch(
  env: Env,
  project: schema.Project,
  userId: string,
  canonicalPrUrl: string
): Promise<string> {
  const installation = await requireRepositoryAccess(
    env,
    drizzle(env.DATABASE, { schema }),
    project,
    userId
  );
  if (!installation) throw errors.forbidden('Authorized GitHub installation is required');
  const number = canonicalPrUrl.slice(canonicalPrUrl.lastIndexOf('/') + 1);
  const repository = project.repository.toLowerCase();
  if (
    canonicalPrUrl !== `https://github.com/${repository}/pull/${number}` ||
    !/^[1-9][0-9]*$/.test(number)
  ) {
    throw errors.badRequest('An exact project PR URL is required');
  }
  const { token } = await getInstallationToken(getExternalInstallationId(installation), env);
  const response = await fetch(
    `https://api.github.com/repos/${repository.split('/').map(encodeURIComponent).join('/')}/pulls/${number}`,
    {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(
        parsePositiveInt(env.SAM_GITHUB_TIMEOUT_MS, DEFAULT_GITHUB_TIMEOUT_MS)
      ),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Simple-Agent-Manager',
      },
    }
  );
  if (!response.ok)
    throw errors.badRequest('Cannot verify current PR branch with existing GitHub access');
  const pr = await readResponseJson(response, pullRequestSchema, 'github.pull_request_branch');
  if (String(pr.number) !== number || pr.base.repo.full_name.toLowerCase() !== repository) {
    throw errors.badRequest('GitHub PR identity does not match this project');
  }
  return pr.head.ref;
}
