#!/usr/bin/env node

/**
 * Workspace-Aware MCP Server
 *
 * A stdio MCP server that gives agents running inside SAM workspaces
 * platform-level awareness they can't get from inside their container.
 *
 * Architecture:
 * - Reads local state (env vars, /proc, git) for self-awareness
 * - Proxies to SAM MCP server for project/platform knowledge
 * - Calls GitHub API for CI/CD status
 *
 * Auth: session-scoped MCP token injected as SAM_MCP_TOKEN env var.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { ApiClient } from './api-client.js';
import { loadConfig } from './config.js';
import {
  getCiStatus,
  getDeploymentStatus,
} from './tools/cicd.js';
import {
  getFileLocks,
  getPeerAgentOutput,
  listProjectAgents,
} from './tools/coordination.js';
import {
  checkCostEstimate,
  getRemainingBudget,
} from './tools/cost.js';
import {
  getCredentialStatus,
  getWorkspaceInfo,
} from './tools/identity.js';
// Tool implementations
import {
  checkDnsStatus,
  exposePort,
  getNetworkInfo,
} from './tools/network.js';
import {
  getWorkspaceDiffSummary,
  reportEnvironmentIssue,
} from './tools/observability.js';
import { getTaskDependencies } from './tools/tasks.js';

const config = loadConfig();
const apiClient = new ApiClient(config);

const server = new McpServer({
  name: 'workspace-mcp',
  version: '1.0.0',
});

// --- Network & Connectivity ---

server.tool(
  'get_network_info',
  'Get workspace network info: base domain, workspace URL, exposed ports with external URLs',
  {},
  async () => {
    const result = await getNetworkInfo(config, apiClient);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'expose_port',
  'Register a port and get its external URL. Use after starting a dev server to get the public URL.',
  {
    port: z.number().int().min(1).max(65535).describe('TCP port number to expose'),
    label: z.string().optional().describe('Optional human-readable label for the port'),
  },
  async (args) => {
    const result = await exposePort(config, apiClient, args);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'check_dns_status',
  'Check DNS propagation and TLS certificate status for this workspace',
  {},
  async () => {
    const result = await checkDnsStatus(config, apiClient);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

// --- Identity & Orientation ---

server.tool(
  'get_workspace_info',
  'Get consolidated workspace metadata: ID, node, project, branch, mode, VM size, URL, uptime',
  {},
  async () => {
    const result = await getWorkspaceInfo(config, apiClient);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'get_credential_status',
  'Check which credentials are available (GitHub token, API key, OAuth token) and whether they are set',
  {},
  async () => {
    const result = await getCredentialStatus(config, apiClient);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

// --- Cost & Resource Awareness ---

server.tool(
  'check_cost_estimate',
  'Get VM hourly rate, runtime duration, and estimated total cost for this session',
  {},
  async () => {
    const result = await checkCostEstimate(config, apiClient);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'get_remaining_budget',
  'Get remaining project cost budget if configured',
  {},
  async () => {
    const result = await getRemainingBudget(config, apiClient);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

// --- Multi-Agent Coordination ---

server.tool(
  'list_project_agents',
  'List all active agent sessions on this project with their tasks, status, and branches',
  {},
  async () => {
    const result = await listProjectAgents(config, apiClient);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'get_file_locks',
  'Check which files are being modified by other agents to avoid merge conflicts',
  {},
  async () => {
    const result = await getFileLocks(config, apiClient);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'get_peer_agent_output',
  'Retrieve the result/summary from a sibling task agent by task ID',
  {
    taskId: z.string().describe('The task ID of the peer agent whose output you want'),
  },
  async (args) => {
    const result = await getPeerAgentOutput(config, apiClient, {
      taskId: args.taskId,
    });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

// --- Task & Dependency Awareness ---

server.tool(
  'get_task_dependencies',
  'Get upstream/downstream task dependency graph with status for the current task',
  {},
  async () => {
    const result = await getTaskDependencies(config, apiClient);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

// --- CI/CD Awareness ---

server.tool(
  'get_ci_status',
  'Get GitHub Actions workflow status for the current branch',
  {},
  async () => {
    const result = await getCiStatus(config, apiClient);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'get_deployment_status',
  'Get staging and production deployment state, last deploy, active deploys',
  {},
  async () => {
    const result = await getDeploymentStatus(config, apiClient);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

// --- Observability & Reporting ---

server.tool(
  'report_environment_issue',
  'Report a structured environment issue to the observability dashboard',
  {
    category: z.string().describe('Issue category (e.g., "network", "credentials", "disk", "performance")'),
    severity: z.enum(['low', 'medium', 'high', 'critical']).describe('Issue severity'),
    description: z.string().describe('Human-readable description of the issue'),
    diagnosticData: z.record(z.unknown()).optional().describe('Additional diagnostic key-value data'),
  },
  async (args) => {
    const result = await reportEnvironmentIssue(config, apiClient, args);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'get_workspace_diff_summary',
  'Get all changes since workspace creation: files changed, new, deleted, commit count, diff stats',
  {},
  async () => {
    const result = await getWorkspaceDiffSummary(config, apiClient);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

// --- Start the server ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('workspace-mcp server failed to start:', err);
  process.exit(1);
});
