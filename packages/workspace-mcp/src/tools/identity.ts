/**
 * Identity & Orientation tools.
 *
 * - get_workspace_info: consolidated workspace metadata
 * - get_credential_status: available credentials and their validity
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import type { WorkspaceMcpConfig } from '../config.js';
import type { ApiClient } from '../api-client.js';

const execAsync = promisify(exec);

export async function getWorkspaceInfo(
  config: WorkspaceMcpConfig,
  _apiClient: ApiClient,
) {
  // Determine mode from available env vars
  const mode = config.taskId ? 'task' : 'conversation';

  // Get uptime from /proc/uptime if available
  let uptimeSeconds: number | null = null;
  try {
    const content = await fs.readFile('/proc/uptime', 'utf-8');
    const match = content.match(/^([\d.]+)/);
    if (match?.[1]) {
      uptimeSeconds = Math.floor(parseFloat(match[1]));
    }
  } catch {
    // Not available (not on Linux or no access)
  }

  // Get current git branch
  let currentBranch = config.branch;
  if (!currentBranch) {
    try {
      const { stdout } = await execAsync(
        'git rev-parse --abbrev-ref HEAD 2>/dev/null',
        { timeout: 3000 },
      );
      currentBranch = stdout.trim();
    } catch {
      // git not available
    }
  }

  return {
    workspaceId: config.workspaceId,
    nodeId: config.nodeId,
    projectId: config.projectId,
    repository: config.repository,
    branch: currentBranch,
    mode,
    taskId: config.taskId || null,
    chatSessionId: config.chatSessionId || null,
    workspaceUrl: config.workspaceUrl,
    apiUrl: config.apiUrl,
    baseDomain: config.baseDomain,
    uptimeSeconds,
  };
}

export async function getCredentialStatus(
  config: WorkspaceMcpConfig,
  _apiClient: ApiClient,
) {
  const credentials: Array<{
    name: string;
    type: string;
    available: boolean;
    hint: string;
  }> = [];

  // GitHub token
  const ghToken = process.env['GH_TOKEN'] ?? '';
  credentials.push({
    name: 'GH_TOKEN',
    type: 'github-pat',
    available: ghToken.length > 0,
    hint: ghToken.length > 0
      ? `Token present (${ghToken.length} chars, prefix: ${ghToken.slice(0, 4)}...)`
      : 'Not set — GitHub API calls will fail',
  });

  // Anthropic API key
  const anthropicKey = process.env['ANTHROPIC_API_KEY'] ?? '';
  credentials.push({
    name: 'ANTHROPIC_API_KEY',
    type: 'api-key',
    available: anthropicKey.length > 0,
    hint: anthropicKey.length > 0
      ? 'API key present'
      : 'Not set (may be using OAuth token instead)',
  });

  // Claude Code OAuth token
  const oauthToken = process.env['CLAUDE_CODE_OAUTH_TOKEN'] ?? '';
  credentials.push({
    name: 'CLAUDE_CODE_OAUTH_TOKEN',
    type: 'oauth-token',
    available: oauthToken.length > 0,
    hint: oauthToken.length > 0
      ? 'OAuth token present'
      : 'Not set (may be using API key instead)',
  });

  // SAM MCP token
  credentials.push({
    name: 'SAM_MCP_TOKEN',
    type: 'mcp-token',
    available: config.mcpToken.length > 0,
    hint: config.mcpToken.length > 0
      ? 'MCP token present — control plane API calls available'
      : 'Not set — control plane tools will be unavailable',
  });

  return {
    credentials,
    agentAuthMethod: anthropicKey.length > 0
      ? 'api-key'
      : oauthToken.length > 0
        ? 'oauth-token'
        : 'unknown',
  };
}
