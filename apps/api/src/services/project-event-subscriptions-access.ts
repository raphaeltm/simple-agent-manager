import {
  PROJECT_EVENT_REQUESTED_DELIVERY_MODES,
  PROJECT_EVENT_SUBSCRIPTION_OWNER_SCOPES,
  type ProjectEventDeliveryPreference,
  type ProjectEventRequestedDeliveryMode,
  type ProjectEventSubscriptionAgentCaller,
  type ProjectEventSubscriptionCaller,
  type ProjectEventSubscriptionCreateRequest,
  type ProjectEventSubscriptionOwner,
  type ProjectEventSubscriptionOwnerScope,
  type ProjectEventSubscriptionPlatformCaller,
  type ProjectEventSubscriptionRecord,
  TASK_TERMINAL_STATUSES,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { errors } from '../middleware/error';
import { getMcpTokenMaxLifetime, getMcpTokenTTL } from './mcp-token';

const ACTIVE_AGENT_TASK_STATUSES = new Set([
  'queued',
  'delegated',
  'in_progress',
  'awaiting_followup',
]);
const ACTIVE_WORKSPACE_STATUSES = new Set(['running', 'recovery']);
const ACTIVE_AGENT_SESSION_STATUSES = new Set(['running']);

type AgentTaskRow = {
  id: string;
  project_id: string;
  user_id: string;
  status: string;
  workspace_id: string | null;
  chat_session_id: string | null;
};

type WorkspaceRow = {
  id: string;
  project_id: string | null;
  user_id: string;
  status: string;
  chat_session_id: string | null;
};

type AgentSessionRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  status: string;
};

export type AgentSubscriptionContext = {
  projectId: string;
  owner: ProjectEventSubscriptionOwner;
  target: NonNullable<ProjectEventDeliveryPreference['target']>;
};

export type SurfaceContext =
  | (AgentSubscriptionContext & { callerKind: 'agent' })
  | {
      callerKind: 'platform';
      projectId: string;
      owner: ProjectEventSubscriptionOwner;
      platform: ProjectEventSubscriptionPlatformCaller;
    };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertNoCallerProjectId(input: Record<string, unknown>): void {
  if (Object.prototype.hasOwnProperty.call(input, 'projectId')) {
    throw errors.forbidden('projectId is derived from caller context');
  }
}

function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw errors.badRequest(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeNullableText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    throw errors.badRequest(`${field} must be a non-empty string when provided`);
  }
  return value.trim();
}

function normalizeTargetObject(
  value: ProjectEventDeliveryPreference['target'] | null | undefined
): NonNullable<ProjectEventDeliveryPreference['target']> {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) throw errors.badRequest('target must be an object');
  return value;
}

function ownersEqual(a: ProjectEventSubscriptionOwner, b: ProjectEventSubscriptionOwner): boolean {
  return a.type === b.type && a.id === b.id;
}

function isOwnerScope(value: unknown): value is ProjectEventSubscriptionOwnerScope {
  return (
    typeof value === 'string' &&
    (PROJECT_EVENT_SUBSCRIPTION_OWNER_SCOPES as readonly string[]).includes(value)
  );
}

export function resolveOwnerScope(
  request: { ownerScope?: ProjectEventSubscriptionOwnerScope | null; owner?: unknown },
  fallback: ProjectEventSubscriptionOwnerScope
): ProjectEventSubscriptionOwnerScope {
  if (request.ownerScope === null || request.ownerScope === undefined) {
    return request.owner ? 'specific' : fallback;
  }
  if (!isOwnerScope(request.ownerScope)) {
    throw errors.badRequest('ownerScope must be caller, specific, or all');
  }
  return request.ownerScope;
}

function isRequestedDelivery(value: unknown): value is ProjectEventRequestedDeliveryMode {
  return (
    typeof value === 'string' &&
    (PROJECT_EVENT_REQUESTED_DELIVERY_MODES as readonly string[]).includes(value)
  );
}

export function normalizeRequestedDelivery(value: unknown): ProjectEventRequestedDeliveryMode {
  if (!isRequestedDelivery(value)) {
    throw errors.badRequest(
      'requestedDelivery must be a supported ProjectData event delivery mode'
    );
  }
  return value;
}

