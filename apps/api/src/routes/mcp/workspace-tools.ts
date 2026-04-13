/**
 * Workspace tools — Category B: Proxied to VM agent (need local container access).
 *
 * These tools replace the standalone workspace-mcp stdio server's container-local tools.
 * Calls are proxied to the VM agent via:
 * Agent -> sam-mcp (Worker) -> VM agent -> docker exec -> result
 *
 * Category A (direct D1/API) and Category C (Worker-side DNS) handlers are in
 * workspace-tools-direct.ts.
 */
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { parsePositiveInt } from '../../lib/route-helpers';
import { signTerminalToken } from '../../services/jwt';
import {
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
function getWorkspaceToolTimeout(env: Env): number {
  return parsePositiveInt(env.WORKSPACE_TOOL_TIMEOUT_MS, DEFAULT_WORKSPACE_TOOL_TIMEOUT_MS);
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
  projectId: string,
  toolPath: VmAgentToolPath,
  method: 'GET' | 'POST' = 'GET',
  body?: unknown,
): Promise<unknown> {
  const db = drizzle(env.DATABASE, { schema });

  // Look up workspace to get nodeId — scoped to project for defense-in-depth
  const [workspace] = await db
    .select({
      id: schema.workspaces.id,
      status: schema.workspaces.status,
      nodeId: schema.workspaces.nodeId,
      projectId: schema.workspaces.projectId,
    })
    .from(schema.workspaces)
    .where(
      and(
        eq(schema.workspaces.id, workspaceId),
        eq(schema.workspaces.projectId, projectId),
      ),
    )
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
  // Token sent as Bearer header (not query param) per workspace_routing.go contract
  const protocol = env.VM_AGENT_PROTOCOL || 'https';
  const port = env.VM_AGENT_PORT || '8443';
  const vmUrl = `${protocol}://${workspace.nodeId.toLowerCase()}.vm.${env.BASE_DOMAIN}:${port}/workspaces/${encodeURIComponent(workspaceId)}/mcp/${toolPath}`;

  const timeoutMs = getWorkspaceToolTimeout(env);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (body) {
    headers['Content-Type'] = 'application/json';
  }

  const fetchOpts: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body) {
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
export function requireWorkspace(
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
    const result = await proxyToVmAgent(env, tokenData.workspaceId, tokenData.userId, tokenData.projectId, 'workspace-info');
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
    const result = await proxyToVmAgent(env, tokenData.workspaceId, tokenData.userId, tokenData.projectId, 'credential-status');
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
    const result = await proxyToVmAgent(env, tokenData.workspaceId, tokenData.userId, tokenData.projectId, 'network-info');
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
      env, tokenData.workspaceId, tokenData.userId, tokenData.projectId, 'expose-port', 'POST',
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
    const result = await proxyToVmAgent(env, tokenData.workspaceId, tokenData.userId, tokenData.projectId, 'cost-estimate');
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
    const result = await proxyToVmAgent(env, tokenData.workspaceId, tokenData.userId, tokenData.projectId, 'diff-summary');
    return jsonRpcSuccess(requestId, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
  } catch (e) {
    return jsonRpcError(requestId, INTERNAL_ERROR, `Failed to get diff summary: ${e instanceof Error ? e.message : String(e)}`);
  }
}
