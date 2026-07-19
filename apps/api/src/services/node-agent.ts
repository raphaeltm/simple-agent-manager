import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { expectJsonRecord } from '../lib/runtime-validation';
import { fetchWithTimeout, getTimeoutMs } from './fetch-timeout';
import { signNodeManagementToken, signTerminalToken } from './jwt';
import { recordNodeRoutingMetric } from './telemetry';
import {
  fetchVmAgentContainer,
  getVmAgentContainerConfig,
  markVmAgentContainerActiveWorkEndedBestEffort,
  markVmAgentContainerActiveWorkStarted,
} from './vm-agent-container';

const DEFAULT_NODE_AGENT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CF_CONTAINER_WAKE_TIMEOUT_MS = 120_000;
// cf-container workspace creation clones the repository synchronously inside
// the request (vm-agent handleStandaloneWorkspaceCreate), so it needs a
// background-work budget rather than the interactive 30s default. 120s mirrors
// the wake/restore budget, which re-runs the same clone. See rule 43.
const DEFAULT_CF_CONTAINER_CREATE_WORKSPACE_TIMEOUT_MS = 120_000;

const DEFAULT_NODE_AGENT_READY_TIMEOUT_MS = 900_000; // 15 min — cloud-init takes 8-12 min on Hetzner
const DEFAULT_NODE_AGENT_READY_POLL_INTERVAL_MS = 5000;

function getNodeBackendBaseUrl(nodeId: string, env: Env): string {
  const protocol = env.VM_AGENT_PROTOCOL || 'https';
  const port = env.VM_AGENT_PORT || '8443';
  // Two-level subdomain ({nodeId}.vm.{domain}) bypasses Cloudflare same-zone routing.
  // The wildcard Worker route *.{domain}/* matches exactly one subdomain level,
  // so {nodeId}.vm.{domain} is NOT intercepted — requests reach the VM directly.
  return `${protocol}://${nodeId.toLowerCase()}.vm.${env.BASE_DOMAIN}:${port}`;
}

interface NodeAgentRequestOptions extends RequestInit {
  userId: string;
  workspaceId?: string | null;
  requestTimeoutMs?: number;
}

function requestInitWithoutSignal(options: RequestInit): RequestInit {
  const serializableOptions = { ...options };
  delete serializableOptions.signal;
  return serializableOptions;
}

export function getNodeAgentReadyTimeoutMs(env: { NODE_AGENT_READY_TIMEOUT_MS?: string }): number {
  const parsed = env.NODE_AGENT_READY_TIMEOUT_MS
    ? Number.parseInt(env.NODE_AGENT_READY_TIMEOUT_MS, 10)
    : DEFAULT_NODE_AGENT_READY_TIMEOUT_MS;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_NODE_AGENT_READY_TIMEOUT_MS;
  }
  return parsed;
}

export function getNodeAgentReadyPollIntervalMs(env: {
  NODE_AGENT_READY_POLL_INTERVAL_MS?: string;
}): number {
  const parsed = env.NODE_AGENT_READY_POLL_INTERVAL_MS
    ? Number.parseInt(env.NODE_AGENT_READY_POLL_INTERVAL_MS, 10)
    : DEFAULT_NODE_AGENT_READY_POLL_INTERVAL_MS;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_NODE_AGENT_READY_POLL_INTERVAL_MS;
  }
  return parsed;
}

export function getNodeAgentRequestTimeoutMs(env: { NODE_AGENT_REQUEST_TIMEOUT_MS?: string }): number {
  return getTimeoutMs(env.NODE_AGENT_REQUEST_TIMEOUT_MS, DEFAULT_NODE_AGENT_REQUEST_TIMEOUT_MS);
}

export function getCfContainerWakeTimeoutMs(env: { CF_CONTAINER_WAKE_TIMEOUT_MS?: string }): number {
  return getTimeoutMs(env.CF_CONTAINER_WAKE_TIMEOUT_MS, DEFAULT_CF_CONTAINER_WAKE_TIMEOUT_MS);
}