export function resolveDeliveryPreference(
  requested: ProjectEventRequestedDeliveryMode,
  target: ProjectEventDeliveryPreference['target']
): ProjectEventDeliveryPreference {
  return {
    requested,
    // The canonical pull model records caller delivery intent but does not queue
    // prompts, steer runtimes, interrupt runtimes, or spawn tasks.
    resolved: requested === 'record_only' ? 'record_only' : 'recorded_not_injected',
    target,
  };
}

async function firstRow<T extends object>(
  env: Env,
  sql: string,
  ...params: unknown[]
): Promise<T | null> {
  const row = await env.DATABASE.prepare(sql)
    .bind(...params)
    .first<T>();
  return row ?? null;
}

async function resolveAgentContext(
  env: Env,
  caller: ProjectEventSubscriptionAgentCaller
): Promise<AgentSubscriptionContext> {
  const projectId = assertNonEmptyString(caller.projectId, 'caller.projectId');
  const userId = assertNonEmptyString(caller.userId, 'caller.userId');
  const taskId = assertNonEmptyString(caller.taskId, 'caller.taskId');
  const workspaceId = assertNonEmptyString(caller.workspaceId, 'caller.workspaceId');

  const task = await firstRow<AgentTaskRow>(
    env,
    `SELECT id, project_id, user_id, status, workspace_id, chat_session_id
     FROM tasks
     WHERE id = ? AND project_id = ?
     LIMIT 1`,
    taskId,
    projectId
  );
  if (!task) throw errors.notFound('Calling task');
  if (task.user_id !== userId) throw errors.forbidden('Calling token user does not own the task');
  if ((TASK_TERMINAL_STATUSES as readonly string[]).includes(task.status)) {
    throw errors.forbidden('Terminal tasks cannot manage event subscriptions');
  }
  if (!ACTIVE_AGENT_TASK_STATUSES.has(task.status)) {
    throw errors.forbidden('Calling task is not active');
  }
  if (task.workspace_id && task.workspace_id !== workspaceId) {
    throw errors.forbidden('Calling token workspace does not match the task workspace');
  }

  const workspace = await firstRow<WorkspaceRow>(
    env,
    `SELECT id, project_id, user_id, status, chat_session_id
     FROM workspaces
     WHERE id = ?
     LIMIT 1`,
    workspaceId
  );
  if (!workspace) throw errors.notFound('Calling workspace');
  if (workspace.project_id !== projectId) {
    throw errors.forbidden('Calling workspace is not bound to the caller project');
  }
  if (workspace.user_id !== userId) {
    throw errors.forbidden('Calling token user does not own the workspace');
  }
  if (!ACTIVE_WORKSPACE_STATUSES.has(workspace.status)) {
    throw errors.forbidden('Calling workspace is not active');
  }

  const tokenSessionId = normalizeNullableText(caller.chatSessionId, 'caller.chatSessionId');
  if (tokenSessionId && task.chat_session_id && tokenSessionId !== task.chat_session_id) {
    throw errors.forbidden('Calling token session does not match the task session');
  }
  if (tokenSessionId && workspace.chat_session_id && tokenSessionId !== workspace.chat_session_id) {
    throw errors.forbidden('Calling token session does not match the workspace session');
  }
  if (
    task.chat_session_id &&
    workspace.chat_session_id &&
    task.chat_session_id !== workspace.chat_session_id
  ) {
    throw errors.forbidden('Task and workspace sessions do not match');
  }

  const agentSessionId = normalizeNullableText(caller.agentSessionId, 'caller.agentSessionId');
  if (agentSessionId) {
    const agentSession = await firstRow<AgentSessionRow>(
      env,
      `SELECT id, workspace_id, user_id, status
       FROM agent_sessions
       WHERE id = ?
       LIMIT 1`,
      agentSessionId
    );
    if (!agentSession) throw errors.notFound('Calling agent session');
    if (agentSession.workspace_id !== workspaceId) {
      throw errors.forbidden('Calling agent session is not bound to the workspace');
    }
    if (agentSession.user_id !== userId) {
      throw errors.forbidden('Calling token user does not own the agent session');
    }
    if (!ACTIVE_AGENT_SESSION_STATUSES.has(agentSession.status)) {
      throw errors.forbidden('Calling agent session is not active');
    }
  }

  const sessionId = tokenSessionId ?? task.chat_session_id ?? workspace.chat_session_id;
  if (!sessionId) {
    throw errors.badRequest(
      'Calling task has no durable chat session for event subscription target'
    );
  }
  const ownerId = agentSessionId ?? `${taskId}:${sessionId}`;

  return {
    projectId,
    owner: {
      type: 'agent',
      id: ownerId,
      name: caller.ownerName ?? agentSessionId ?? taskId,
    },
    target: {
      sessionId,
      taskId,
      runtimeId: null,
      agentId: agentSessionId,
    },
  };
}

