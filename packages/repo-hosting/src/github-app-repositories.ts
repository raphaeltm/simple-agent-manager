import type { Env } from '../env';
import { log } from '../lib/logger';
import { readResponseJson } from '../lib/runtime-validation';
import { fetchWithTimeout } from './fetch-timeout';
import {
  type GitHubRepositoryMetadata,
  type GitmoduleEntry,
  readGitHubError,
  repositorySchema,
} from './github-app-common';
import { getInstallationToken } from './github-app-tokens';

/**
 * Fetch a repository's stable numeric id, node id, and canonical full name using
 * an installation token (no user token required). Used to backfill `github_repo_id`
 * for legacy GitHub-backed projects created before the id was captured.
 *
 * Returns `null` when the repository is inaccessible (404 repo deleted/never-installed,
 * or 403 permission) so callers can fall back to name-based scoping without throwing.
 * Throws on other unexpected errors (auth/rate-limit) so they surface loudly.
 *
 * Pass `installationToken` to reuse an already-minted installation token (the bulk
 * backfill mints one token per installation and reuses it across that installation's
 * repos to stay under GitHub's installation-token rate limit). When omitted, a token
 * is minted on demand.
 */
export async function getRepositoryMetadata(
  installationId: string,
  owner: string,
  repo: string,
  env: Env,
  installationToken?: string
): Promise<GitHubRepositoryMetadata | null> {
  const token = installationToken ?? (await getInstallationToken(installationId, env)).token;

  const response = await fetchWithTimeout(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Simple-Agent-Manager',
      },
    }
  );

  if (response.status === 404 || response.status === 403) {
    log.warn('github_app.repo_metadata_inaccessible', {
      installationId,
      owner,
      repo,
      status: response.status,
    });
    return null;
  }

  if (!response.ok) {
    throw new Error(
      await readGitHubError(response, `Failed to get repository metadata: ${response.status}`)
    );
  }

  const data = await readResponseJson(response, repositorySchema, 'github.repository_metadata');
  return {
    id: data.id,
    nodeId: data.node_id ?? null,
    fullName: data.full_name,
  };
}

/**
 * Parse `.gitmodules` content into submodule entries, resolving GitHub repository
 * full names from each submodule URL. Supports https, ssh, and relative URLs.
 *
 * Relative URLs (e.g. `../sibling.git`) resolve against the parent repository's
 * owner (`parentOwner`), matching git's own relative-submodule resolution against
 * the configured `origin`.
 *
 * Entries whose URL is not a parseable GitHub repository yield `repository: null`
 * so callers can surface an `unsupported-url` status rather than silently dropping
 * them.
 */
export function parseGitmodules(content: string, parentOwner: string): GitmoduleEntry[] {
  const entries: GitmoduleEntry[] = [];
  let currentPath: string | null = null;
  let currentUrl: string | null = null;

  const flush = () => {
    if (currentPath && currentUrl) {
      entries.push({
        path: currentPath,
        repository: resolveGitmoduleRepository(currentUrl, parentOwner),
      });
    }
    currentPath = null;
    currentUrl = null;
  };

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('[submodule')) {
      flush();
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    if (key === 'path') currentPath = value;
    else if (key === 'url') currentUrl = value;
  }
  flush();

  return entries;
}

/** Resolve a `.gitmodules` URL to a GitHub `owner/repo` full name, or null. */
export function resolveGitmoduleRepository(url: string, parentOwner: string): string | null {
  const stripGit = (s: string) => s.replace(/\.git$/, '');

  // Relative URL (resolved against origin owner).
  if (url.startsWith('./') || url.startsWith('../')) {
    const segments = url.split('/').filter((s) => s && s !== '.');
    // A relative submodule URL points at a sibling repo: the last segment is the
    // repo name and `..` climbs out of the parent repo to the owner level.
    const repoName = stripGit(segments[segments.length - 1] ?? '');
    if (!repoName) return null;
    return `${parentOwner}/${repoName}`.toLowerCase();
  }

  // scp-like ssh URL: git@github.com:owner/repo.git
  const sshMatch = url.match(/^[^@]+@github\.com:([^/]+)\/(.+)$/);
  if (sshMatch?.[1] && sshMatch[2]) {
    return `${sshMatch[1]}/${stripGit(sshMatch[2])}`.toLowerCase();
  }

  // https/ssh URL with explicit host.
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'github.com') return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    const owner = parts[0];
    const repo = parts[1];
    if (!owner || !repo) return null;
    return `${owner}/${stripGit(repo)}`.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Fetch and parse a repository's `.gitmodules` file via an installation token.
 * Returns an empty array when the repo has no `.gitmodules` (404). Throws on
 * unexpected GitHub errors so auth/rate-limit failures surface loudly.
 */
export async function getRepositoryGitmodules(
  installationId: string,
  owner: string,
  repo: string,
  parentOwner: string,
  env: Env,
  ref?: string
): Promise<GitmoduleEntry[]> {
  const { token } = await getInstallationToken(installationId, env);
  const refQuery = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const response = await fetchWithTimeout(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/.gitmodules${refQuery}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.raw+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Simple-Agent-Manager',
      },
    }
  );

  if (response.status === 404) {
    return [];
  }
  if (!response.ok) {
    throw new Error(
      await readGitHubError(response, `Failed to fetch .gitmodules: ${response.status}`)
    );
  }

  const content = await response.text();
  return parseGitmodules(content, parentOwner);
}
