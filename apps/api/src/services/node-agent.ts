import type { Env } from '../index';
import { fetchWithTimeout, getTimeoutMs } from './fetch-timeout';
import { signNodeManagementToken } from './jwt';
import { recordNodeRoutingMetric } from './telemetry';

const DEFAULT_NODE_AGENT_REQUEST_TIMEOUT_MS = 30_000;

const DEFAULT_NODE_AGENT_READY_TIMEOUT_MS = 600_000;
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

export function getNodeAgentReadyPollIntervalMs(env: { NODE_AGENT_READY_POLL_INTERVAL_MS?: string }): number {
  const parsed = env.NODE_AGENT_READY_POLL_INTERVAL_MS
    ? Number.parseInt(env.NODE_AGENT_READY_POLL_INTERVAL_MS, 10)
    : DEFAULT_NODE_AGENT_READY_POLL_INTERVAL_MS;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_NODE_AGENT_READY_POLL_INTERVAL_MS;
  }
  return parsed;
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
        fetch(healthUrl, { method: 'GET', signal: controller.signal }),
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
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(pollIntervalMs, nextRemainingMs))
    );
  }

  const details = lastError ? ` Last error: ${lastError}` : '';
  throw new Error(`Node Agent not reachable at ${healthUrl} within ${timeoutMs}ms.${details}`);
}

async function nodeAgentRequest<T>(
  nodeId: string,
  env: Env,
  path: string,
  options: NodeAgentRequestOptions
): Promise<T> {
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

  const requestTimeoutMs = getTimeoutMs(
    env.NODE_AGENT_REQUEST_TIMEOUT_MS,
    DEFAULT_NODE_AGENT_REQUEST_TIMEOUT_MS
  );
  const response = await fetchWithTimeout(url, {
    ...options,
    headers,
  }, requestTimeoutMs);

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
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export async function createWorkspaceOnNode(
  nodeId: string,
  env: Env,
  userId: string,
  workspace: {
    workspaceId: string;
    repository: string;
    branch: string;
    callbackToken: string;
    gitUserName?: string | null;
    gitUserEmail?: string | null;
    githubId?: string | null;
    lightweight?: boolean;
  }
): Promise<unknown> {
  return nodeAgentRequest(nodeId, env, '/workspaces', {
    method: 'POST',
    userId,
    workspaceId: workspace.workspaceId,
    body: JSON.stringify(workspace),
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

export async function createAgentSessionOnNode(
  nodeId: string,
  workspaceId: string,
  sessionId: string,
  label: string | null,
  env: Env,
  userId: string,
  chatSessionId?: string | null,
  projectId?: string | null,
): Promise<unknown> {
  return nodeAgentRequest(nodeId, env, `/workspaces/${workspaceId}/agent-sessions`, {
    method: 'POST',
    userId,
    workspaceId,
    body: JSON.stringify({
      sessionId,
      label,
      chatSessionId: chatSessionId ?? undefined,
      projectId: projectId ?? undefined,
    }),
  });
}

/** MCP server configuration passed to the VM agent for ACP session injection */
export interface McpServerConfig {
  url: string;
  token: string;
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
): Promise<unknown> {
  const body: Record<string, unknown> = { agentType, initialPrompt };
  if (mcpServer) {
    body.mcpServers = [
      {
        url: mcpServer.url,
        token: mcpServer.token,
      },
    ];
  }
  return nodeAgentRequest(
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
}

export async function sendPromptToAgentOnNode(
  nodeId: string,
  workspaceId: string,
  sessionId: string,
  prompt: string,
  env: Env,
  userId: string
): Promise<unknown> {
  return nodeAgentRequest(
    nodeId,
    env,
    `/workspaces/${workspaceId}/agent-sessions/${sessionId}/prompt`,
    {
      method: 'POST',
      userId,
      workspaceId,
      body: JSON.stringify({ prompt }),
    }
  );
}

export async function stopAgentSessionOnNode(
  nodeId: string,
  workspaceId: string,
  sessionId: string,
  env: Env,
  userId: string
): Promise<unknown> {
  return nodeAgentRequest(
    nodeId,
    env,
    `/workspaces/${workspaceId}/agent-sessions/${sessionId}/stop`,
    {
      method: 'POST',
      userId,
      workspaceId,
    }
  );
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
  return nodeAgentRequest(nodeId, env, `/events?limit=${limit}`, {
    method: 'GET',
    userId,
  });
}

export async function getNodeSystemInfoFromNode(
  nodeId: string,
  env: Env,
  userId: string
): Promise<unknown> {
  return nodeAgentRequest(nodeId, env, '/system-info', {
    method: 'GET',
    userId,
  });
}

export async function getNodeLogsFromNode(
  nodeId: string,
  env: Env,
  userId: string,
  queryString: string
): Promise<unknown> {
  const path = queryString ? `/logs?${queryString}` : '/logs';
  return nodeAgentRequest(nodeId, env, path, {
    method: 'GET',
    userId,
  });
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