function platformActorOwner(
  caller: ProjectEventSubscriptionPlatformCaller
): ProjectEventSubscriptionOwner {
  return {
    type: 'system',
    id: assertNonEmptyString(caller.actorId, 'caller.actorId'),
    name: caller.actorName ?? null,
  };
}

export function requirePlatformOwnerPermission(
  caller: ProjectEventSubscriptionPlatformCaller,
  owner: ProjectEventSubscriptionOwner,
  verb: 'create' | 'read' | 'cancel'
): void {
  const permissions = caller.permissions ?? {};
  const prefix = `Platform caller cannot ${verb} ${owner.type} event subscriptions`;
  switch (owner.type) {
    case 'agent':
      if (!permissions.manageAgentSubscriptions) throw errors.forbidden(prefix);
      return;
    case 'policy':
      if (!permissions.managePolicySubscriptions) throw errors.forbidden(prefix);
      return;
    case 'standing_watch':
      if (!permissions.manageStandingWatchSubscriptions) throw errors.forbidden(prefix);
      return;
    case 'system':
      if (!permissions.manageSystemSubscriptions) throw errors.forbidden(prefix);
      return;
    case 'human':
      throw errors.forbidden(
        'Human-owned event subscriptions are not supported by the internal surface yet'
      );
  }
}

export async function requirePlatformTargetAccess(
  env: Env,
  projectId: string,
  target: ProjectEventDeliveryPreference['target'] | null | undefined
): Promise<NonNullable<ProjectEventDeliveryPreference['target']>> {
  const requestedTarget = normalizeTargetObject(target);
  const normalizedTarget: NonNullable<ProjectEventDeliveryPreference['target']> = {
    sessionId: normalizeNullableText(requestedTarget.sessionId, 'target.sessionId'),
    taskId: normalizeNullableText(requestedTarget.taskId, 'target.taskId'),
    runtimeId: normalizeNullableText(requestedTarget.runtimeId, 'target.runtimeId'),
    agentId: normalizeNullableText(requestedTarget.agentId, 'target.agentId'),
  };

  if (normalizedTarget.taskId) {
    const task = await firstRow<AgentTaskRow>(
      env,
      `SELECT id, project_id, user_id, status, workspace_id, chat_session_id
       FROM tasks
       WHERE id = ? AND project_id = ?
       LIMIT 1`,
      normalizedTarget.taskId,
      projectId
    );
    if (!task) throw errors.notFound('Target task');
    if (
      normalizedTarget.sessionId &&
      task.chat_session_id &&
      normalizedTarget.sessionId !== task.chat_session_id
    ) {
      throw errors.forbidden('Target session does not match the target task');
    }
  }

  if (normalizedTarget.agentId) {
    const agentSession = await firstRow<AgentSessionRow & { project_id: string | null }>(
      env,
      `SELECT agent_sessions.id,
              agent_sessions.workspace_id,
              agent_sessions.user_id,
              agent_sessions.status,
              workspaces.project_id
       FROM agent_sessions
       INNER JOIN workspaces ON workspaces.id = agent_sessions.workspace_id
       WHERE agent_sessions.id = ? AND workspaces.project_id = ?
       LIMIT 1`,
      normalizedTarget.agentId,
      projectId
    );
    if (!agentSession) throw errors.notFound('Target agent session');
  }

  return normalizedTarget;
}

export function requireAgentCreateIdentity(
  request: ProjectEventSubscriptionCreateRequest,
  context: AgentSubscriptionContext
): NonNullable<ProjectEventDeliveryPreference['target']> {
  if (request.owner) {
    throw errors.forbidden('Agent callers cannot override event subscription owner identity');
  }
  const target = normalizeTargetObject(request.target);
  const requestedSessionId = normalizeNullableText(target.sessionId, 'target.sessionId');
  const requestedTaskId = normalizeNullableText(target.taskId, 'target.taskId');
  const requestedAgentId = normalizeNullableText(target.agentId, 'target.agentId');
  const requestedRuntimeId = normalizeNullableText(target.runtimeId, 'target.runtimeId');

  if (requestedSessionId && requestedSessionId !== context.target.sessionId) {
    throw errors.forbidden('Agent event subscription target session must match the caller session');
  }
  if (requestedTaskId && requestedTaskId !== context.target.taskId) {
    throw errors.forbidden('Agent event subscription target task must match the caller task');
  }
  if (requestedAgentId && requestedAgentId !== context.target.agentId) {
    throw errors.forbidden(
      'Agent event subscription target agent must match the caller agent session'
    );
  }
  if (requestedRuntimeId) {
    throw errors.forbidden('Agent callers cannot target runtimes directly in this surface');
  }
  return context.target;
}