export function getCfContainerCreateWorkspaceTimeoutMs(env: {
  CF_CONTAINER_CREATE_WORKSPACE_TIMEOUT_MS?: string;
}): number {
  return getTimeoutMs(
    env.CF_CONTAINER_CREATE_WORKSPACE_TIMEOUT_MS,
    DEFAULT_CF_CONTAINER_CREATE_WORKSPACE_TIMEOUT_MS
  );
}

export async function waitForNodeAgentReady(nodeId: string, env: Env): Promise<void> {
  const timeoutMs = getNodeAgentReadyTimeoutMs(env);
  const pollIntervalMs = getNodeAgentReadyPollIntervalMs(env);
  const baseUrl = getNodeBackendBaseUrl(nodeId, env);
  const healthUrl = `${baseUrl}/health`;
  const deadline = Date.now() + timeoutMs;

  let lastError = '';

  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    const requestTimeoutMs = Math.max(1, Math.min(pollIntervalMs, remainingMs));
    const controller = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    try {
      const requestTimeoutError = `request timeout after ${requestTimeoutMs}ms`;
      const response = await Promise.race([
        fetchNodeAgent(nodeId, env, healthUrl, { method: 'GET', signal: controller.signal }, requestTimeoutMs),
        new Promise<Response>((_resolve, reject) => {
          timeoutHandle = setTimeout(() => {
            controller.abort();
            reject(new Error(requestTimeoutError));
          }, requestTimeoutMs);
        }),
      ]);
      if (response.ok) {
        return;
      }

      const responseBody = await response.text().catch(() => '');
      lastError = `HTTP ${response.status}${responseBody ? ` ${responseBody}` : ''}`.trim();
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('request timeout after ')) {
        lastError = err.message;
      } else if (err instanceof Error && err.message.startsWith('Request timed out after ')) {
        lastError = err.message.replace('Request timed out after ', 'request timeout after ');
      } else if (err instanceof Error && err.name === 'AbortError') {
        lastError = `request timeout after ${requestTimeoutMs}ms`;
      } else {
        lastError = err instanceof Error ? err.message : String(err);
      }
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }

    const nextRemainingMs = deadline - Date.now();
    if (nextRemainingMs <= 0) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, nextRemainingMs)));
  }

  const details = lastError ? ` Last error: ${lastError}` : '';
  throw new Error(`Node Agent not reachable at ${healthUrl} within ${timeoutMs}ms.${details}`);
}

export async function nodeAgentRequest(
  nodeId: string,
  env: Env,
  path: string,
  options: NodeAgentRequestOptions
): Promise<unknown> {
  const { token } = await signNodeManagementToken(
    options.userId,
    nodeId,
    options.workspaceId ?? null,
    env
  );

  const url = `${getNodeBackendBaseUrl(nodeId, env)}${path}`;
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('Content-Type', 'application/json');
  headers.set('X-SAM-Node-Id', nodeId);

  if (options.workspaceId) {
    headers.set('X-SAM-Workspace-Id', options.workspaceId);
  } else {
    headers.delete('X-SAM-Workspace-Id');
  }

  const startedAt = Date.now();
  recordNodeRoutingMetric(
    {
      metric: 'node_agent_request',
      nodeId,
      workspaceId: options.workspaceId ?? null,
    },
    env
  );

  const requestTimeoutMs = options.requestTimeoutMs ?? getNodeAgentRequestTimeoutMs(env);
  const response = await fetchNodeAgent(nodeId, env, url, { ...options, headers }, requestTimeoutMs);

  recordNodeRoutingMetric(
    {
      metric: 'node_agent_response',
      nodeId,
      workspaceId: options.workspaceId ?? null,
      statusCode: response.status,
      durationMs: Date.now() - startedAt,
    },
    env
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');

    // Detect Worker loop-back: when the vm-{nodeId} DNS record is missing,
    // the wildcard DNS record routes the request back to this API Worker,
    // which returns its own 404 format. Provide a clear error instead.
    if (response.status === 404 && body.includes('"Endpoint not found"')) {
      throw new Error(
        `Node Agent unreachable: DNS record for ${nodeId.toLowerCase()}.vm may be missing. ` +
          `The request was routed back to the API Worker instead of the VM.`
      );
    }

    throw new Error(`Node Agent request failed: ${response.status} ${body}`);
  }

  if (response.status === 204) {
    return undefined;
  }

  try {
    return await response.json();
  } catch (err) {
    throw new Error(
      err instanceof Error
        ? `Node Agent returned invalid JSON: ${err.message}`
        : 'Node Agent returned invalid JSON'
    );
  }
}

