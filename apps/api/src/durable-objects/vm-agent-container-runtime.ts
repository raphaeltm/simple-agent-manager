import type { Env } from '../env';
import { log } from '../lib/logger';
import { signNodeManagementToken } from '../services/jwt';
import {
  RUNTIME_RECOVERING_MESSAGE,
  RUNTIME_RECOVERY_DEGRADED_MESSAGE,
  RUNTIME_REQUEST_INTERRUPTED_MESSAGE,
  RUNTIME_STOPPED_MESSAGE,
  type RuntimeRecoveryCode,
} from './vm-agent-container-recovery';

interface RuntimeRecoveryResponseResult {
  code?: RuntimeRecoveryCode;
  message?: string;
}

export interface RuntimeIdentity {
  nodeId: string;
  workspaceId: string;
}

export function isMutatingRuntimeRequest(request: Request): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase());
}

export function runtimeRecoveryResponse(
  code: RuntimeRecoveryCode,
  message: string,
  status: 409 | 410 | 503
): Response {
  return Response.json({ error: code, message }, { status });
}

export function runtimeResultResponse(result: RuntimeRecoveryResponseResult): Response {
  if (result.code === 'RUNTIME_STOPPED') {
    return runtimeRecoveryResponse(result.code, result.message ?? RUNTIME_STOPPED_MESSAGE, 410);
  }
  return runtimeRecoveryResponse(
    result.code ?? 'RUNTIME_RECOVERY_DEGRADED',
    result.message ?? RUNTIME_RECOVERY_DEGRADED_MESSAGE,
    result.code === 'RUNTIME_RECOVERING' ? 503 : 409
  );
}

export function interruptedRuntimeRequestResponse(request: Request): Response {
  if (isMutatingRuntimeRequest(request)) {
    return runtimeRecoveryResponse(
      'RUNTIME_REQUEST_INTERRUPTED',
      RUNTIME_REQUEST_INTERRUPTED_MESSAGE,
      409
    );
  }
  return runtimeRecoveryResponse('RUNTIME_RECOVERING', RUNTIME_RECOVERING_MESSAGE, 503);
}
export async function isMissingSessionHostResponse(response: Response): Promise<boolean> {
  if (response.status !== 404) return false;
  const body = await response
    .clone()
    .text()
    .catch(() => '');
  return body.toLowerCase().includes('no active agent session found');
}

const LIVE_SESSION_HOST_STATUSES = new Set(['idle', 'starting', 'ready', 'prompting']);

export async function probeLiveRuntimeSession(input: {
  env: Env;
  userId: string;
  nodeId: string;
  workspaceId: string;
  agentSessionId: string;
  vmAgentPort: number;
  containerFetch: (request: Request, port: number) => Promise<Response>;
}): Promise<boolean> {
  const { token } = await signNodeManagementToken(
    input.userId,
    input.nodeId,
    input.workspaceId,
    input.env
  );
  const url = new URL(
    `http://localhost:${input.vmAgentPort}/workspaces/${input.workspaceId}/agent-sessions`
  );
  const response = await input.containerFetch(
    new Request(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-SAM-Node-Id': input.nodeId,
        'X-SAM-Workspace-Id': input.workspaceId,
      },
    }),
    input.vmAgentPort
  );
  if (!response.ok) {
    log.warn('vm_agent_container_runtime_session_probe_failed', {
      nodeId: input.nodeId,
      workspaceId: input.workspaceId,
      agentSessionId: input.agentSessionId,
      status: response.status,
    });
    throw new Error(`runtime_session_probe_http_${response.status}`);
  }
  const body = (await response.json()) as {
    sessions?: Array<{ id?: unknown; hostStatus?: unknown }>;
  };
  return Boolean(
    body.sessions?.some(
      (session) =>
        session.id === input.agentSessionId &&
        typeof session.hostStatus === 'string' &&
        LIVE_SESSION_HOST_STATUSES.has(session.hostStatus)
    )
  );
}

export function parsePositiveRuntimeSetting(raw: string | undefined, fallback: number): number {
  const parsed = raw ? Number.parseInt(raw, 10) : fallback;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveRuntimeSettings(
  env: Env,
  defaults: {
    portReadyTimeoutMs: number;
    activeWorkMaxMs: number;
    keepaliveRenewIntervalMs: number;
    recoveryMaxAttempts: number;
  }
) {
  return {
    portReadyTimeoutMs: parsePositiveRuntimeSetting(
      env.CF_CONTAINER_PORT_READY_TIMEOUT_MS || env.SANDBOX_EXEC_TIMEOUT_MS,
      defaults.portReadyTimeoutMs
    ),
    activeWorkMaxMs: parsePositiveRuntimeSetting(
      env.CF_CONTAINER_ACTIVE_WORK_MAX_MS,
      defaults.activeWorkMaxMs
    ),
    keepaliveRenewIntervalMs: parsePositiveRuntimeSetting(
      env.CF_CONTAINER_KEEPALIVE_RENEW_INTERVAL_MS,
      defaults.keepaliveRenewIntervalMs
    ),
    recoveryMaxAttempts: parsePositiveRuntimeSetting(
      env.CF_CONTAINER_RECOVERY_MAX_ATTEMPTS,
      defaults.recoveryMaxAttempts
    ),
  };
}

export async function persistRuntimeSleeping(env: Env, identity: RuntimeIdentity): Promise<void> {
  const now = new Date().toISOString();
  await env.DATABASE.batch([
    env.DATABASE.prepare(
      `UPDATE nodes
       SET status = 'sleeping', health_status = 'unhealthy', error_message = NULL, updated_at = ?
       WHERE id = ?`
    ).bind(now, identity.nodeId),
    env.DATABASE.prepare(
      `UPDATE workspaces SET status = 'sleeping', error_message = NULL, updated_at = ? WHERE id = ?`
    ).bind(now, identity.workspaceId),
    env.DATABASE.prepare(
      `UPDATE agent_sessions SET status = 'sleeping', error_message = NULL, updated_at = ? WHERE workspace_id = ?`
    ).bind(now, identity.workspaceId),
  ]);
}

export async function persistRuntimeEnded(
  env: Env,
  identity: RuntimeIdentity,
  status: 'stopped' | 'error',
  message: string
): Promise<void> {
  const now = new Date().toISOString();
  const errorMessage = status === 'stopped' ? null : message;
  await env.DATABASE.batch([
    env.DATABASE.prepare(
      `UPDATE nodes
       SET status = ?, health_status = 'unhealthy', error_message = ?, updated_at = ?
       WHERE id = ?`
    ).bind(status, errorMessage, now, identity.nodeId),
    env.DATABASE.prepare(
      `UPDATE workspaces SET status = ?, error_message = ?, updated_at = ? WHERE id = ?`
    ).bind(status, errorMessage, now, identity.workspaceId),
    env.DATABASE.prepare(
      `UPDATE agent_sessions
       SET status = ?, stopped_at = ?, error_message = ?, updated_at = ?
       WHERE workspace_id = ?`
    ).bind(status, now, errorMessage, now, identity.workspaceId),
  ]);
}
