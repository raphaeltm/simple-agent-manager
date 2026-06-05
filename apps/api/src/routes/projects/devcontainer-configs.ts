import {
  DEVCONTAINER_CONFIG_NAME_MAX_LENGTH,
  DEVCONTAINER_CONFIG_NAME_REGEX,
} from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { getUserId } from '../../middleware/auth';
import { requireOwnedProject } from '../../middleware/project-auth';
import { getInstallationToken } from '../../services/github-app';
import { getExternalInstallationId } from '../../services/github-installation-ids';
import { requireOwnedInstallation } from './_helpers';

export interface DevcontainerConfigEntry {
  name: string;
  path: string;
}

export interface DevcontainerConfigsResponse {
  provider: 'github';
  repository: string;
  branch: string;
  defaultConfigExists: boolean;
  configs: DevcontainerConfigEntry[];
  truncated?: boolean;
}

interface UnsupportedResponse {
  unsupported: true;
  configs: [];
}

interface GitTreeEntry {
  path: string;
  type: string;
}

interface GitTreeResponse {
  tree: GitTreeEntry[];
  truncated: boolean;
}

interface GitHubContentsEntry {
  name: string;
  type: string;
}

const GITHUB_API_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'Simple-Agent-Manager',
} as const;

function isValidDevcontainerConfigName(name: string): boolean {
  return (
    DEVCONTAINER_CONFIG_NAME_REGEX.test(name) &&
    name.length <= DEVCONTAINER_CONFIG_NAME_MAX_LENGTH
  );
}

function makeGitHubHeaders(token: string): HeadersInit {
  return {
    ...GITHUB_API_HEADERS,
    Authorization: `Bearer ${token}`,
  };
}