export async function fetchNodeAgent(
  nodeId: string,
  env: Env,
  url: string,
  options: RequestInit,
  requestTimeoutMs: number
): Promise<Response> {
  if (!env.DATABASE || typeof env.DATABASE.prepare !== 'function') {
    return fetchWithTimeout(url, options, requestTimeoutMs);
  }

  const db = drizzle(env.DATABASE, { schema });
  const node = await db
    .select({ runtime: schema.nodes.runtime })
    .from(schema.nodes)
    .where(eq(schema.nodes.id, nodeId))
    .get();

  if (node?.runtime !== 'cf-container') {
    return fetchWithTimeout(url, options, requestTimeoutMs);
  }

  const config = getVmAgentContainerConfig(env);
  if (!config.enabled) {
    throw new Error('Container workspace runtime is disabled');
  }
  if (!env.VM_AGENT_CONTAINER) {
    throw new Error('VM_AGENT_CONTAINER binding is unavailable');
  }

  const vmAgentPort = config.vmAgentPort;
  const containerUrl = new URL(url);
  containerUrl.protocol = 'http:';
  containerUrl.hostname = 'localhost';
  containerUrl.port = String(vmAgentPort);

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    const response = await Promise.race([
      fetchVmAgentContainer(
        env,
        nodeId,
        new Request(containerUrl.toString(), requestInitWithoutSignal(options)),
        vmAgentPort
      ),
      new Promise<Response>((_resolve, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`Request timed out after ${requestTimeoutMs}ms`)),
          requestTimeoutMs
        );
      }),
    ]);
    return response;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

export async function createWorkspaceOnNode(
  nodeId: string,
  env: Env,
  userId: string,
  workspace: {
    workspaceId: string;
    repository: string;
    branch: string;
    repoProvider?: 'github' | 'artifacts' | 'gitlab';
    cloneUrl?: string | null;
    repositoryHost?: string | null;
    repositoryPath?: string | null;
    callbackToken: string;
    gitUserName?: string | null;
    gitUserEmail?: string | null;
    githubId?: string | null;
    lightweight?: boolean;
    /** Devcontainer config name (subdirectory under .devcontainer/). Undefined = auto-discover. */
    devcontainerConfigName?: string;
    /** Optional explicit devcontainer cache credentials minted by the control plane. */
    devcontainerCache?: {
      registry: string;
      username: string;
      password: string;
      ref: string;
    } | null;
  },
  options?: {
    /**
     * Override for the request timeout. cf-container creation must pass the
     * create-workspace budget (getCfContainerCreateWorkspaceTimeoutMs) because
     * the vm-agent clones synchronously inside this request; VM-node creation
     * is a fast 202 dispatch ack and keeps the interactive default.
     */
    requestTimeoutMs?: number;
  }
): Promise<unknown> {
  return nodeAgentRequest(nodeId, env, '/workspaces', {
    method: 'POST',
    userId,
    workspaceId: workspace.workspaceId,
    body: JSON.stringify(workspace),
    requestTimeoutMs: options?.requestTimeoutMs,
  });
}

export async function stopWorkspaceOnNode(
  nodeId: string,
  workspaceId: string,
  env: Env,
  userId: string
): Promise<unknown> {
  return nodeAgentRequest(nodeId, env, `/workspaces/${workspaceId}/stop`, {
    method: 'POST',
    userId,
    workspaceId,
  });
}

export async function restartWorkspaceOnNode(
  nodeId: string,
  workspaceId: string,
  env: Env,
  userId: string
): Promise<unknown> {
  return nodeAgentRequest(nodeId, env, `/workspaces/${workspaceId}/restart`, {
    method: 'POST',
    userId,
    workspaceId,
  });
}

