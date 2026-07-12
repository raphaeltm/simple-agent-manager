import type { GitLabProject } from '@simple-agent-manager/shared';
import { eq } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';
import { type Context } from 'hono';
import * as v from 'valibot';

import { createAuth } from '../auth';
import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { readResponseJson } from '../lib/runtime-validation';
import { AppError, errors } from '../middleware/error';
import { fetchWithTimeout, getTimeoutMs } from './fetch-timeout';
import { getGitLabOAuthConfig } from './platform-config';

const MIN_GITLAB_WRITE_ACCESS_LEVEL = 30; // Developer

// Bound every GitLab API call so a slow or unreachable GitLab host cannot hold a
// Cloudflare Worker open indefinitely. Configurable via GITLAB_API_TIMEOUT_MS.
const DEFAULT_GITLAB_API_TIMEOUT_MS = 30_000;

const gitlabAccessSchema = v.object({
  access_level: v.number(),
});

const gitlabProjectSchema = v.object({
  id: v.number(),
  path_with_namespace: v.string(),
  name: v.string(),
  visibility: v.optional(v.string()),
  default_branch: v.optional(v.nullable(v.string())),
  web_url: v.optional(v.nullable(v.string())),
  http_url_to_repo: v.optional(v.nullable(v.string())),
  permissions: v.optional(
    v.nullable(
      v.object({
        project_access: v.optional(v.nullable(gitlabAccessSchema)),
        group_access: v.optional(v.nullable(gitlabAccessSchema)),
      })
    )
  ),
});

const gitlabBranchSchema = v.object({
  name: v.string(),
  default: v.optional(v.boolean()),
});

const gitlabTreeEntrySchema = v.object({
  path: v.string(),
  name: v.string(),
  type: v.string(),
  size: v.optional(v.nullable(v.number())),
});

const gitlabFileSchema = v.object({
  file_path: v.string(),
  size: v.number(),
  encoding: v.string(),
  content: v.string(),
});

const gitlabCompareSchema = v.object({
  diffs: v.optional(
    v.array(
      v.object({
        old_path: v.string(),
        new_path: v.string(),
        new_file: v.optional(v.boolean()),
        renamed_file: v.optional(v.boolean()),
        deleted_file: v.optional(v.boolean()),
        diff: v.optional(v.nullable(v.string())),
        too_large: v.optional(v.boolean()),
        collapsed: v.optional(v.boolean()),
        binary: v.optional(v.boolean()),
      })
    )
  ),
});

type GitLabProjectApi = v.InferOutput<typeof gitlabProjectSchema>;
type GitLabTreeEntryApi = v.InferOutput<typeof gitlabTreeEntrySchema>;
type GitLabFileApi = v.InferOutput<typeof gitlabFileSchema>;
type GitLabCompareApi = v.InferOutput<typeof gitlabCompareSchema>;

export type GitLabRepositoryMetadata = {
  host: string;
  gitlabProjectId: number;
  pathWithNamespace: string;
  webUrl: string | null;
  httpUrlToRepo: string;
  defaultBranch: string;
};

/** GitLabRepositoryMetadata plus the owning user, as stored in D1. */
export type StoredGitLabRepositoryMetadata = GitLabRepositoryMetadata & {
  userId: string;
};

export type GitLabAccessTokenResult = {
  accessToken: string;
  /** ISO timestamp of access-token expiry, or null when the provider did not report one. */
  accessTokenExpiresAt: string | null;
};

type TokenResult = {
  accessToken: string | null | undefined;
  accessTokenExpiresAt?: Date | string | null;
  scopes?: string[];
};

function isExpired(expiresAt: Date | string | null | undefined): boolean {
  if (!expiresAt) {
    return false;
  }
  const expiresAtMs = new Date(expiresAt).getTime();
  return Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();
}

