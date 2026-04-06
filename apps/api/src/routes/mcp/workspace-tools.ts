/**
 * Workspace tools — tools that provide agents with workspace-local awareness.
 *
 * These tools replace the standalone workspace-mcp stdio server. They are split into:
 * - Category A: Handled directly in sam-mcp (no VM agent proxy needed)
 * - Category B: Proxied to VM agent (need local container access)
 * - Category C: Could go either way (currently handled in Worker)
 *
 * For Category B tools, calls are proxied to the VM agent via:
 * Agent -> sam-mcp (Worker) -> VM agent -> docker exec -> result
 */
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../index';
import { log } from '../../lib/logger';
import { parsePositiveInt } from '../../lib/route-helpers';
import { getCredentialEncryptionKey } from '../../lib/secrets';
import { decrypt } from '../../services/encryption';
import { signTerminalToken } from '../../services/jwt';
import {
  ACTIVE_STATUSES,
  getMcpLimits,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
} from './_helpers';

// ─── Configurable defaults (Constitution Principle XI) ──────────────────────

/** Timeout for VM agent proxy calls. Override via WORKSPACE_TOOL_TIMEOUT_MS. */
const DEFAULT_WORKSPACE_TOOL_TIMEOUT_MS = 15_000;
/** Timeout for GitHub API calls. Override via WORKSPACE_TOOL_GITHUB_TIMEOUT_MS. */
const DEFAULT_GITHUB_API_TIMEOUT_MS = 10_000;
/** Timeout for DNS check calls. Override via WORKSPACE_TOOL_DNS_TIMEOUT_MS. */
const DEFAULT_DNS_CHECK_TIMEOUT_MS = 10_000;
/** Max CI runs to return. Override via WORKSPACE_TOOL_CI_RUNS_LIMIT. */
const DEFAULT_CI_RUNS_LIMIT = 10;
/** Max deployment runs to return. Override via WORKSPACE_TOOL_DEPLOY_RUNS_LIMIT. */
const DEFAULT_DEPLOY_RUNS_LIMIT = 5;
/** Max size (bytes) for diagnostic data in report_environment_issue. Override via WORKSPACE_TOOL_DIAGNOSTIC_MAX_BYTES. */
const DEFAULT_DIAGNOSTIC_MAX_BYTES = 4096;

function getWorkspaceToolTimeout(env: Env): number {
  return parsePositiveInt(env.WORKSPACE_TOOL_TIMEOUT_MS, DEFAULT_WORKSPACE_TOOL_TIMEOUT_MS);
}
function getGitHubApiTimeout(env: Env): number {
  return parsePositiveInt(env.WORKSPACE_TOOL_GITHUB_TIMEOUT_MS, DEFAULT_GITHUB_API_TIMEOUT_MS);
}
function getDnsCheckTimeout(env: Env): number {
  return parsePositiveInt(env.WORKSPACE_TOOL_DNS_TIMEOUT_MS, DEFAULT_DNS_CHECK_TIMEOUT_MS);
}

// ─── VM agent tool paths (typed union prevents path traversal) ──────────────

type VmAgentToolPath =
  | 'workspace-info'
  | 'credential-status'
  | 'network-info'
  | 'expose-port'
  | 'cost-estimate'
  | 'diff-summary';

// ─── Shared proxy helper ────────────────────────────────────────────────────

/**
 * Look up the workspace's node, generate a JWT, and proxy a request to the VM agent.
 * Returns the parsed JSON response from the VM agent.
 */
