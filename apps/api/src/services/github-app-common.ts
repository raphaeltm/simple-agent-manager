import * as v from 'valibot';

import { readResponseJson } from '../lib/runtime-validation';
import { AppError } from '../middleware/error';

export const githubErrorSchema = v.object({
  message: v.optional(v.string()),
});

export const installationTokenSchema = v.object({
  token: v.string(),
  expires_at: v.string(),
});

export const repositorySchema = v.object({
  id: v.number(),
  node_id: v.optional(v.string()),
  full_name: v.string(),
  private: v.boolean(),
  default_branch: v.string(),
});

export const installationRepositoriesSchema = v.object({
  repositories: v.array(repositorySchema),
  total_count: v.number(),
});

export const userInstallationSchema = v.object({
  id: v.number(),
  account: v.object({
    id: v.optional(v.number()),
    login: v.string(),
    type: v.string(),
  }),
});

export const DEFAULT_GITHUB_INSTALLATION_TOKEN_CACHE_TTL_SECONDS = 50 * 60;

export const userInstallationsSchema = v.object({
  installations: v.array(userInstallationSchema),
});

export const authenticatedGitHubUserSchema = v.object({
  id: v.number(),
  login: v.string(),
});

export const installationDetailSchema = v.object({
  account: v.nullable(
    v.object({
      id: v.optional(v.number()),
      login: v.optional(v.string()),
      type: v.optional(v.string()),
    })
  ),
});

export const branchSchema = v.object({
  name: v.string(),
});

export const githubOrgSchema = v.object({
  login: v.string(),
});

export async function readGitHubError(response: Response, fallback: string): Promise<string> {
  try {
    const error = await readResponseJson(response, githubErrorSchema, 'github.error');
    return error.message || fallback;
  } catch {
    return fallback;
  }
}

export async function githubRepositoryAccessError(response: Response): Promise<AppError> {
  if (response.status === 401) {
    return new AppError(
      401,
      'GITHUB_REAUTH_REQUIRED',
      'Your GitHub authorization has expired — please sign out and back in'
    );
  }
  if (response.status === 403) {
    const message = await readGitHubError(
      response,
      'GitHub denied access to this repository or installation'
    );
    return new AppError(403, 'GITHUB_FORBIDDEN', message);
  }
  const message = await readGitHubError(response, `GitHub API request failed: ${response.status}`);
  return new AppError(response.status >= 500 ? 502 : response.status, 'GITHUB_API_ERROR', message, {
    githubStatus: response.status,
  });
}

export interface UserAccessibleInstallation {
  id: number;
  account: { id?: number; login: string; type: string };
}

export interface AuthenticatedGitHubUser {
  id: number;
  login: string;
}

export interface GitHubRepositoryAccess {
  id: number;
  nodeId: string | null;
  fullName: string;
  private: boolean;
  defaultBranch: string;
}

export interface GitHubUserOrganization {
  login: string;
}

export interface UserAccessibleInstallationsDiagnostics {
  callerSignal?: AbortSignal;
  timeoutMs?: number;
  flow: 'callback' | 'sync';
  userId?: string;
  installationId?: string;
}

export interface UserInstallationRepositoriesDiagnostics {
  callerSignal?: AbortSignal;
  timeoutMs?: number;
  flow: 'repositories' | 'branches' | 'project-access' | 'project-invite';
  userId: string;
  installationId: string;
  repository?: string;
}

export interface UserOrganizationDiagnostics {
  callerSignal?: AbortSignal;
  timeoutMs?: number;
  flow: 'shared-org-discovery';
  userId: string;
}

export interface UserInstallationAccessDiagnostics {
  callerSignal?: AbortSignal;
  timeoutMs?: number;
  flow: 'shared-org-discovery';
  userId: string;
  installationId: string;
  accountName?: string;
}

export interface AuthenticatedGitHubUserDiagnostics {
  callerSignal?: AbortSignal;
  timeoutMs?: number;
  flow: 'callback' | 'sync';
  userId: string;
}

/** GitHub App installation tokens expire one hour after they are minted. */
export const GITHUB_INSTALLATION_TOKEN_LIFETIME_SECONDS = 60 * 60;

export const DEFAULT_GITHUB_INSTALLATION_TOKEN_REFRESH_MARGIN_SECONDS = 5 * 60;

/**
 * A refresh margin may consume at most half a token's lifetime. A larger margin
 * leaves the cache almost nothing to serve, so nearly every git credential
 * exchange would mint a new installation token.
 */
export const MAX_GITHUB_INSTALLATION_TOKEN_REFRESH_MARGIN_SECONDS =
  GITHUB_INSTALLATION_TOKEN_LIFETIME_SECONDS / 2;

/** Canonical GitHub account identity for an installation (resolved via the App API). */
export interface InstallationAccount {
  id: number | null;
  login: string | null;
  type: string | null;
}

// Existing user-installation scan limits; hints use the same derived page bound.
export const GITHUB_REPOSITORY_PAGE_SIZE = 100;

export const GITHUB_REPOSITORY_SCAN_LIMIT = 10_000;

export const GITHUB_REPOSITORY_MAX_PAGE = Math.ceil(
  GITHUB_REPOSITORY_SCAN_LIMIT / GITHUB_REPOSITORY_PAGE_SIZE
);

export function githubUserTokenHeaders(accessToken: string): HeadersInit {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Simple-Agent-Manager',
  };
}

export const DEFAULT_MAX_BRANCHES_PER_REPO = 5000;

export interface GitHubRepositoryMetadata {
  id: number;
  nodeId: string | null;
  fullName: string;
}

/** A submodule entry parsed from a repository's `.gitmodules` file. */
export interface GitmoduleEntry {
  /** Submodule path within the parent repo (from `.gitmodules`). */
  path: string;
  /** Full repository name parsed from the URL, e.g. "octocat/lib", or null when the
   *  URL could not be parsed as a GitHub repository (non-GitHub host, malformed). */
  repository: string | null;
}

/**
 * Outcome of an ensure-branch attempt.
 *
 * `missing` and `unknown` both mean "the branch is not known to be on the
 * remote", but callers must treat them differently: `missing` is positive
 * evidence that a `git clone --branch` will fail (the ref was confirmed absent
 * and could not be created), while `unknown` means the check itself could not
 * run. Only `missing` justifies refusing to provision — see
 * `services/workspace-branch.ts`.
 */
export type EnsureBranchOutcome =
  | { status: 'exists' }
  | { status: 'created' }
  | { status: 'missing'; reason: string }
  | { status: 'unknown'; reason: string };