export async function deleteWorkspaceOnNode(
  nodeId: string,
  workspaceId: string,
  env: Env,
  userId: string
): Promise<unknown> {
  return nodeAgentRequest(nodeId, env, `/workspaces/${workspaceId}`, {
    method: 'DELETE',
    userId,
    workspaceId,
  });
}

export async function teardownDeploymentEnvironmentOnNode(
  nodeId: string,
  environmentId: string,
  env: Env,
  userId: string
): Promise<unknown> {
  return nodeAgentRequest(
    nodeId,
    env,
    `/deployment/environments/${encodeURIComponent(environmentId)}/teardown`,
    {
      method: 'POST',
      userId,
    }
  );
}

export async function createAgentSessionOnNode(
  nodeId: string,
  workspaceId: string,
  sessionId: string,
  label: string | null,
  env: Env,
  userId: string,
  chatSessionId?: string | null,
  projectId?: string | null,
  mcpServer?: McpServerConfig
): Promise<unknown> {
  const body: Record<string, unknown> = {
    sessionId,
    label,
    chatSessionId: chatSessionId ?? undefined,
    projectId: projectId ?? undefined,
  };
  if (mcpServer) {
    body.mcpServers = [
      {
        url: mcpServer.url,
        token: mcpServer.token,
      },
    ];
  }

  return nodeAgentRequest(nodeId, env, `/workspaces/${workspaceId}/agent-sessions`, {
    method: 'POST',
    userId,
    workspaceId,
    body: JSON.stringify(body),
  });
}

/** MCP server configuration passed to the VM agent for ACP session injection */
export interface McpServerConfig {
  url: string;
  token: string;
}

/** Optional overrides for agent model and permission mode, resolved from agent profiles. */
export interface AgentSessionOverrides {
  model?: string | null;
  effort?: string | null;
  permissionMode?: string | null;
  /** OpenCode inference provider ('opencode-zen', 'opencode-go', or 'custom'). */
  opencodeProvider?: string | null;
  /** Base URL for the 'custom' OpenCode provider. */
  opencodeBaseUrl?: string | null;
}

export interface AgentSessionTaskContext {
  projectId: string;
  taskId: string;
  taskMode?: string | null;
}

export async function startAgentSessionOnNode(
  nodeId: string,
  workspaceId: string,
  sessionId: string,
  agentType: string,
  initialPrompt: string,
  env: Env,
  userId: string,
  mcpServer?: McpServerConfig,
  overrides?: AgentSessionOverrides,
  taskContext?: AgentSessionTaskContext,
  injectedInstructions?: string
): Promise<unknown> {
  const body: Record<string, unknown> = { agentType, initialPrompt };
  if (injectedInstructions != null && injectedInstructions !== '') {
    // SAM-injected system instructions delivered as a separate origin="system"
    // prompt block (see buildInjectedInstructions). The agent reads it as model
    // input; the UI collapses the mirrored message.
    body.injectedInstructions = injectedInstructions;
  }
  if (mcpServer) {
    body.mcpServers = [
      {
        url: mcpServer.url,
        token: mcpServer.token,
      },
    ];
  }
  if (overrides?.model != null) {
    body.model = overrides.model;
  }
  if (overrides?.effort != null) {
    body.effort = overrides.effort;
  }
  if (overrides?.permissionMode != null) {
    body.permissionMode = overrides.permissionMode;
  }
  if (overrides?.opencodeProvider != null) {
    body.opencodeProvider = overrides.opencodeProvider;
  }
  if (overrides?.opencodeBaseUrl != null) {
    body.opencodeBaseUrl = overrides.opencodeBaseUrl;
  }
  if (taskContext) {
    body.projectId = taskContext.projectId;
    body.taskId = taskContext.taskId;
    if (taskContext.taskMode != null) {
      body.taskMode = taskContext.taskMode;
    }
  }
  await markVmAgentContainerActiveWorkStarted(env, nodeId, {
    workspaceId,
    agentSessionId: sessionId,
    reason: 'start_agent_session',
  });
  try {
    return await nodeAgentRequest(
      nodeId,
      env,
      `/workspaces/${workspaceId}/agent-sessions/${sessionId}/start`,
      {
        method: 'POST',
        userId,
        workspaceId,
        body: JSON.stringify(body),
      }
    );
  } catch (err) {
    await markVmAgentContainerActiveWorkEndedBestEffort(env, nodeId, 'start_agent_session_failed');
    throw err;
  }
}