function availableAccessToken(
  token: TokenResult,
  flow: string,
  userId: string
): GitLabAccessTokenResult | null {
  if (!token.accessToken) {
    return null;
  }
  const expiresAtIso = token.accessTokenExpiresAt
    ? new Date(token.accessTokenExpiresAt).toISOString()
    : null;
  if (isExpired(token.accessTokenExpiresAt)) {
    log.warn('gitlab.user_access_token_expired', {
      flow,
      userId,
      tokenPresent: true,
      accessTokenExpiresAt: expiresAtIso,
    });
    return null;
  }
  return { accessToken: token.accessToken, accessTokenExpiresAt: expiresAtIso };
}

const lockedTokenResponseSchema = v.object({
  accessToken: v.nullable(v.string()),
  accessTokenExpiresAt: v.nullable(v.string()),
  scopes: v.optional(v.array(v.string())),
});

async function getDirectGitLabUserAccessTokenResultWithHeaders(
  env: Env,
  headers: Headers,
  userId: string,
  flow: string
): Promise<GitLabAccessTokenResult | null> {
  try {
    const auth = await createAuth(env);
    const token = await auth.api.getAccessToken({
      headers,
      body: { providerId: 'gitlab', userId },
    });
    log.info('gitlab.user_access_token.lookup', {
      flow,
      userId,
      tokenPresent: Boolean(token.accessToken),
      scopes: token.scopes,
    });
    return availableAccessToken(token, flow, userId);
  } catch (err) {
    log.warn('gitlab.user_access_token_unavailable', {
      flow,
      userId,
      tokenPresent: false,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Resolve the user's GitLab OAuth access token, serializing lookup/refresh per
 * user through the GitLabUserAccessTokenLock Durable Object. GitLab refresh
 * tokens are rotating and single-use — two concurrent refreshes replay a
 * consumed refresh token and revoke the whole token family upstream, so the
 * entire BetterAuth getAccessToken call must run inside the per-user lock.
 * Falls back to the direct (unlocked) path only when the DO binding is absent
 * (local dev / Miniflare without the binding configured).
 */
export async function getGitLabUserAccessTokenResultWithHeaders(
  env: Env,
  headers: Headers,
  userId: string,
  flow: string
): Promise<GitLabAccessTokenResult | null> {
  if (!env.GITLAB_USER_ACCESS_TOKEN_LOCK) {
    // Without the DO lock, concurrent refreshes can replay a consumed rotating
    // refresh token and revoke the token family upstream. Acceptable only in
    // local dev / test harnesses that lack the binding — never in deployment.
    log.warn('gitlab.user_access_token_lock_binding_absent', {
      flow,
      userId,
      action: 'unserialized_direct_lookup',
    });
    return getDirectGitLabUserAccessTokenResultWithHeaders(env, headers, userId, flow);
  }
  try {
    const id = env.GITLAB_USER_ACCESS_TOKEN_LOCK.idFromName(userId);
    const stub = env.GITLAB_USER_ACCESS_TOKEN_LOCK.get(id);
    const response = await stub.fetch('https://gitlab-user-access-token-lock/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        flow,
        headers: Array.from(headers.entries()),
      }),
    });
    if (!response.ok) {
      log.warn('gitlab.user_access_token_unavailable', {
        flow,
        userId,
        tokenPresent: false,
        status: response.status,
      });
      return null;
    }
    const token = await readResponseJson(
      response,
      lockedTokenResponseSchema,
      'gitlab.user_access_token.locked'
    );
    log.info('gitlab.user_access_token.lookup', {
      flow,
      userId,
      tokenPresent: Boolean(token.accessToken),
      scopes: token.scopes,
    });
    return availableAccessToken(token, flow, userId);
  } catch (err) {
    log.warn('gitlab.user_access_token_unavailable', {
      flow,
      userId,
      tokenPresent: false,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function getGitLabUserAccessTokenWithHeaders(
  env: Env,
  headers: Headers,
  userId: string,
  flow: string
): Promise<string | null> {
  const result = await getGitLabUserAccessTokenResultWithHeaders(env, headers, userId, flow);
  return result?.accessToken ?? null;
}

export async function getGitLabUserAccessToken(
  c: Context<{ Bindings: Env }>,
  userId: string
): Promise<string | null> {
  return getGitLabUserAccessTokenWithHeaders(c.env, c.req.raw.headers, userId, 'request');
}

export async function getGitLabUserAccessTokenForOwner(
  env: Env,
  userId: string,
  flow = 'owner-callback'
): Promise<string | null> {
  return getGitLabUserAccessTokenWithHeaders(env, new Headers(), userId, flow);
}

export async function requireGitLabUserAccessToken(
  c: Context<{ Bindings: Env }>,
  userId: string
): Promise<string> {
  const accessToken = await getGitLabUserAccessToken(c, userId);
  if (!accessToken) {
    throw new AppError(
      401,
      'GITLAB_REAUTH_REQUIRED',
      'Your GitLab authorization has expired - please sign out and back in'
    );
  }
  return accessToken;
}

export async function requireGitLabUserAccessTokenForOwner(
  env: Env,
  userId: string,
  flow = 'owner-callback'
): Promise<string> {
  const result = await requireGitLabUserAccessTokenResultForOwner(env, userId, flow);
  return result.accessToken;
}

export async function requireGitLabUserAccessTokenResultForOwner(
  env: Env,
  userId: string,
  flow = 'owner-callback'
): Promise<GitLabAccessTokenResult> {
  const result = await getGitLabUserAccessTokenResultWithHeaders(env, new Headers(), userId, flow);
  if (!result) {
    throw new AppError(
      401,
      'GITLAB_REAUTH_REQUIRED',
      'Your GitLab authorization has expired - please sign out and back in'
    );
  }
  return result;
}

async function getGitLabApiBase(env: Env): Promise<{ host: string; apiBaseUrl: string }> {
  const config = await getGitLabOAuthConfig(env);
  if (!config) {
    throw errors.badRequest('GitLab is not configured on this deployment');
  }
  return { host: config.host, apiBaseUrl: config.apiBaseUrl };
}

async function gitlabFetch(
  env: Env,
  accessToken: string,
  pathAndQuery: string,
  init?: RequestInit
): Promise<Response> {
  const { apiBaseUrl } = await getGitLabApiBase(env);
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${accessToken}`);
  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json');
  }
  const timeoutMs = getTimeoutMs(env.GITLAB_API_TIMEOUT_MS, DEFAULT_GITLAB_API_TIMEOUT_MS);
  return fetchWithTimeout(
    `${apiBaseUrl}${pathAndQuery}`,
    {
      ...init,
      headers,
    },
    timeoutMs
  );
}

function encodeProjectId(projectId: number | string): string {
  return encodeURIComponent(String(projectId));
}

function encodeFilePath(path: string): string {
  return path
    .split('/')
    .filter((part) => part.length > 0)
    .map((part) => encodeURIComponent(part))
    .join('%2F');
}

function maxAccessLevel(project: GitLabProjectApi): number {
  const permissions = project.permissions;
  return Math.max(
    permissions?.project_access?.access_level ?? 0,
    permissions?.group_access?.access_level ?? 0
  );
}

function mapGitLabProject(project: GitLabProjectApi): GitLabProject {
  return {
    id: project.id,
    pathWithNamespace: project.path_with_namespace,
    name: project.name,
    private: project.visibility !== 'public',
    defaultBranch: project.default_branch || 'main',
    webUrl: project.web_url ?? null,
    httpUrlToRepo: project.http_url_to_repo ?? null,
  };
}

function gitLabRepositoryHost(configHost: string): string {
  const trimmed = configHost.trim().replace(/\/+$/, '');
  try {
    return new URL(trimmed).host.toLowerCase();
  } catch {
    return (
      trimmed
        .replace(/^https?:\/\//i, '')
        .split('/')[0]
        ?.toLowerCase() ?? trimmed
    );
  }
}

function gitLabWebOrigin(configHost: string): string {
  const trimmed = configHost.trim().replace(/\/+$/, '');
  try {
    return new URL(trimmed).origin;
  } catch {
    return `https://${gitLabRepositoryHost(trimmed)}`;
  }
}

function mapProjectMetadata(
  configHost: string,
  project: GitLabProjectApi
): GitLabRepositoryMetadata {
  const defaultBranch = project.default_branch?.trim();
  const pathWithNamespace = project.path_with_namespace.trim();
  if (!defaultBranch) {
    throw errors.badRequest('Selected GitLab project does not have a default branch');
  }
  if (!pathWithNamespace) {
    throw errors.badRequest('Selected GitLab project is missing its path');
  }
  const cloneUrl =
    project.http_url_to_repo?.trim() || `${gitLabWebOrigin(configHost)}/${pathWithNamespace}.git`;
  return {
    host: gitLabRepositoryHost(configHost),
    gitlabProjectId: project.id,
    pathWithNamespace,
    webUrl: project.web_url ?? null,
    httpUrlToRepo: cloneUrl,
    defaultBranch,
  };
}

export async function listGitLabProjects(
  env: Env,
  accessToken: string,
  search?: string
): Promise<GitLabProject[]> {
  const params = new URLSearchParams({
    membership: 'true',
    simple: 'false',
    order_by: 'last_activity_at',
    sort: 'desc',
    per_page: '100',
  });
  const trimmedSearch = search?.trim();
  if (trimmedSearch) {
    params.set('search', trimmedSearch);
  }
  const res = await gitlabFetch(env, accessToken, `/projects?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`GitLab project list failed: ${res.status}`);
  }
  const rows = await readResponseJson(res, v.array(gitlabProjectSchema), 'gitlab.projects');
  return rows
    .filter((project) => maxAccessLevel(project) >= MIN_GITLAB_WRITE_ACCESS_LEVEL)
    .map(mapGitLabProject);
}

export async function getGitLabProject(
  env: Env,
  accessToken: string,
  projectId: number
): Promise<GitLabProjectApi> {
  const res = await gitlabFetch(env, accessToken, `/projects/${encodeProjectId(projectId)}`);
  if (res.status === 404) {
    throw errors.notFound('GitLab project not found');
  }
  if (!res.ok) {
    throw new Error(`GitLab project lookup failed: ${res.status}`);
  }
  return readResponseJson(res, gitlabProjectSchema, 'gitlab.project');
}

export async function verifyGitLabProjectAccess(
  env: Env,
  accessToken: string,
  projectId: number
): Promise<GitLabRepositoryMetadata> {
  const { host } = await getGitLabApiBase(env);
  const project = await getGitLabProject(env, accessToken, projectId);
  if (maxAccessLevel(project) < MIN_GITLAB_WRITE_ACCESS_LEVEL) {
    throw errors.forbidden('GitLab project requires Developer access or higher');
  }
  return mapProjectMetadata(host, project);
}

export async function listGitLabBranches(
  env: Env,
  accessToken: string,
  projectId: number
): Promise<Array<{ name: string; isDefault: boolean }>> {
  const params = new URLSearchParams({ per_page: '100' });
  const res = await gitlabFetch(
    env,
    accessToken,
    `/projects/${encodeProjectId(projectId)}/repository/branches?${params.toString()}`
  );
  if (!res.ok) {
    throw new Error(`GitLab branches fetch failed: ${res.status}`);
  }
  const rows = await readResponseJson(res, v.array(gitlabBranchSchema), 'gitlab.branches');
  return rows.map((branch) => ({ name: branch.name, isDefault: Boolean(branch.default) }));
}

export async function getGitLabTree(
  env: Env,
  accessToken: string,
  projectId: number,
  ref: string
): Promise<{ entries: GitLabTreeEntryApi[]; truncated: boolean }> {
  const params = new URLSearchParams({
    ref,
    recursive: 'true',
    per_page: '100',
  });
  const res = await gitlabFetch(
    env,
    accessToken,
    `/projects/${encodeProjectId(projectId)}/repository/tree?${params.toString()}`
  );
  if (!res.ok) {
    throw new Error(`GitLab tree fetch failed: ${res.status}`);
  }
  const entries = await readResponseJson(res, v.array(gitlabTreeEntrySchema), 'gitlab.tree');
  return { entries, truncated: Boolean(res.headers.get('x-next-page')) };
}

export async function getGitLabFile(
  env: Env,
  accessToken: string,
  projectId: number,
  ref: string,
  path: string
): Promise<GitLabFileApi> {
  const params = new URLSearchParams({ ref });
  const res = await gitlabFetch(
    env,
    accessToken,
    `/projects/${encodeProjectId(projectId)}/repository/files/${encodeFilePath(path)}?${params.toString()}`
  );
  if (res.status === 404) {
    throw new Error('File not found');
  }
  if (!res.ok) {
    throw new Error(`GitLab file fetch failed: ${res.status}`);
  }
  return readResponseJson(res, gitlabFileSchema, 'gitlab.file');
}

export async function getGitLabRawFile(
  env: Env,
  accessToken: string,
  projectId: number,
  ref: string,
  path: string
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const params = new URLSearchParams({ ref });
  const res = await gitlabFetch(
    env,
    accessToken,
    `/projects/${encodeProjectId(projectId)}/repository/files/${encodeFilePath(path)}/raw?${params.toString()}`,
    { headers: { Accept: '*/*' } }
  );
  if (res.status === 404) {
    throw new Error('File not found');
  }
  if (!res.ok) {
    throw new Error(`GitLab raw file fetch failed: ${res.status}`);
  }
  return {
    bytes: new Uint8Array(await res.arrayBuffer()),
    contentType: res.headers.get('content-type') || 'application/octet-stream',
  };
}

export async function compareGitLabRefs(
  env: Env,
  accessToken: string,
  projectId: number,
  base: string,
  head: string
): Promise<GitLabCompareApi> {
  const params = new URLSearchParams({ from: base, to: head, straight: 'false' });
  const res = await gitlabFetch(
    env,
    accessToken,
    `/projects/${encodeProjectId(projectId)}/repository/compare?${params.toString()}`
  );
  if (!res.ok) {
    throw new Error(`GitLab compare failed: ${res.status}`);
  }
  return readResponseJson(res, gitlabCompareSchema, 'gitlab.compare');
}

export async function ensureGitLabBranchExists(input: {
  env: Env;
  userId: string;
  projectId: number;
  branch: string;
  ref: string;
  flow?: string;
}): Promise<boolean> {
  const accessToken = await requireGitLabUserAccessTokenForOwner(
    input.env,
    input.userId,
    input.flow ?? 'gitlab-branch-ensure'
  );
  const branchPath = `/projects/${encodeProjectId(input.projectId)}/repository/branches/${encodeURIComponent(input.branch)}`;
  const existing = await gitlabFetch(input.env, accessToken, branchPath);
  if (existing.ok) {
    return false;
  }
  if (existing.status !== 404) {
    throw new Error(`GitLab branch lookup failed: ${existing.status}`);
  }

  const params = new URLSearchParams({ branch: input.branch, ref: input.ref });
  const created = await gitlabFetch(
    input.env,
    accessToken,
    `/projects/${encodeProjectId(input.projectId)}/repository/branches?${params.toString()}`,
    { method: 'POST' }
  );
  if (!created.ok) {
    throw new Error(`GitLab branch create failed: ${created.status}`);
  }
  return true;
}

export async function getProjectGitLabRepository(
  db: ReturnType<typeof drizzle<typeof schema>>,
  projectId: string
): Promise<StoredGitLabRepositoryMetadata | null> {
  const rows = await db
    .select({
      userId: schema.projectGitlabRepositories.userId,
      host: schema.projectGitlabRepositories.host,
      gitlabProjectId: schema.projectGitlabRepositories.gitlabProjectId,
      pathWithNamespace: schema.projectGitlabRepositories.pathWithNamespace,
      webUrl: schema.projectGitlabRepositories.webUrl,
      httpUrlToRepo: schema.projectGitlabRepositories.httpUrlToRepo,
      defaultBranch: schema.projectGitlabRepositories.defaultBranch,
    })
    .from(schema.projectGitlabRepositories)
    .where(eq(schema.projectGitlabRepositories.projectId, projectId))
    .limit(1);
  const row = rows[0];
  return row
    ? {
        userId: row.userId,
        host: row.host,
        gitlabProjectId: row.gitlabProjectId,
        pathWithNamespace: row.pathWithNamespace,
        webUrl: row.webUrl,
        httpUrlToRepo: row.httpUrlToRepo,
        defaultBranch: row.defaultBranch,
      }
    : null;
}
