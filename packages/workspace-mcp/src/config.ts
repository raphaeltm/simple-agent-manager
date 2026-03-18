/**
 * Configuration for the workspace MCP server.
 * All values are read from environment variables injected at session start.
 */

export interface WorkspaceMcpConfig {
  /** Workspace identifier */
  workspaceId: string;
  /** Node (VM) identifier */
  nodeId: string;
  /** Project identifier */
  projectId: string;
  /** GitHub repository (owner/repo) */
  repository: string;
  /** Git branch */
  branch: string;
  /** Chat session ID */
  chatSessionId: string;
  /** Task ID (if task-mode) */
  taskId: string;
  /** Workspace URL (e.g. https://ws-abc.example.com) */
  workspaceUrl: string;
  /** Control plane API URL (e.g. https://api.example.com) */
  apiUrl: string;
  /** Base domain for URL construction */
  baseDomain: string;
  /** MCP token for control plane API auth */
  mcpToken: string;
  /** GitHub token for GitHub API calls */
  ghToken: string;
}

/**
 * Load configuration from environment variables.
 * Returns the config with whatever values are available — tools handle missing values gracefully.
 */
export function loadConfig(): WorkspaceMcpConfig {
  const apiUrl = process.env['SAM_API_URL'] ?? '';
  // Derive base domain from API URL: https://api.example.com -> example.com
  let baseDomain = '';
  if (apiUrl) {
    try {
      const hostname = new URL(apiUrl).hostname;
      // Strip "api." prefix if present
      baseDomain = hostname.startsWith('api.') ? hostname.slice(4) : hostname;
    } catch {
      // Invalid URL, leave baseDomain empty
    }
  }

  return {
    workspaceId: process.env['SAM_WORKSPACE_ID'] ?? '',
    nodeId: process.env['SAM_NODE_ID'] ?? '',
    projectId: process.env['SAM_PROJECT_ID'] ?? '',
    repository: process.env['SAM_REPOSITORY'] ?? '',
    branch: process.env['SAM_BRANCH'] ?? '',
    chatSessionId: process.env['SAM_CHAT_SESSION_ID'] ?? '',
    taskId: process.env['SAM_TASK_ID'] ?? '',
    workspaceUrl: process.env['SAM_WORKSPACE_URL'] ?? '',
    apiUrl,
    baseDomain,
    mcpToken: process.env['SAM_MCP_TOKEN'] ?? '',
    ghToken: process.env['GH_TOKEN'] ?? '',
  };
}