export async function sendPromptToAgentOnNode(
  nodeId: string,
  workspaceId: string,
  sessionId: string,
  prompt: string,
  env: Env,
  userId: string,
  messageId?: string,
  options?: { requestTimeoutMs?: number }
): Promise<unknown> {
  const body: { prompt: string; messageId?: string } = { prompt };
  if (messageId) body.messageId = messageId;

  await markVmAgentContainerActiveWorkStarted(env, nodeId, {
    workspaceId,
    agentSessionId: sessionId,
    reason: 'send_prompt',
  });
  try {
    return await nodeAgentRequest(
      nodeId,
      env,
      `/workspaces/${workspaceId}/agent-sessions/${sessionId}/prompt`,
      {
        method: 'POST',
        userId,
        workspaceId,
        requestTimeoutMs: options?.requestTimeoutMs,
        body: JSON.stringify(body),
      }
    );
  } catch (err) {
    await markVmAgentContainerActiveWorkEndedBestEffort(env, nodeId, 'send_prompt_failed');
    throw err;
  }
}

export { hibernateAgentSessionOnNode, restoreAgentSessionOnNode } from './node-agent-session-snapshots';

/**
 * Cancel a running prompt on an agent session.
 * Returns { success, status } instead of throwing on non-2xx responses,
 * so callers can distinguish 409 (no prompt in flight) from other errors.
 */
