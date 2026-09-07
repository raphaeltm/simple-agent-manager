import type { Context } from 'hono';
import {
  DEFAULT_CREDENTIAL_LIMIT_USAGE_CALLBACK_RATE_LIMIT_RPM,
  DEFAULT_CREDENTIAL_LIMIT_USAGE_CALLBACK_RATE_LIMIT_WINDOW_SECONDS,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { extractBearerToken } from '../lib/auth-helpers';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import { errors } from '../middleware/error';
import { checkRateLimit, createRateLimitKey, getCurrentWindowStart } from '../middleware/rate-limit';
import { type AcpActivityBinding, buildAcpActivityBinding } from './acp-activity-admission';
import { assertAcpActivityCallbackResourcesActive } from './acp-activity-callback-flush';
import {
  type CredentialLimitObservation,
  recordCredentialLimitObservations,
} from './credential-limit-events';
import { type CallbackTokenPayload, verifyCallbackToken } from './jwt';
import { callbackTokenMatchesNode, callbackTokenMatchesWorkspace } from './node-callback-auth';
import * as projectDataService from './project-data';

export interface AcpUsageLimitObservationReport {
  windowType: string;
  provider?: string;
  source?: string;
  status?: 'allowed' | 'allowed_warning' | 'rejected' | 'unknown';
  utilizationPercent?: number;
  limitAmount?: number;
  remainingAmount?: number;
  windowMinutes?: number;
  resetsAt?: number;
  observedAt?: number;
  freshnessMs?: number;
}

export interface AcpUsageCallbackReport {
  nodeId: string;
  agentType?: string;
  credentialReference?: string;
  credentialSource?: 'user' | 'project' | 'platform';
  observedAt?: number;
  source?: string;
  rateLimits: AcpUsageLimitObservationReport[];
}

type ExistingAcpSession = NonNullable<Awaited<ReturnType<typeof projectDataService.getAcpSession>>>;

type AgentSessionCredentialAttributionRow = {
  id: string;
  user_id: string;
  agent_type: string | null;
  agent_credential_reference: string | null;
  agent_credential_source: string | null;
  agent_credential_provider: string | null;
  agent_provider_mode: string | null;
  workspace_id: string;
  workspace_project_id: string | null;
  workspace_chat_session_id: string | null;
  workspace_node_id: string | null;
};

function assertCallbackTokenBoundToUsageBinding(
  payload: CallbackTokenPayload,
  binding: AcpActivityBinding,
  input: { projectId: string; sessionId: string; nodeId: string }
): void {
  const tokenBoundToSession =
    callbackTokenMatchesNode(payload, binding.nodeId) ||
    callbackTokenMatchesWorkspace(payload, binding.workspaceId);
  if (!tokenBoundToSession) {
    log.warn('acp_usage.callback_token_not_bound_to_session', {
      sessionId: input.sessionId,
      projectId: input.projectId,
      scope: payload.scope,
      tokenIdentity: payload.workspace,
      sessionNodeId: binding.nodeId,
      sessionWorkspaceId: binding.workspaceId,
      action: 'rejected',
    });
    throw errors.forbidden('Callback token not authorized for this session');
  }

  if (binding.nodeId !== input.nodeId) {
    log.warn('acp_usage.node_mismatch', {
      sessionId: input.sessionId,
      projectId: input.projectId,
      expectedNodeId: binding.nodeId,
      receivedNodeId: input.nodeId,
      action: 'rejected',
    });
    throw errors.forbidden('Node identity verification failed');
  }
}

async function enforceAcpUsageCallbackRateLimit(
  c: Context<{ Bindings: Env }>,
  input: {
    payload: CallbackTokenPayload;
    projectId: string;
    sessionId: string;
    nodeId: string;
  }
): Promise<Response | null> {
  const limit = parsePositiveInt(
    c.env.CREDENTIAL_LIMIT_USAGE_CALLBACK_RATE_LIMIT_RPM,
    DEFAULT_CREDENTIAL_LIMIT_USAGE_CALLBACK_RATE_LIMIT_RPM
  );
  const windowSeconds = parsePositiveInt(
    c.env.CREDENTIAL_LIMIT_USAGE_CALLBACK_RATE_LIMIT_WINDOW_SECONDS,
    DEFAULT_CREDENTIAL_LIMIT_USAGE_CALLBACK_RATE_LIMIT_WINDOW_SECONDS
  );
  const windowStart = getCurrentWindowStart(windowSeconds);
  const key = createRateLimitKey(
    'acp-usage-callback',
    `${input.payload.scope}:${input.payload.workspace}:${input.projectId}:${input.sessionId}:${input.nodeId}`,
    windowStart
  );
  const { allowed, remaining, resetAt } = await checkRateLimit(
    c.env.KV,
    key,
    limit,
    windowSeconds
  );
  c.header('X-RateLimit-Limit', limit.toString());
  c.header('X-RateLimit-Remaining', remaining.toString());
  c.header('X-RateLimit-Reset', resetAt.toString());
  if (allowed) return null;

  const retryAfter = resetAt - Math.floor(Date.now() / 1000);
  c.header('Retry-After', Math.max(1, retryAfter).toString());
  return c.json(
    {
      error: 'RATE_LIMITED',
      message: 'Usage callback rate limit exceeded. Please try again later.',
    },
    429
  );
}

function requireAcpUsageBinding(input: {
  existing: ExistingAcpSession;
  projectId: string;
  sessionId: string;
  body: AcpUsageCallbackReport;
}): AcpActivityBinding {
  const binding = buildAcpActivityBinding(input.existing);
  if (binding) return binding;

  log.warn('acp_usage.node_mismatch', {
    sessionId: input.sessionId,
    projectId: input.projectId,
    expectedNodeId: input.existing.nodeId,
    receivedNodeId: input.body.nodeId,
    action: 'rejected',
  });
  throw errors.forbidden('Node identity verification failed');
}

function credentialSource(value: string | null): 'user' | 'project' | 'platform' | null {
  if (value === 'user' || value === 'project' || value === 'platform') return value;
  return null;
}

function providerFromAgent(agentType: string | null | undefined): string {
  if (!agentType) return 'unknown';
  if (agentType === 'claude-code' || agentType.includes('claude')) return 'anthropic';
  if (agentType === 'openai-codex' || agentType.includes('codex') || agentType.includes('openai')) {
    return 'openai';
  }
  return agentType;
}

function normalizeTelemetryProvider(
  provider: string | null,
  agentType: string | null | undefined
): string {
  if (provider === 'anthropic' || provider === 'openai') return provider;
  return providerFromAgent(provider ?? agentType);
}

async function loadServerCredentialAttribution(
  env: Env,
  input: {
    projectId: string;
    sessionId: string;
    binding: AcpActivityBinding;
  }
): Promise<AgentSessionCredentialAttributionRow | null> {
  if (!input.binding.workspaceId) return null;
  return env.DATABASE.prepare(
    `SELECT
        s.id,
        s.user_id,
        s.agent_type,
        s.agent_credential_reference,
        s.agent_credential_source,
        s.agent_credential_provider,
        s.agent_provider_mode,
        w.id AS workspace_id,
        w.project_id AS workspace_project_id,
        w.chat_session_id AS workspace_chat_session_id,
        w.node_id AS workspace_node_id
       FROM agent_sessions s
       JOIN workspaces w ON w.id = s.workspace_id
      WHERE s.id = ?
        AND s.workspace_id = ?
        AND w.project_id = ?
      LIMIT 1`
  )
    .bind(input.sessionId, input.binding.workspaceId, input.projectId)
    .first<AgentSessionCredentialAttributionRow>();
}

function assertServerAttributionMatchesCallback(
  row: AgentSessionCredentialAttributionRow,
  body: AcpUsageCallbackReport
): { credentialReference: string; credentialSource: 'user' | 'project' | 'platform' } | null {
  const source = credentialSource(row.agent_credential_source);
  if (!row.agent_credential_reference || !source) {
    if (body.credentialReference || body.credentialSource) {
      log.warn('acp_usage.client_credential_identity_without_server_attribution', {
        sessionId: row.id,
        workspaceId: row.workspace_id,
        action: 'rejected',
      });
      throw errors.forbidden('Credential attribution is not server verified');
    }
    return null;
  }

  if (body.credentialReference && body.credentialReference !== row.agent_credential_reference) {
    log.warn('acp_usage.credential_reference_mismatch', {
      sessionId: row.id,
      workspaceId: row.workspace_id,
      expectedCredentialReference: row.agent_credential_reference,
      receivedCredentialReference: body.credentialReference,
      action: 'rejected',
    });
    throw errors.forbidden('Credential attribution mismatch');
  }
  if (body.credentialSource && body.credentialSource !== source) {
    log.warn('acp_usage.credential_source_mismatch', {
      sessionId: row.id,
      workspaceId: row.workspace_id,
      expectedCredentialSource: source,
      receivedCredentialSource: body.credentialSource,
      action: 'rejected',
    });
    throw errors.forbidden('Credential attribution mismatch');
  }
  if (body.agentType && row.agent_type && body.agentType !== row.agent_type) {
    log.warn('acp_usage.agent_type_mismatch', {
      sessionId: row.id,
      workspaceId: row.workspace_id,
      expectedAgentType: row.agent_type,
      receivedAgentType: body.agentType,
      action: 'rejected',
    });
    throw errors.forbidden('Agent type mismatch');
  }
  return {
    credentialReference: row.agent_credential_reference,
    credentialSource: source,
  };
}

function buildObservations(input: {
  projectId: string;
  body: AcpUsageCallbackReport;
  row: AgentSessionCredentialAttributionRow;
  credentialReference: string;
  credentialSource: 'user' | 'project' | 'platform';
  defaultObservedAt: number;
}): CredentialLimitObservation[] {
  const providerDefault = normalizeTelemetryProvider(
    input.row.agent_credential_provider,
    input.body.agentType ?? input.row.agent_type
  );
  const providerMode = input.row.agent_provider_mode ?? 'direct';
  const sourceDefault = input.body.source ?? 'vm-agent.acp_usage_update';

  return input.body.rateLimits.map((limit) => ({
    projectId: input.projectId,
    userId: input.row.user_id,
    credentialReference: input.credentialReference,
    credentialSource: input.credentialSource,
    provider: limit.provider ?? providerDefault,
    providerMode,
    windowType: limit.windowType,
    source: limit.source ?? sourceDefault,
    observedAt: limit.observedAt ?? input.body.observedAt ?? input.defaultObservedAt,
    status: limit.status ?? 'unknown',
    agentType: input.body.agentType ?? input.row.agent_type,
    workspaceId: input.row.workspace_id,
    agentSessionId: input.row.id,
    chatSessionId: input.row.workspace_chat_session_id,
    utilizationPercent: limit.utilizationPercent,
    limitAmount: limit.limitAmount,
    remainingAmount: limit.remainingAmount,
    windowMinutes: limit.windowMinutes,
    resetsAt: limit.resetsAt,
    freshnessMs: limit.freshnessMs,
  }));
}

export async function handleAcpUsageCallback(
  c: Context<{ Bindings: Env }>,
  input: {
    projectId: string;
    sessionId: string;
    body: AcpUsageCallbackReport;
  }
): Promise<Response> {
  const token = extractBearerToken(c.req.header('Authorization'));
  const payload = await verifyCallbackToken(token, c.env);
  if (payload.scope !== 'workspace' && payload.scope !== 'node') {
    log.warn('acp_usage.invalid_token_scope', {
      scope: payload.scope,
      action: 'rejected',
    });
    throw errors.forbidden('Invalid token scope for usage report');
  }

  const { projectId, sessionId, body } = input;
  const rateLimitResponse = await enforceAcpUsageCallbackRateLimit(c, {
    payload,
    projectId,
    sessionId,
    nodeId: body.nodeId,
  });
  if (rateLimitResponse) return rateLimitResponse;

  const existing = await projectDataService.getAcpSession(c.env, projectId, sessionId);
  if (!existing) throw errors.notFound('ACP session not found');

  const binding = requireAcpUsageBinding({ existing, projectId, sessionId, body });
  assertCallbackTokenBoundToUsageBinding(payload, binding, {
    projectId,
    sessionId,
    nodeId: body.nodeId,
  });
  await assertAcpActivityCallbackResourcesActive(c.env, {
    projectId,
    sessionId,
    nodeId: body.nodeId,
    workspaceId: binding.workspaceId,
    chatSessionId: binding.chatSessionId,
  });

  const row = await loadServerCredentialAttribution(c.env, {
    projectId,
    sessionId,
    binding,
  });
  if (
    !row ||
    row.workspace_node_id !== body.nodeId ||
    row.workspace_chat_session_id !== binding.chatSessionId
  ) {
    log.warn('acp_usage.session_workspace_binding_mismatch', {
      projectId,
      sessionId,
      nodeId: body.nodeId,
      workspaceId: binding.workspaceId,
      action: 'rejected',
    });
    throw errors.forbidden('Usage callback binding mismatch');
  }

  const serverAttribution = assertServerAttributionMatchesCallback(row, body);
  if (!serverAttribution || body.rateLimits.length === 0) {
    log.info('acp_usage.no_supported_credential_limit_observation', {
      projectId,
      sessionId,
      workspaceId: binding.workspaceId,
      hasServerCredentialAttribution: Boolean(serverAttribution),
      rateLimitCount: body.rateLimits.length,
    });
    return c.body(null, 204);
  }

  await recordCredentialLimitObservations(
    c.env,
    buildObservations({
      projectId,
      body,
      row,
      credentialReference: serverAttribution.credentialReference,
      credentialSource: serverAttribution.credentialSource,
      defaultObservedAt: Date.now(),
    })
  );
  return c.body(null, 204);
}
