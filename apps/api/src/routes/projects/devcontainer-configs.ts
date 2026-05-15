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
    const match = entry.path.match(/^\.devcontainer\/([^/]+)\/devcontainer\.json$/);
    if (!match) continue;

    const name = match[1]!;

    // Validate name against shared constants
    if (!DEVCONTAINER_CONFIG_NAME_REGEX.test(name)) continue;
    if (name.length > DEVCONTAINER_CONFIG_NAME_MAX_LENGTH) continue;

    configs.push({ name, path: entry.path });
  }

  configs.sort((a, b) => a.name.localeCompare(b.name));
  return { defaultConfigExists, configs };
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
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Simple-Agent-Manager',
  };

  let defaultConfigExists = false;
  const configs: DevcontainerConfigEntry[] = [];

  // Check root .devcontainer.json
  const rootResp = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/.devcontainer.json?ref=${encodeURIComponent(branch)}`,
    { headers },
  );
  if (rootResp.ok) {
    defaultConfigExists = true;
  }

  // Check .devcontainer directory
  const dirResp = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/.devcontainer?ref=${encodeURIComponent(branch)}`,
    { headers },
  );

  if (dirResp.ok) {
    const entries = await dirResp.json() as Array<{ name: string; type: string }>;
    for (const entry of entries) {
      if (entry.name === 'devcontainer.json' && entry.type === 'file') {
        defaultConfigExists = true;
        continue;
      }
      if (entry.type !== 'dir') continue;

      const name = entry.name;
      if (!DEVCONTAINER_CONFIG_NAME_REGEX.test(name)) continue;
      if (name.length > DEVCONTAINER_CONFIG_NAME_MAX_LENGTH) continue;

      // Check if subdirectory contains devcontainer.json
      const subResp = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/.devcontainer/${encodeURIComponent(name)}/devcontainer.json?ref=${encodeURIComponent(branch)}`,
        { headers },
      );
      if (subResp.ok) {
        configs.push({
          name,
          path: `.devcontainer/${name}/devcontainer.json`,
        });
      }
    }
  }

  configs.sort((a, b) => a.name.localeCompare(b.name));
  return { defaultConfigExists, configs };
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
  const { token } = await getInstallationToken(installation.installationId, c.env);

  try {
    // Fetch the repo tree recursively
    const treeResp = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'Simple-Agent-Manager',
        },
      },
    );

    if (!treeResp.ok) {
      const errBody = await treeResp.text().catch(() => '');
      log.warn('devcontainer_configs.github_tree_error', {
        projectId,
        status: treeResp.status,
        body: errBody.slice(0, 200),
      });
      return c.json({ error: 'GITHUB_API_ERROR', message: 'Failed to fetch repository tree' }, 502);
    }

    const treeData = await treeResp.json() as GitTreeResponse;

    // If tree is truncated, fall back to contents API
    if (treeData.truncated) {
      const fallbackResult = await fetchDevcontainerConfigsFallback(owner, repo, branch, token);
      return c.json({
        provider: 'github',
        repository: project.repository,
        branch,
        defaultConfigExists: fallbackResult.defaultConfigExists,
        configs: fallbackResult.configs,
        truncated: true,
      } satisfies DevcontainerConfigsResponse);
    }

    const { defaultConfigExists, configs } = parseDevcontainerConfigs(treeData.tree);

    return c.json({
      provider: 'github',
      repository: project.repository,
      branch,
      defaultConfigExists,
      configs,
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
