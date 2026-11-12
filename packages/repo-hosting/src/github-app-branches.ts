import * as v from 'valibot';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { readResponseJson } from '../lib/runtime-validation';
import { fetchWithTimeout } from './fetch-timeout';
import {
  branchSchema,
  DEFAULT_MAX_BRANCHES_PER_REPO,
  type EnsureBranchOutcome,
  readGitHubError,
} from './github-app-common';
import { getInstallationToken } from './github-app-tokens';

/**
 * List branches for a repository via an installation token.
 * Paginates through all pages to support repos with many branches.
 */
export async function getRepositoryBranches(
  installationId: string,
  owner: string,
  repo: string,
  env: Env,
  defaultBranch?: string
): Promise<Array<{ name: string }>> {
  const { token } = await getInstallationToken(installationId, env);

  const maxBranches =
    parseInt(env.MAX_BRANCHES_PER_REPO || '', 10) || DEFAULT_MAX_BRANCHES_PER_REPO;
  const allBranches: Array<{ name: string }> = [];
  let page = 1;
  const perPage = 100;
  let hasMore = true;

  while (hasMore) {
    const response = await fetchWithTimeout(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=${perPage}&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'Simple-Agent-Manager',
        },
      }
    );

    if (!response.ok) {
      throw new Error(
        await readGitHubError(response, `Failed to list branches: ${response.status}`)
      );
    }

    const data = await readResponseJson(response, v.array(branchSchema), 'github.branches');
    allBranches.push(...data.map((b) => ({ name: b.name })));

    hasMore = data.length === perPage;
    page++;

    if (allBranches.length >= maxBranches) {
      log.warn('github_app.branch_safety_limit_reached', {
        owner,
        repo,
        branchCount: allBranches.length,
        maxBranches,
      });
      break;
    }
  }

  // Ensure default branch is always present and first in the list
  if (defaultBranch) {
    const hasDefault = allBranches.some((b) => b.name === defaultBranch);
    if (!hasDefault) {
      allBranches.unshift({ name: defaultBranch });
    } else {
      // Move default branch to front
      const filtered = allBranches.filter((b) => b.name !== defaultBranch);
      return [{ name: defaultBranch }, ...filtered];
    }
  }

  return allBranches;
}

/**
 * Ensure a branch exists in a repository. If the branch does not exist,
 * create it from the default branch.
 *
 * This is called before workspace provisioning to prevent git clone failures
 * when a task specifies a branch that hasn't been created yet.
 */
export async function ensureBranchExists(
  installationId: string,
  owner: string,
  repo: string,
  branchName: string,
  defaultBranch: string,
  env: Env
): Promise<EnsureBranchOutcome> {
  const { token } = await getInstallationToken(installationId, env);
  const headers: HeadersInit = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Simple-Agent-Manager',
  };

  // Check if the branch already exists
  const checkResp = await fetchWithTimeout(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodeURIComponent(branchName)}`,
    { headers }
  );

  if (checkResp.ok) {
    return { status: 'exists' };
  }

  if (checkResp.status !== 404) {
    // The lookup itself failed, so we learned nothing about the ref.
    log.warn('github.ensure_branch.check_failed', {
      owner,
      repo,
      branchName,
      status: checkResp.status,
    });
    return { status: 'unknown', reason: `branch lookup returned ${checkResp.status}` };
  }

  // Branch doesn't exist — get the SHA of the default branch
  const refResp = await fetchWithTimeout(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(defaultBranch)}`,
    { headers }
  );

  if (!refResp.ok) {
    log.warn('github.ensure_branch.default_branch_ref_failed', {
      owner,
      repo,
      defaultBranch,
      status: refResp.status,
    });
    // The branch is confirmed absent (404 above); we simply could not build it.
    return {
      status: 'missing',
      reason: `base branch "${defaultBranch}" could not be resolved (${refResp.status})`,
    };
  }

  const refData = (await refResp.json()) as { object?: { sha?: string } };
  const sha = refData.object?.sha;
  if (!sha) {
    log.warn('github.ensure_branch.no_sha', { owner, repo, defaultBranch });
    return {
      status: 'missing',
      reason: `base branch "${defaultBranch}" returned no commit SHA`,
    };
  }

  // Create the new branch
  const createResp = await fetchWithTimeout(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`,
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ref: `refs/heads/${branchName}`,
        sha,
      }),
    }
  );

  if (createResp.ok) {
    log.info('github.ensure_branch.created', {
      owner,
      repo,
      branchName,
      fromBranch: defaultBranch,
      sha,
    });
    return { status: 'created' };
  }

  if (createResp.status === 422) {
    // Race condition — another caller created the branch between our check and create
    log.info('github.ensure_branch.race_already_exists', { owner, repo, branchName });
    return { status: 'exists' };
  }

  const errorText = await createResp.text().catch(() => '');
  log.warn('github.ensure_branch.create_failed', {
    owner,
    repo,
    branchName,
    status: createResp.status,
    message: errorText.slice(0, 200),
  });
  return {
    status: 'missing',
    reason: `branch creation failed (${createResp.status})`,
  };
}

/**
 * Verify a webhook signature from GitHub.
 *
 * Uses `crypto.subtle.verify`, which performs the HMAC comparison in constant
 * time, instead of a string `===` of hex digests (which short-circuits on the
 * first differing character and is therefore timing-unsafe). The owner guard on
 * the `installation.created` webhook path depends on this signature check being
 * trustworthy, so it must not leak comparison timing.
 */
export async function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): Promise<boolean> {
  const prefix = 'sha256=';
  if (!signature.startsWith(prefix)) {
    return false;
  }
  const hex = signature.slice(prefix.length);
  // A SHA-256 HMAC is 32 bytes -> 64 hex chars. Reject anything malformed
  // before decoding so a bad header can't reach crypto.subtle.verify.
  if (hex.length !== 64 || !/^[0-9a-f]{64}$/i.test(hex)) {
    return false;
  }

  const signatureBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    signatureBytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );

  return crypto.subtle.verify('HMAC', key, signatureBytes, encoder.encode(payload));
}