async function proxyToVmAgent(
  env: Env,
  workspaceId: string,
  userId: string,
  toolPath: VmAgentToolPath,
  method: 'GET' | 'POST' = 'GET',
  body?: unknown,
): Promise<unknown> {
  const db = drizzle(env.DATABASE, { schema });

  // Look up workspace to get nodeId
  const [workspace] = await db
    .select({
      id: schema.workspaces.id,
      status: schema.workspaces.status,
      nodeId: schema.workspaces.nodeId,
      projectId: schema.workspaces.projectId,
    })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);

  if (!workspace) {
    throw new Error('Workspace not found');
  }
  if (workspace.status !== 'running' && workspace.status !== 'recovery') {
    throw new Error(`Workspace is not accessible (status: ${workspace.status})`);
  }
  if (!workspace.nodeId) {
    throw new Error('Workspace has no assigned node');
  }

  // Generate workspace token for VM agent auth
  const { token } = await signTerminalToken(userId, workspaceId, env);

  // Construct VM agent URL (two-level subdomain to bypass CF same-zone routing)
  const protocol = env.VM_AGENT_PROTOCOL || 'https';
  const port = env.VM_AGENT_PORT || '8443';
  const vmUrl = `${protocol}://${workspace.nodeId.toLowerCase()}.vm.${env.BASE_DOMAIN}:${port}/workspaces/${encodeURIComponent(workspaceId)}/mcp/${toolPath}?token=${encodeURIComponent(token)}`;

  const timeoutMs = getWorkspaceToolTimeout(env);

  const fetchOpts: RequestInit = {
    method,
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body) {
    fetchOpts.headers = { 'Content-Type': 'application/json' };
    fetchOpts.body = JSON.stringify(body);
  }

  const res = await fetch(vmUrl, fetchOpts);

  if (!res.ok) {
    const errText = await res.text().catch(() => 'unknown error');
    throw new Error(`VM agent returned ${res.status}: ${errText}`);
  }

  return res.json();
}

/**
 * Validate that the MCP token has a workspaceId. Returns an error response if not.
 */
function requireWorkspace(
  requestId: string | number | null,
  tokenData: McpTokenData,
): JsonRpcResponse | null {
  if (!tokenData.workspaceId) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'No active workspace for this session. Workspace tools are only available when a workspace is running.',
    );
  }
  return null;
}

// ─── Category B: Proxied to VM agent ────────────────────────────────────────

