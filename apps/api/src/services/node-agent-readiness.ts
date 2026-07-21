import type { Env } from '../env';

const DEFAULT_NODE_AGENT_READY_TIMEOUT_MS = 900_000;
const DEFAULT_NODE_AGENT_READY_POLL_INTERVAL_MS = 5000;

type NodeAgentFetch = (
  nodeId: string,
  env: Env,
  url: string,
  options: RequestInit,
  requestTimeoutMs: number
) => Promise<Response>;

export function getNodeBackendBaseUrl(nodeId: string, env: Env): string {
  const protocol = env.VM_AGENT_PROTOCOL || 'https';
  const port = env.VM_AGENT_PORT || '8443';
  // Two-level subdomain ({nodeId}.vm.{domain}) bypasses Cloudflare same-zone routing.
  // The wildcard Worker route *.{domain}/* matches exactly one subdomain level,
  // so {nodeId}.vm.{domain} is NOT intercepted — requests reach the VM directly.
  return `${protocol}://${nodeId.toLowerCase()}.vm.${env.BASE_DOMAIN}:${port}`;
}

export function getNodeAgentReadyTimeoutMs(env: {
  NODE_AGENT_READY_TIMEOUT_MS?: string;
}): number {
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

export async function waitForNodeAgentReadyWith(
  fetchNodeAgent: NodeAgentFetch,
  nodeId: string,
  env: Env
): Promise<void> {
  const timeoutMs = getNodeAgentReadyTimeoutMs(env);
  const pollIntervalMs = getNodeAgentReadyPollIntervalMs(env);
  const healthUrl = `${getNodeBackendBaseUrl(nodeId, env)}/health`;
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
        fetchNodeAgent(
          nodeId,
          env,
          healthUrl,
          { method: 'GET', signal: controller.signal },
          requestTimeoutMs
        ),
        new Promise<Response>((_resolve, reject) => {
          timeoutHandle = setTimeout(() => {
            controller.abort();
            reject(new Error(requestTimeoutError));
          }, requestTimeoutMs);
        }),
      ]);
      if (response.ok) return;

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
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }

    const nextRemainingMs = deadline - Date.now();
    if (nextRemainingMs <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, nextRemainingMs)));
  }

  const details = lastError ? ` Last error: ${lastError}` : '';
  throw new Error(`Node Agent not reachable at ${healthUrl} within ${timeoutMs}ms.${details}`);
}