function makeContentsUrl(owner: string, repo: string, path: string, branch: string): string {
  const encodedPath = path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');

  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`;
}

async function githubPathExists(
  owner: string,
  repo: string,
  path: string,
  branch: string,
  headers: HeadersInit,
): Promise<boolean> {
  const response = await fetch(makeContentsUrl(owner, repo, path, branch), { headers });
  return response.ok;
}

/**
 * Extract devcontainer config information from a GitHub git tree response.
 */
export function parseDevcontainerConfigs(tree: GitTreeEntry[]): {
  defaultConfigExists: boolean;
  configs: DevcontainerConfigEntry[];
} {
  let defaultConfigExists = false;
  const configs: DevcontainerConfigEntry[] = [];

  for (const entry of tree) {
    if (entry.type !== 'blob') continue;

    // Default configs — map to Auto-detect, not named dropdown options
    if (entry.path === '.devcontainer/devcontainer.json' || entry.path === '.devcontainer.json') {
      defaultConfigExists = true;
      continue;
    }

    // Named configs: .devcontainer/<name>/devcontainer.json
    const match = /^\.devcontainer\/([^/]+)\/devcontainer\.json$/.exec(entry.path);
    if (!match) continue;

    const name = match[1];
    if (!name) continue;

    // Validate name against shared constants
    if (!isValidDevcontainerConfigName(name)) continue;

    configs.push({ name, path: entry.path });
  }

  configs.sort((a, b) => a.name.localeCompare(b.name));
  return { defaultConfigExists, configs };
}

async function fetchDevcontainerDirectory(
  owner: string,
  repo: string,
  branch: string,
  headers: HeadersInit,
): Promise<GitHubContentsEntry[]> {
  const response = await fetch(makeContentsUrl(owner, repo, '.devcontainer', branch), { headers });
  if (!response.ok) return [];

  const entries = await response.json() as GitHubContentsEntry[];
  return Array.isArray(entries) ? entries : [];
}

async function findFallbackNamedConfigs(
  owner: string,
  repo: string,
  branch: string,
  headers: HeadersInit,
  entries: GitHubContentsEntry[],
): Promise<DevcontainerConfigEntry[]> {
  const configs: DevcontainerConfigEntry[] = [];

  for (const entry of entries) {
    if (entry.type !== 'dir' || !isValidDevcontainerConfigName(entry.name)) continue;

    const path = `.devcontainer/${entry.name}/devcontainer.json`;
    const exists = await githubPathExists(owner, repo, path, branch, headers);
    if (exists) {
      configs.push({ name: entry.name, path });
    }
  }

  return configs.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Fallback: query GitHub contents API when tree is truncated.
 */
async function fetchDevcontainerConfigsFallback(
  owner: string,
  repo: string,
  branch: string,
  token: string,
): Promise<{ defaultConfigExists: boolean; configs: DevcontainerConfigEntry[] }> {
  const headers = makeGitHubHeaders(token);
  const rootDefaultExists = await githubPathExists(owner, repo, '.devcontainer.json', branch, headers);
  const entries = await fetchDevcontainerDirectory(owner, repo, branch, headers);
  const directoryDefaultExists = entries.some(
    (entry) => entry.name === 'devcontainer.json' && entry.type === 'file',
  );
  const configs = await findFallbackNamedConfigs(owner, repo, branch, headers, entries);

  const defaultConfigExists = rootDefaultExists || directoryDefaultExists;
  return { defaultConfigExists, configs };
}

export async function discoverGitHubDevcontainerConfigs(
  owner: string,
  repo: string,
  branch: string,
  token: string,
): Promise<{ defaultConfigExists: boolean; configs: DevcontainerConfigEntry[]; truncated: boolean }> {
  const treeResp = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    {
      headers: {
        ...GITHUB_API_HEADERS,
        Authorization: `Bearer ${token}`,
      },
    },
  );

  if (!treeResp.ok) {
    const errBody = await treeResp.text().catch(() => '');
    throw new Error(`GitHub tree fetch failed: ${treeResp.status} ${errBody.slice(0, 200)}`.trim());
  }

  const treeData = await treeResp.json() as GitTreeResponse;

  if (treeData.truncated) {
    return {
      ...await fetchDevcontainerConfigsFallback(owner, repo, branch, token),
      truncated: true,
    };
  }

  return {
    ...parseDevcontainerConfigs(treeData.tree),
    truncated: false,
  };
}

const devcontainerConfigRoutes = new Hono<{ Bindings: Env }>();

devcontainerConfigRoutes.get('/:projectId/devcontainer-configs', async (c) => {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });
  const projectId = c.req.param('projectId');

  const project = await requireOwnedProject(db, projectId, userId);

  // Non-GitHub projects: return unsupported response
  if (project.repoProvider !== 'github') {
    return c.json({ unsupported: true, configs: [] } satisfies UnsupportedResponse);
  }

  // Parse owner/repo from project.repository
  const repoParts = project.repository.split('/');
  if (repoParts.length !== 2 || !repoParts[0] || !repoParts[1]) {
    return c.json({ unsupported: true, configs: [] } satisfies UnsupportedResponse);
  }
  const [owner, repo] = repoParts;
  const branch = project.defaultBranch;

  // Load the GitHub installation to get the external installation ID
  const installation = await requireOwnedInstallation(db, project.installationId, userId);
  const { token } = await getInstallationToken(getExternalInstallationId(installation), c.env);

  try {
    const { defaultConfigExists, configs, truncated } = await discoverGitHubDevcontainerConfigs(
      owner,
      repo,
      branch,
      token,
    );

    return c.json({
      provider: 'github',
      repository: project.repository,
      branch,
      defaultConfigExists,
      configs,
      ...(truncated ? { truncated } : {}),
    } satisfies DevcontainerConfigsResponse);
  } catch (err) {
    log.error('devcontainer_configs.unexpected_error', {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({ error: 'GITHUB_API_ERROR', message: 'Failed to discover devcontainer configs' }, 502);
  }
});

export { devcontainerConfigRoutes };
