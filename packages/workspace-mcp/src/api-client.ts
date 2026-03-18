/**
 * HTTP client for SAM control plane API and SAM MCP server.
 *
 * Two communication channels:
 * 1. Direct REST API calls to /api/workspace-context/* (MCP token auth)
 * 2. JSON-RPC calls to /mcp for reusing existing MCP tools (MCP token auth)
 */

import type { WorkspaceMcpConfig } from './config.js';

export class ApiClient {
  constructor(private readonly config: WorkspaceMcpConfig) {}

  /**
   * Call a tool on the SAM MCP server via JSON-RPC.
   */
  async callMcpTool(
    toolName: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (!this.config.apiUrl || !this.config.mcpToken) {
      throw new Error(
        'SAM_API_URL and SAM_MCP_TOKEN are required for control plane calls',
      );
    }

    const response = await fetch(`${this.config.apiUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.mcpToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: { name: toolName, arguments: args },
      }),
    });

    if (!response.ok) {
      throw new Error(
        `MCP call ${toolName} failed: ${response.status} ${response.statusText}`,
      );
    }

    const rpc = (await response.json()) as {
      result?: { content?: Array<{ type: string; text: string }> };
      error?: { message: string };
    };
    if (rpc.error) {
      throw new Error(`MCP tool ${toolName} error: ${rpc.error.message}`);
    }

    // Extract text content from MCP response
    const textContent = rpc.result?.content?.find(
      (c: { type: string }) => c.type === 'text',
    );
    if (textContent) {
      try {
        return JSON.parse(textContent.text);
      } catch {
        return textContent.text;
      }
    }
    return rpc.result;
  }

  /**
   * Call a REST endpoint on the control plane API.
   */
  async callApi<T = unknown>(
    path: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    if (!this.config.apiUrl || !this.config.mcpToken) {
      throw new Error(
        'SAM_API_URL and SAM_MCP_TOKEN are required for control plane calls',
      );
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.mcpToken}`,
    };
    let body: string | undefined;
    if (options.body) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    const response = await fetch(`${this.config.apiUrl}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `API call ${path} failed: ${response.status} ${response.statusText} — ${text}`,
      );
    }

    return response.json() as Promise<T>;
  }

  /**
   * Call the GitHub API.
   */
  async callGitHub<T = unknown>(path: string): Promise<T> {
    if (!this.config.ghToken) {
      throw new Error('GH_TOKEN is required for GitHub API calls');
    }

    const response = await fetch(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${this.config.ghToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'sam-workspace-mcp',
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `GitHub API ${path} failed: ${response.status} ${response.statusText} — ${text}`,
      );
    }

    return response.json() as Promise<T>;
  }
}