export async function cancelAgentSessionOnNode(
  nodeId: string,
  workspaceId: string,
  sessionId: string,
  env: Env,
  userId: string,
  options?: { requestTimeoutMs?: number }
): Promise<{ success: boolean; status: number }> {
  try {
    await nodeAgentRequest(
      nodeId,
      env,
      `/workspaces/${workspaceId}/agent-sessions/${sessionId}/cancel`,
      {
        method: 'POST',
        userId,
        workspaceId,
        requestTimeoutMs: options?.requestTimeoutMs,
      }
    );
    await markVmAgentContainerActiveWorkEndedBestEffort(env, nodeId, 'cancel_agent_session');
    return { success: true, status: 200 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Extract HTTP status from error message (format: "Node Agent request failed: 409 ...")
    const statusMatch = msg.match(/failed:\s*(\d{3})/);
    const status = statusMatch?.[1] ? parseInt(statusMatch[1], 10) : 500;
    if (status === 409) {
      await markVmAgentContainerActiveWorkEndedBestEffort(env, nodeId, 'cancel_agent_session_no_prompt');
    }
    return { success: false, status };
  }
}

export async function stopAgentSessionOnNode(
  nodeId: string,
  workspaceId: string,
  sessionId: string,
  env: Env,
  userId: string
): Promise<unknown> {
  try {
    return await nodeAgentRequest(
      nodeId,
      env,
      `/workspaces/${workspaceId}/agent-sessions/${sessionId}/stop`,
      {
        method: 'POST',
        userId,
        workspaceId,
      }
    );
  } finally {
    await markVmAgentContainerActiveWorkEndedBestEffort(env, nodeId, 'stop_agent_session');
  }
}

export async function suspendAgentSessionOnNode(
  nodeId: string,
  workspaceId: string,
  sessionId: string,
  env: Env,
  userId: string
): Promise<unknown> {
  return nodeAgentRequest(
    nodeId,
    env,
    `/workspaces/${workspaceId}/agent-sessions/${sessionId}/suspend`,
    {
      method: 'POST',
      userId,
      workspaceId,
    }
  );
}

export async function resumeAgentSessionOnNode(
  nodeId: string,
  workspaceId: string,
  sessionId: string,
  env: Env,
  userId: string
): Promise<unknown> {
  return nodeAgentRequest(
    nodeId,
    env,
    `/workspaces/${workspaceId}/agent-sessions/${sessionId}/resume`,
    {
      method: 'POST',
      userId,
      workspaceId,
    }
  );
}

export async function listAgentSessionsOnNode(
  nodeId: string,
  workspaceId: string,
  env: Env,
  userId: string
): Promise<unknown> {
  return nodeAgentRequest(nodeId, env, `/workspaces/${workspaceId}/agent-sessions`, {
    method: 'GET',
    userId,
    workspaceId,
  });
}

export async function listNodeEventsOnNode(
  nodeId: string,
  env: Env,
  userId: string,
  limit = 100
): Promise<{ events: unknown[]; nextCursor?: string | null }> {
  const payload = expectJsonRecord(
    await nodeAgentRequest(nodeId, env, `/events?limit=${limit}`, {
      method: 'GET',
      userId,
    }),
    'node-agent.events'
  );
  if (!Array.isArray(payload.events)) {
    throw new Error('Node Agent events response missing events array');
  }
  return {
    events: payload.events,
    nextCursor: typeof payload.nextCursor === 'string' ? payload.nextCursor : null,
  };
}

/**
 * Raw binary proxy to a VM agent endpoint.
 * Returns the raw Response (not parsed as JSON) so callers can stream the body.
 * Used for downloading SQLite database files (events, metrics).
 */
export async function nodeAgentRawRequest(
  nodeId: string,
  env: Env,
  path: string,
  userId: string
): Promise<Response> {
  const { token } = await signNodeManagementToken(userId, nodeId, null, env);
  const url = `${getNodeBackendBaseUrl(nodeId, env)}${path}`;
  const headers = new Headers();
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('X-SAM-Node-Id', nodeId);

  const DEFAULT_EXPORT_TIMEOUT_MS = 60_000;
  const timeoutMs = getTimeoutMs(env.NODE_AGENT_REQUEST_TIMEOUT_MS, DEFAULT_EXPORT_TIMEOUT_MS);
  return fetchNodeAgent(nodeId, env, url, { method: 'GET', headers }, timeoutMs);
}

export async function getWorkspacePortsOnNode(
  nodeId: string,
  workspaceId: string,
  env: Env,
  userId: string
): Promise<unknown> {
  // The VM agent ports endpoint is workspace-scoped and uses the same
  // workspace-terminal audience accepted by browser/direct workspace calls.
  // A node-management token fails requireWorkspaceRequestAuth().
  const { token } = await signTerminalToken(userId, workspaceId, env);
  const url = `${getNodeBackendBaseUrl(nodeId, env)}/workspaces/${workspaceId}/ports`;
  const headers = new Headers();
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('X-SAM-Node-Id', nodeId);
  headers.set('X-SAM-Workspace-Id', workspaceId);

  const startedAt = Date.now();
  recordNodeRoutingMetric(
    {
      metric: 'node_agent_request',
      nodeId,
      workspaceId,
    },
    env
  );

  const requestTimeoutMs = getTimeoutMs(
    env.NODE_AGENT_REQUEST_TIMEOUT_MS,
    DEFAULT_NODE_AGENT_REQUEST_TIMEOUT_MS
  );
  const response = await fetchNodeAgent(
    nodeId,
    env,
    url,
    {
      method: 'GET',
      headers,
    },
    requestTimeoutMs
  );

  recordNodeRoutingMetric(
    {
      metric: 'node_agent_response',
      nodeId,
      workspaceId,
      statusCode: response.status,
      durationMs: Date.now() - startedAt,
    },
    env
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Node Agent request failed: ${response.status} ${body}`);
  }

  try {
    return await response.json();
  } catch (err) {
    throw new Error(
      err instanceof Error
        ? `Node Agent returned invalid JSON: ${err.message}`
        : 'Node Agent returned invalid JSON'
    );
  }
}

export async function rebuildWorkspaceOnNode(
  nodeId: string,
  workspaceId: string,
  env: Env,
  userId: string
): Promise<unknown> {
  return nodeAgentRequest(nodeId, env, `/workspaces/${workspaceId}/rebuild`, {
    method: 'POST',
    userId,
    workspaceId,
  });
}