export async function handleGetWorkspaceInfo(
  requestId: string | number | null,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const err = requireWorkspace(requestId, tokenData);
  if (err) return err;
  try {
    const result = await proxyToVmAgent(env, tokenData.workspaceId, tokenData.userId, 'workspace-info');
    return jsonRpcSuccess(requestId, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
  } catch (e) {
    return jsonRpcError(requestId, INTERNAL_ERROR, `Failed to get workspace info: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function handleGetCredentialStatus(
  requestId: string | number | null,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const err = requireWorkspace(requestId, tokenData);
  if (err) return err;
  try {
    const result = await proxyToVmAgent(env, tokenData.workspaceId, tokenData.userId, 'credential-status');
    return jsonRpcSuccess(requestId, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
  } catch (e) {
    return jsonRpcError(requestId, INTERNAL_ERROR, `Failed to get credential status: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function handleGetNetworkInfo(
  requestId: string | number | null,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const err = requireWorkspace(requestId, tokenData);
  if (err) return err;
  try {
    const result = await proxyToVmAgent(env, tokenData.workspaceId, tokenData.userId, 'network-info');
    return jsonRpcSuccess(requestId, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
  } catch (e) {
    return jsonRpcError(requestId, INTERNAL_ERROR, `Failed to get network info: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function handleExposePort(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const err = requireWorkspace(requestId, tokenData);
  if (err) return err;

  const port = params.port;
  if (typeof port !== 'number' || port < 1 || port > 65535) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'port is required and must be between 1 and 65535');
  }
  const label = typeof params.label === 'string' ? params.label : undefined;

  try {
    const result = await proxyToVmAgent(
      env, tokenData.workspaceId, tokenData.userId, 'expose-port', 'POST',
      { port, label },
    );
    return jsonRpcSuccess(requestId, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
  } catch (e) {
    return jsonRpcError(requestId, INTERNAL_ERROR, `Failed to expose port: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function handleCheckCostEstimate(
  requestId: string | number | null,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const err = requireWorkspace(requestId, tokenData);
  if (err) return err;
  try {
    const result = await proxyToVmAgent(env, tokenData.workspaceId, tokenData.userId, 'cost-estimate');
    return jsonRpcSuccess(requestId, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
  } catch (e) {
    return jsonRpcError(requestId, INTERNAL_ERROR, `Failed to get cost estimate: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function handleGetWorkspaceDiffSummary(
  requestId: string | number | null,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const err = requireWorkspace(requestId, tokenData);
  if (err) return err;
  try {
    const result = await proxyToVmAgent(env, tokenData.workspaceId, tokenData.userId, 'diff-summary');
    return jsonRpcSuccess(requestId, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
  } catch (e) {
    return jsonRpcError(requestId, INTERNAL_ERROR, `Failed to get diff summary: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ─── Category A: Handled directly in sam-mcp ────────────────────────────────

export async function handleListProjectAgents(
  requestId: string | number | null,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  try {
    const db = drizzle(env.DATABASE, { schema });
    const tasks = await db
      .select({
        id: schema.tasks.id,
        title: schema.tasks.title,
        status: schema.tasks.status,
        outputBranch: schema.tasks.outputBranch,
        workspaceId: schema.tasks.workspaceId,
      })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.projectId, tokenData.projectId),
          inArray(schema.tasks.status, ACTIVE_STATUSES),
        ),
      );

    // Exclude self
    const agents = tasks
      .filter((t) => t.id !== tokenData.taskId)
      .map((t) => ({
        taskId: t.id,
        title: t.title,
        status: t.status,
        branch: t.outputBranch,
        workspaceId: t.workspaceId,
      }));

    return jsonRpcSuccess(requestId, {
      content: [{ type: 'text', text: JSON.stringify({ totalAgents: agents.length, agents }, null, 2) }],
    });
  } catch (e) {
    return jsonRpcError(requestId, INTERNAL_ERROR, `Failed to list project agents: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function handleGetFileLocks(
  requestId: string | number | null,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  try {
    const db = drizzle(env.DATABASE, { schema });
    const tasks = await db
      .select({
        id: schema.tasks.id,
        title: schema.tasks.title,
        outputBranch: schema.tasks.outputBranch,
      })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.projectId, tokenData.projectId),
          inArray(schema.tasks.status, ACTIVE_STATUSES),
        ),
      );

    const otherAgents = tasks
      .filter((t) => t.id !== tokenData.taskId)
      .map((t) => ({
        taskId: t.id,
        title: t.title,
        branch: t.outputBranch,
      }));

    return jsonRpcSuccess(requestId, {
      content: [{
        type: 'text',
        text: JSON.stringify({
          note: 'File-level lock detection is best-effort. Check the branches of other active agents to avoid conflicts.',
          otherAgents,
        }, null, 2),
      }],
    });
  } catch (e) {
    return jsonRpcError(requestId, INTERNAL_ERROR, `Failed to get file locks: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function handleGetPeerAgentOutput(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const taskId = params.taskId;
  if (typeof taskId !== 'string' || !taskId.trim()) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'taskId is required');
  }

  try {
    const db = drizzle(env.DATABASE, { schema });
    const [task] = await db
      .select({
        id: schema.tasks.id,
        title: schema.tasks.title,
        status: schema.tasks.status,
        description: schema.tasks.description,
        outputSummary: schema.tasks.outputSummary,
        outputBranch: schema.tasks.outputBranch,
      })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.id, taskId),
          eq(schema.tasks.projectId, tokenData.projectId),
        ),
      )
      .limit(1);

    if (!task) {
      return jsonRpcError(requestId, INVALID_PARAMS, `Task ${taskId} not found in this project`);
    }

    const limits = getMcpLimits(env);
    return jsonRpcSuccess(requestId, {
      content: [{
        type: 'text',
        text: JSON.stringify({
          id: task.id,
          title: task.title,
          status: task.status,
          description: task.description?.slice(0, limits.taskDescriptionSnippetLength),
          summary: task.outputSummary,
          branch: task.outputBranch,
        }, null, 2),
      }],
    });
  } catch (e) {
    return jsonRpcError(requestId, INTERNAL_ERROR, `Failed to get peer agent output: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function handleGetTaskDependencies(
  requestId: string | number | null,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  if (!tokenData.taskId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'This tool requires a task-scoped MCP token');
  }

  try {
    const db = drizzle(env.DATABASE, { schema });

    // Get current task
    const [currentTask] = await db
      .select({
        id: schema.tasks.id,
        title: schema.tasks.title,
        parentTaskId: schema.tasks.parentTaskId,
      })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, tokenData.taskId))
      .limit(1);

    if (!currentTask) {
      return jsonRpcError(requestId, INTERNAL_ERROR, 'Current task not found');
    }

    // Targeted queries instead of fetching all project tasks
    const taskSelect = {
      id: schema.tasks.id,
      title: schema.tasks.title,
      status: schema.tasks.status,
      parentTaskId: schema.tasks.parentTaskId,
      outputBranch: schema.tasks.outputBranch,
    };

    // Upstream: parent task (if any)
    const upstream = currentTask.parentTaskId
      ? await db
          .select(taskSelect)
          .from(schema.tasks)
          .where(eq(schema.tasks.id, currentTask.parentTaskId))
          .limit(1)
      : [];

    // Downstream: tasks whose parent is the current task
    const downstream = await db
      .select(taskSelect)
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.parentTaskId, tokenData.taskId),
          eq(schema.tasks.projectId, tokenData.projectId),
        ),
      )
      .limit(50);

    // Siblings: tasks with the same parent (excluding self)
    const siblings = currentTask.parentTaskId
      ? (await db
          .select(taskSelect)
          .from(schema.tasks)
          .where(
            and(
              eq(schema.tasks.parentTaskId, currentTask.parentTaskId),
              eq(schema.tasks.projectId, tokenData.projectId),
            ),
          )
          .limit(51))
          .filter((t) => t.id !== tokenData.taskId)
      : [];

    return jsonRpcSuccess(requestId, {
      content: [{
        type: 'text',
        text: JSON.stringify({
          currentTask: { id: currentTask.id, title: currentTask.title },
          upstream: upstream.map((t) => ({ id: t.id, title: t.title, status: t.status, branch: t.outputBranch })),
          downstream: downstream.map((t) => ({ id: t.id, title: t.title, status: t.status, branch: t.outputBranch })),
          siblings: siblings.map((t) => ({ id: t.id, title: t.title, status: t.status, branch: t.outputBranch })),
        }, null, 2),
      }],
    });
  } catch (e) {
    return jsonRpcError(requestId, INTERNAL_ERROR, `Failed to get task dependencies: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function handleGetRemainingBudget(
  requestId: string | number | null,
  _tokenData: McpTokenData,
  _env: Env,
): Promise<JsonRpcResponse> {
  // Budget tracking is not yet implemented — return a note
  return jsonRpcSuccess(requestId, {
    content: [{
      type: 'text',
      text: JSON.stringify({
        note: 'Budget tracking is not yet configured for this project.',
        budgetUsd: null,
        spentUsd: null,
        remainingUsd: null,
      }, null, 2),
    }],
  });
}

export async function handleReportEnvironmentIssue(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const category = params.category;
  const severity = params.severity;
  const description = params.description;

  if (typeof category !== 'string' || !category.trim()) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'category is required');
  }
  if (typeof severity !== 'string' || !['low', 'medium', 'high', 'critical'].includes(severity)) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'severity must be one of: low, medium, high, critical');
  }
  if (typeof description !== 'string' || !description.trim()) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'description is required');
  }

  try {
    // Store in observability database if available
    if (env.OBSERVABILITY_DATABASE) {
      // Cap diagnostic data to prevent unbounded D1 writes
      const maxDiagnosticBytes = parsePositiveInt(
        env.WORKSPACE_TOOL_DIAGNOSTIC_MAX_BYTES,
        DEFAULT_DIAGNOSTIC_MAX_BYTES,
      );
      let diagnosticData = params.diagnosticData;
      if (diagnosticData) {
        const serialized = JSON.stringify(diagnosticData);
        if (serialized.length > maxDiagnosticBytes) {
          diagnosticData = serialized.slice(0, maxDiagnosticBytes) + '... [truncated]';
        }
      }

      await env.OBSERVABILITY_DATABASE.prepare(
        `INSERT INTO errors (id, source, level, message, context, created_at)
         VALUES (?, 'workspace-agent', ?, ?, ?, datetime('now'))`,
      )
        .bind(
          crypto.randomUUID(),
          severity,
          `[${category}] ${description}`,
          JSON.stringify({
            workspaceId: tokenData.workspaceId,
            projectId: tokenData.projectId,
            taskId: tokenData.taskId,
            diagnosticData,
          }),
        )
        .run();
    }

    return jsonRpcSuccess(requestId, {
      content: [{ type: 'text', text: JSON.stringify({ status: 'reported', category, severity }) }],
    });
  } catch (e) {
    log.warn('workspace_tools.report_issue_failed', { error: String(e) });
    return jsonRpcSuccess(requestId, {
      content: [{ type: 'text', text: JSON.stringify({ status: 'report_failed', note: 'Issue was logged but storage failed' }) }],
    });
  }
}

export async function handleGetCiStatus(
  requestId: string | number | null,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  if (!tokenData.taskId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'This tool requires a task-scoped MCP token');
  }

  try {
    const db = drizzle(env.DATABASE, { schema });

    // Get the task's branch
    const [task] = await db
      .select({ outputBranch: schema.tasks.outputBranch })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, tokenData.taskId))
      .limit(1);

    // Get the project's repository
    const [project] = await db
      .select({ repository: schema.projects.repository })
      .from(schema.projects)
      .where(eq(schema.projects.id, tokenData.projectId))
      .limit(1);

    if (!project?.repository) {
      return jsonRpcSuccess(requestId, {
        content: [{ type: 'text', text: JSON.stringify({ status: 'no_repository', note: 'No repository configured for this project' }) }],
      });
    }

    const branch = task?.outputBranch;
    if (!branch) {
      return jsonRpcSuccess(requestId, {
        content: [{ type: 'text', text: JSON.stringify({ status: 'no_branch', note: 'No output branch for current task' }) }],
      });
    }

    // Get GitHub token from user's stored credentials
    const ghToken = await getUserGitHubToken(db, tokenData.userId, env);
    if (!ghToken) {
      return jsonRpcSuccess(requestId, {
        content: [{ type: 'text', text: JSON.stringify({ status: 'no_credentials', note: 'No GitHub token available. CI status requires GitHub credentials.' }) }],
      });
    }

    const runsLimit = parsePositiveInt(env.WORKSPACE_TOOL_CI_RUNS_LIMIT, DEFAULT_CI_RUNS_LIMIT);
    const ghTimeoutMs = getGitHubApiTimeout(env);
    const apiUrl = `https://api.github.com/repos/${project.repository}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=${runsLimit}`;

    const res = await fetch(apiUrl, {
      headers: {
        Authorization: `Bearer ${ghToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'SAM-MCP/1.0',
      },
      signal: AbortSignal.timeout(ghTimeoutMs),
    });

    if (!res.ok) {
      return jsonRpcSuccess(requestId, {
        content: [{ type: 'text', text: JSON.stringify({ status: 'api_error', note: `GitHub API returned ${res.status}` }) }],
      });
    }

    const data = await res.json() as { workflow_runs?: Array<{ id: number; name: string; status: string; conclusion: string | null; html_url: string; created_at: string }> };
    const runs = (data.workflow_runs ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      conclusion: r.conclusion,
      url: r.html_url,
      createdAt: r.created_at,
    }));

    // Determine overall status
    let overallStatus = 'no_runs';
    if (runs.length > 0) {
      const hasRunning = runs.some((r) => r.status === 'in_progress' || r.status === 'queued');
      const hasFailed = runs.some((r) => r.conclusion === 'failure');
      if (hasRunning) overallStatus = 'running';
      else if (hasFailed) overallStatus = 'failed';
      else overallStatus = 'passed';
    }

    return jsonRpcSuccess(requestId, {
      content: [{ type: 'text', text: JSON.stringify({ branch, overallStatus, runs }, null, 2) }],
    });
  } catch (e) {
    return jsonRpcError(requestId, INTERNAL_ERROR, `Failed to get CI status: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function handleGetDeploymentStatus(
  requestId: string | number | null,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  try {
    const db = drizzle(env.DATABASE, { schema });

    // Get the project's repository
    const [project] = await db
      .select({ repository: schema.projects.repository })
      .from(schema.projects)
      .where(eq(schema.projects.id, tokenData.projectId))
      .limit(1);

    if (!project?.repository) {
      return jsonRpcSuccess(requestId, {
        content: [{ type: 'text', text: JSON.stringify({ status: 'no_repository' }) }],
      });
    }

    const ghToken = await getUserGitHubToken(db, tokenData.userId, env);
    if (!ghToken) {
      return jsonRpcSuccess(requestId, {
        content: [{ type: 'text', text: JSON.stringify({ status: 'no_credentials', note: 'No GitHub token available.' }) }],
      });
    }

    const runsLimit = parsePositiveInt(env.WORKSPACE_TOOL_DEPLOY_RUNS_LIMIT, DEFAULT_DEPLOY_RUNS_LIMIT);
    const ghTimeoutMs = getGitHubApiTimeout(env);

    // Fetch staging and production deployment workflows
    const [stagingRes, prodRes] = await Promise.all([
      fetchWorkflowRuns(ghToken, project.repository, 'deploy-staging.yml', runsLimit, ghTimeoutMs),
      fetchWorkflowRuns(ghToken, project.repository, 'deploy.yml', runsLimit, ghTimeoutMs),
    ]);

    return jsonRpcSuccess(requestId, {
      content: [{
        type: 'text',
        text: JSON.stringify({
          staging: stagingRes,
          production: prodRes,
        }, null, 2),
      }],
    });
  } catch (e) {
    return jsonRpcError(requestId, INTERNAL_ERROR, `Failed to get deployment status: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ─── Category C: Handled in Worker (no VM agent needed) ─────────────────────

export async function handleCheckDnsStatus(
  requestId: string | number | null,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const err = requireWorkspace(requestId, tokenData);
  if (err) return err;

  const workspaceUrl = `https://ws-${tokenData.workspaceId}.${env.BASE_DOMAIN}`;
  const hostname = `ws-${tokenData.workspaceId}.${env.BASE_DOMAIN}`;
  const dnsTimeoutMs = getDnsCheckTimeout(env);

  try {
    // Try to fetch the workspace URL to check DNS + TLS in one call.
    // Note: this only confirms Cloudflare edge reachability, not VM agent health.
    const res = await fetch(workspaceUrl, {
      method: 'HEAD',
      signal: AbortSignal.timeout(dnsTimeoutMs),
    });

    return jsonRpcSuccess(requestId, {
      content: [{
        type: 'text',
        text: JSON.stringify({
          hostname,
          workspaceUrl,
          dnsResolved: true,
          tlsValid: true,
          httpStatus: res.status,
          note: 'Confirms Cloudflare edge reachability. Does not verify VM agent health.',
        }, null, 2),
      }],
    });
  } catch (e) {
    // Distinguish TLS errors from DNS/network errors
    const errorMsg = e instanceof Error ? e.message : String(e);
    const isTlsError = errorMsg.includes('SSL') || errorMsg.includes('TLS') || errorMsg.includes('certificate');

    return jsonRpcSuccess(requestId, {
      content: [{
        type: 'text',
        text: JSON.stringify({
          hostname,
          workspaceUrl,
          dnsResolved: isTlsError, // TLS error means DNS resolved but cert failed
          tlsValid: false,
          status: isTlsError ? 'tls_error' : 'dns_not_resolved',
          error: errorMsg,
        }, null, 2),
      }],
    });
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Get the user's GitHub token from encrypted credentials.
 * Returns null if not available.
 */
async function getUserGitHubToken(
  db: ReturnType<typeof drizzle>,
  userId: string,
  env: Env,
): Promise<string | null> {
  try {
    const [cred] = await db
      .select({
        encryptedToken: schema.credentials.encryptedToken,
        iv: schema.credentials.iv,
      })
      .from(schema.credentials)
      .where(
        and(
          eq(schema.credentials.userId, userId),
          eq(schema.credentials.provider, 'github'),
        ),
      )
      .limit(1);

    if (!cred) return null;

    const encryptionKey = getCredentialEncryptionKey(env);
    return await decrypt(cred.encryptedToken, cred.iv, encryptionKey);
  } catch (e) {
    log.warn('workspace_tools.github_token_decrypt_failed', { userId, error: String(e) });
    return null;
  }
}

/**
 * Fetch recent workflow runs from GitHub API.
 */
async function fetchWorkflowRuns(
  ghToken: string,
  repository: string,
  workflowFile: string,
  limit: number,
  timeoutMs: number,
): Promise<{ lastDeploy: unknown; isDeploying: boolean; recentRuns: unknown[] } | { error: string }> {
  try {
    const apiUrl = `https://api.github.com/repos/${repository}/actions/workflows/${workflowFile}/runs?per_page=${limit}`;
    const res = await fetch(apiUrl, {
      headers: {
        Authorization: `Bearer ${ghToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'SAM-MCP/1.0',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      return { error: `GitHub API returned ${res.status}` };
    }

    const data = await res.json() as { workflow_runs?: Array<{ id: number; status: string; conclusion: string | null; head_branch: string; html_url: string; created_at: string }> };
    const runs = data.workflow_runs ?? [];

    const lastDeploy = runs[0]
      ? { status: runs[0].status, conclusion: runs[0].conclusion, branch: runs[0].head_branch, url: runs[0].html_url, createdAt: runs[0].created_at }
      : null;

    const isDeploying = runs.some((r) => r.status === 'in_progress' || r.status === 'queued');

    return {
      lastDeploy,
      isDeploying,
      recentRuns: runs.slice(0, 3).map((r) => ({
        status: r.status,
        conclusion: r.conclusion,
        branch: r.head_branch,
        url: r.html_url,
        createdAt: r.created_at,
      })),
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