export function requireAgentAccess(
  subscription: ProjectEventSubscriptionRecord,
  context: AgentSubscriptionContext
): void {
  const target = subscription.deliveryPreference.target;
  if (
    !ownersEqual(subscription.owner, context.owner) ||
    target?.sessionId !== context.target.sessionId
  ) {
    throw errors.notFound('Event subscription');
  }
}

export function resolveAgentExpiresAt(
  env: Env,
  caller: ProjectEventSubscriptionAgentCaller,
  requestedExpiresAt: number | null | undefined,
  now = Date.now()
): number {
  const defaultTtlMs = getMcpTokenTTL(env) * 1000;
  const maxLifetimeMs = getMcpTokenMaxLifetime(env) * 1000;
  let maxDurationMs = maxLifetimeMs;

  if (caller.mcpTokenCreatedAt) {
    const tokenCreatedAt = Date.parse(caller.mcpTokenCreatedAt);
    if (!Number.isFinite(tokenCreatedAt)) {
      throw errors.forbidden('Calling MCP token creation timestamp is invalid');
    }
    maxDurationMs = Math.max(0, tokenCreatedAt + maxLifetimeMs - now);
  }

  if (maxDurationMs <= 0) throw errors.forbidden('Calling MCP token lifetime has expired');

  const defaultExpiresAt = Math.min(now + defaultTtlMs, now + maxDurationMs);
  const expiresAt = requestedExpiresAt ?? defaultExpiresAt;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
    throw errors.badRequest('expiresAt must be a future millisecond timestamp');
  }
  if (expiresAt > now + maxDurationMs) {
    throw errors.forbidden('expiresAt exceeds the caller MCP token lifetime');
  }
  return expiresAt;
}

export async function resolveSurfaceContext(
  env: Env,
  caller: ProjectEventSubscriptionCaller
): Promise<SurfaceContext> {
  if (caller.kind === 'agent') {
    const context = await resolveAgentContext(env, caller);
    return { callerKind: 'agent', ...context };
  }
  const projectId = assertNonEmptyString(caller.projectId, 'caller.projectId');
  return {
    callerKind: 'platform',
    projectId,
    owner: platformActorOwner(caller),
    platform: caller,
  };
}

export function resolvePlatformOwner(
  caller: ProjectEventSubscriptionPlatformCaller,
  owner: ProjectEventSubscriptionOwner | null | undefined,
  verb: 'create' | 'read' | 'cancel'
): ProjectEventSubscriptionOwner {
  if (!owner) throw errors.badRequest('owner is required for platform-owned event subscriptions');
  requirePlatformOwnerPermission(caller, owner, verb);
  return owner;
}

export function requireReadAll(caller: ProjectEventSubscriptionPlatformCaller): void {
  if (!caller.permissions?.readAllSubscriptions) {
    throw errors.forbidden('Platform caller cannot read all event subscriptions');
  }
}

export function requireCancelAny(caller: ProjectEventSubscriptionPlatformCaller): void {
  if (!caller.permissions?.cancelAnySubscription) {
    throw errors.forbidden('Platform caller cannot cancel arbitrary event subscriptions');
  }
}

export function requireExpire(caller: ProjectEventSubscriptionPlatformCaller): void {
  if (!caller.permissions?.expireSubscriptions) {
    throw errors.forbidden('Platform caller cannot expire event subscriptions');
  }
}

export function ensureSpecificOwnerMatches(
  actual: ProjectEventSubscriptionOwner,
  expected: ProjectEventSubscriptionOwner | null | undefined
): void {
  if (!expected || !ownersEqual(actual, expected)) {
    throw errors.notFound('Event subscription');
  }
}

export function normalizeSubscriptionId(value: unknown): string {
  return assertNonEmptyString(value, 'subscriptionId');
}
