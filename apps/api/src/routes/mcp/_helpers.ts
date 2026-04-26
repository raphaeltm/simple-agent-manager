/**
 * Shared MCP route helpers — types, constants, limits, rate limiting, auth, and tool definitions.
 *
 * Used across all MCP tool handler files (instruction-tools, task-tools, session-tools, idea-tools).
 */
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { parsePositiveInt } from '../../lib/route-helpers';
import { type McpTokenData,validateMcpToken } from '../../services/mcp-token';

// Re-export McpTokenData for use by tool handler files
export type { McpTokenData } from '../../services/mcp-token';

// ─── JSON-RPC types ──────────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export function jsonRpcSuccess(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

export function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

// Standard JSON-RPC error codes
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

// ─── Configurable limits ─────────────────────────────────────────────────────

/** Default max length for progress/summary messages. Override via MAX_ACTIVITY_MESSAGE_LENGTH env var. */
const DEFAULT_ACTIVITY_MESSAGE_MAX_LENGTH = 2000;
/** Default max length for log messages. Override via MAX_LOG_MESSAGE_LENGTH env var. */
const DEFAULT_LOG_MESSAGE_MAX_LENGTH = 1000;
/** Default max length for task output summary stored in D1. Override via MAX_OUTPUT_SUMMARY_LENGTH env var. */
const DEFAULT_OUTPUT_SUMMARY_MAX_LENGTH = 10000;

/** Valid message roles for filtering in get_session_messages and search_messages. */
export const VALID_MESSAGE_ROLES = ['user', 'assistant', 'system', 'tool', 'thinking', 'plan'] as const;
export type MessageRole = typeof VALID_MESSAGE_ROLES[number];

/** Default HTTP-level rate limit for the /mcp endpoint (per token, per minute). Override via MCP_RATE_LIMIT env var. */
const DEFAULT_MCP_RATE_LIMIT = 120;
const DEFAULT_MCP_RATE_LIMIT_WINDOW_SECONDS = 60;

/** Default dispatch limits for agent-to-agent task spawning. */
const DEFAULT_MCP_DISPATCH_MAX_DEPTH = 3;
const DEFAULT_MCP_DISPATCH_MAX_PER_TASK = 5;
const DEFAULT_MCP_DISPATCH_MAX_ACTIVE_PER_PROJECT = 10;
const DEFAULT_MCP_DISPATCH_DESCRIPTION_MAX_LENGTH = 32_000;
const DEFAULT_MCP_DISPATCH_MAX_REFERENCES = 20;
const DEFAULT_MCP_DISPATCH_MAX_REFERENCE_LENGTH = 500;
const DEFAULT_MCP_DISPATCH_MAX_PRIORITY = 100;

/** Default page sizes for project awareness tools. Override via MCP_* env vars. */
const DEFAULT_MCP_TASK_LIST_LIMIT = 10;
const DEFAULT_MCP_TASK_LIST_MAX = 50;
const DEFAULT_MCP_TASK_SEARCH_MAX = 20;
const DEFAULT_MCP_SESSION_LIST_LIMIT = 10;
const DEFAULT_MCP_SESSION_LIST_MAX = 50;
const DEFAULT_MCP_MESSAGE_LIST_LIMIT = 50;
const DEFAULT_MCP_MESSAGE_LIST_MAX = 200;
const DEFAULT_MCP_MESSAGE_SEARCH_MAX = 20;
/** Max length for task description in list/search results. Override via MCP_TASK_DESCRIPTION_SNIPPET_LENGTH env var. */
const DEFAULT_MCP_TASK_DESCRIPTION_SNIPPET_LENGTH = 200;
/** Max length for idea link context string. Override via MCP_IDEA_CONTEXT_MAX_LENGTH env var. */
const DEFAULT_MCP_IDEA_CONTEXT_MAX_LENGTH = 500;
/** Max length for idea content (description). Override via MCP_IDEA_CONTENT_MAX_LENGTH env var. */
const DEFAULT_MCP_IDEA_CONTENT_MAX_LENGTH = 65_536;
/** Default page size for list_ideas. Override via MCP_IDEA_LIST_LIMIT env var. */
const DEFAULT_MCP_IDEA_LIST_LIMIT = 20;
/** Max page size for list_ideas. Override via MCP_IDEA_LIST_MAX env var. */
const DEFAULT_MCP_IDEA_LIST_MAX = 100;
/** Max results for search_ideas. Override via MCP_IDEA_SEARCH_MAX env var. */
const DEFAULT_MCP_IDEA_SEARCH_MAX = 20;
/** Max length for idea title. Override via MCP_IDEA_TITLE_MAX_LENGTH env var. */
const DEFAULT_MCP_IDEA_TITLE_MAX_LENGTH = 200;
/** Max length for session topic. Override via MCP_SESSION_TOPIC_MAX_LENGTH env var. */
const DEFAULT_MCP_SESSION_TOPIC_MAX_LENGTH = 200;
/** Max retry attempts for a single task via retry_subtask. Override via ORCHESTRATOR_MAX_RETRIES_PER_TASK env var. */
const DEFAULT_ORCHESTRATOR_MAX_RETRIES_PER_TASK = 3;
/** Max dependency edges per project via add_dependency. Override via ORCHESTRATOR_DEPENDENCY_MAX_EDGES env var. */
const DEFAULT_ORCHESTRATOR_DEPENDENCY_MAX_EDGES = 50;
/** Grace period in ms before hard stop after warning message. Override via ORCHESTRATOR_STOP_GRACE_MS env var. */
const DEFAULT_ORCHESTRATOR_STOP_GRACE_MS = 5000;
/** Max length for injected messages to child agents. Override via ORCHESTRATOR_MESSAGE_MAX_LENGTH env var. */
const DEFAULT_ORCHESTRATOR_MESSAGE_MAX_LENGTH = 32_768;
/** Agent mailbox defaults (durable messaging). Override via MAILBOX_* env vars. */
const DEFAULT_MAILBOX_ACK_TIMEOUT_MS = 300_000; // 5 min
const DEFAULT_MAILBOX_REDELIVERY_MAX_ATTEMPTS = 5;
const DEFAULT_MAILBOX_TTL_MS = 3_600_000; // 1 hour
const DEFAULT_MAILBOX_DELIVERY_POLL_INTERVAL_MS = 30_000; // 30s
const DEFAULT_MAILBOX_MAX_MESSAGES_PER_PROJECT = 1_000;
const DEFAULT_MAILBOX_MESSAGE_MAX_LENGTH = 32_768;
/** Knowledge graph defaults. Override via KNOWLEDGE_* env vars. */
const DEFAULT_KNOWLEDGE_MAX_ENTITIES = 500;
const DEFAULT_KNOWLEDGE_MAX_OBSERVATIONS = 100;
const DEFAULT_KNOWLEDGE_SEARCH_LIMIT = 20;
const DEFAULT_KNOWLEDGE_AUTO_RETRIEVE_LIMIT = 20;
const DEFAULT_KNOWLEDGE_OBSERVATION_MAX_LENGTH = 1000;
const DEFAULT_KNOWLEDGE_ENTITY_NAME_MAX_LENGTH = 200;
const DEFAULT_KNOWLEDGE_DESCRIPTION_MAX_LENGTH = 2000;

export function getMcpLimits(env: Env) {
  return {
    activityMessageMaxLength: parsePositiveInt(env.MAX_ACTIVITY_MESSAGE_LENGTH, DEFAULT_ACTIVITY_MESSAGE_MAX_LENGTH),
    logMessageMaxLength: parsePositiveInt(env.MAX_LOG_MESSAGE_LENGTH, DEFAULT_LOG_MESSAGE_MAX_LENGTH),
    outputSummaryMaxLength: parsePositiveInt(env.MAX_OUTPUT_SUMMARY_LENGTH, DEFAULT_OUTPUT_SUMMARY_MAX_LENGTH),
    taskListLimit: DEFAULT_MCP_TASK_LIST_LIMIT,
    taskListMax: DEFAULT_MCP_TASK_LIST_MAX,
    taskSearchMax: DEFAULT_MCP_TASK_SEARCH_MAX,
    sessionListLimit: DEFAULT_MCP_SESSION_LIST_LIMIT,
    sessionListMax: DEFAULT_MCP_SESSION_LIST_MAX,
    messageListLimit: parsePositiveInt(env.MCP_MESSAGE_LIST_LIMIT, DEFAULT_MCP_MESSAGE_LIST_LIMIT),
    messageListMax: parsePositiveInt(env.MCP_MESSAGE_LIST_MAX, DEFAULT_MCP_MESSAGE_LIST_MAX),
    messageSearchMax: parsePositiveInt(env.MCP_MESSAGE_SEARCH_MAX, DEFAULT_MCP_MESSAGE_SEARCH_MAX),
    taskDescriptionSnippetLength: parsePositiveInt(
      env.MCP_TASK_DESCRIPTION_SNIPPET_LENGTH,
      DEFAULT_MCP_TASK_DESCRIPTION_SNIPPET_LENGTH,
    ),
    dispatchMaxDepth: parsePositiveInt(env.MCP_DISPATCH_MAX_DEPTH, DEFAULT_MCP_DISPATCH_MAX_DEPTH),
    dispatchMaxPerTask: parsePositiveInt(env.MCP_DISPATCH_MAX_PER_TASK, DEFAULT_MCP_DISPATCH_MAX_PER_TASK),
    dispatchMaxActivePerProject: parsePositiveInt(env.MCP_DISPATCH_MAX_ACTIVE_PER_PROJECT, DEFAULT_MCP_DISPATCH_MAX_ACTIVE_PER_PROJECT),
    dispatchDescriptionMaxLength: parsePositiveInt(env.MCP_DISPATCH_DESCRIPTION_MAX_LENGTH, DEFAULT_MCP_DISPATCH_DESCRIPTION_MAX_LENGTH),
    dispatchMaxReferences: parsePositiveInt(env.MCP_DISPATCH_MAX_REFERENCES, DEFAULT_MCP_DISPATCH_MAX_REFERENCES),
    dispatchMaxReferenceLength: parsePositiveInt(env.MCP_DISPATCH_MAX_REFERENCE_LENGTH, DEFAULT_MCP_DISPATCH_MAX_REFERENCE_LENGTH),
    dispatchMaxPriority: parsePositiveInt(env.MCP_DISPATCH_MAX_PRIORITY, DEFAULT_MCP_DISPATCH_MAX_PRIORITY),
    ideaContextMaxLength: parsePositiveInt(env.MCP_IDEA_CONTEXT_MAX_LENGTH, DEFAULT_MCP_IDEA_CONTEXT_MAX_LENGTH),
    ideaContentMaxLength: parsePositiveInt(env.MCP_IDEA_CONTENT_MAX_LENGTH, DEFAULT_MCP_IDEA_CONTENT_MAX_LENGTH),
    ideaListLimit: parsePositiveInt(env.MCP_IDEA_LIST_LIMIT, DEFAULT_MCP_IDEA_LIST_LIMIT),
    ideaListMax: parsePositiveInt(env.MCP_IDEA_LIST_MAX, DEFAULT_MCP_IDEA_LIST_MAX),
    ideaSearchMax: parsePositiveInt(env.MCP_IDEA_SEARCH_MAX, DEFAULT_MCP_IDEA_SEARCH_MAX),
    ideaTitleMaxLength: parsePositiveInt(env.MCP_IDEA_TITLE_MAX_LENGTH, DEFAULT_MCP_IDEA_TITLE_MAX_LENGTH),
    sessionTopicMaxLength: parsePositiveInt(env.MCP_SESSION_TOPIC_MAX_LENGTH, DEFAULT_MCP_SESSION_TOPIC_MAX_LENGTH),
    orchestratorMaxRetriesPerTask: parsePositiveInt(env.ORCHESTRATOR_MAX_RETRIES_PER_TASK, DEFAULT_ORCHESTRATOR_MAX_RETRIES_PER_TASK),
    orchestratorDependencyMaxEdges: parsePositiveInt(env.ORCHESTRATOR_DEPENDENCY_MAX_EDGES, DEFAULT_ORCHESTRATOR_DEPENDENCY_MAX_EDGES),
    orchestratorStopGraceMs: parsePositiveInt(env.ORCHESTRATOR_STOP_GRACE_MS, DEFAULT_ORCHESTRATOR_STOP_GRACE_MS),
    orchestratorMessageMaxLength: parsePositiveInt(env.ORCHESTRATOR_MESSAGE_MAX_LENGTH, DEFAULT_ORCHESTRATOR_MESSAGE_MAX_LENGTH),
    knowledgeMaxEntities: parsePositiveInt(env.KNOWLEDGE_MAX_ENTITIES_PER_PROJECT, DEFAULT_KNOWLEDGE_MAX_ENTITIES),
    knowledgeMaxObservations: parsePositiveInt(env.KNOWLEDGE_MAX_OBSERVATIONS_PER_ENTITY, DEFAULT_KNOWLEDGE_MAX_OBSERVATIONS),
    knowledgeSearchLimit: parsePositiveInt(env.KNOWLEDGE_SEARCH_LIMIT, DEFAULT_KNOWLEDGE_SEARCH_LIMIT),
    knowledgeAutoRetrieveLimit: parsePositiveInt(env.KNOWLEDGE_AUTO_RETRIEVE_LIMIT, DEFAULT_KNOWLEDGE_AUTO_RETRIEVE_LIMIT),
    knowledgeObservationMaxLength: parsePositiveInt(env.KNOWLEDGE_OBSERVATION_MAX_LENGTH, DEFAULT_KNOWLEDGE_OBSERVATION_MAX_LENGTH),
    knowledgeEntityNameMaxLength: parsePositiveInt(env.KNOWLEDGE_ENTITY_NAME_MAX_LENGTH, DEFAULT_KNOWLEDGE_ENTITY_NAME_MAX_LENGTH),
    knowledgeDescriptionMaxLength: parsePositiveInt(env.KNOWLEDGE_DESCRIPTION_MAX_LENGTH, DEFAULT_KNOWLEDGE_DESCRIPTION_MAX_LENGTH),
    // Mailbox (durable messaging)
    mailboxAckTimeoutMs: parsePositiveInt(env.MAILBOX_ACK_TIMEOUT_MS, DEFAULT_MAILBOX_ACK_TIMEOUT_MS),
    mailboxRedeliveryMaxAttempts: parsePositiveInt(env.MAILBOX_REDELIVERY_MAX_ATTEMPTS, DEFAULT_MAILBOX_REDELIVERY_MAX_ATTEMPTS),
    mailboxTtlMs: parsePositiveInt(env.MAILBOX_TTL_MS, DEFAULT_MAILBOX_TTL_MS),
    mailboxDeliveryPollIntervalMs: parsePositiveInt(env.MAILBOX_DELIVERY_POLL_INTERVAL_MS, DEFAULT_MAILBOX_DELIVERY_POLL_INTERVAL_MS),
    mailboxMaxMessagesPerProject: parsePositiveInt(env.MAILBOX_MAX_MESSAGES_PER_PROJECT, DEFAULT_MAILBOX_MAX_MESSAGES_PER_PROJECT),
    mailboxMessageMaxLength: parsePositiveInt(env.MAILBOX_MESSAGE_MAX_LENGTH, DEFAULT_MAILBOX_MESSAGE_MAX_LENGTH),
  };
}

/** Strip null bytes, Unicode bidi overrides, and C0/C1 control chars (except \n, \t) from user/agent input. */
export function sanitizeUserInput(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '');
}

// MCP protocol constants
export const MCP_PROTOCOL_VERSION = '2025-03-26';
export const MCP_SERVER_NAME = 'sam-mcp';
export const MCP_SERVER_VERSION = '1.0.0';

// Task status sets
export const ACTIVE_STATUSES = ['queued', 'in_progress', 'delegated', 'awaiting_followup'];

/**
 * Validate and filter a roles array against the allowlist.
 * Returns null if any role is invalid (caller should return 400).
 * Returns filtered valid roles, or the default if input is not an array.
 */
export function validateRoles(
  input: unknown,
  defaultRoles: MessageRole[] = ['user', 'assistant'],
): { valid: true; roles: MessageRole[] } | { valid: false; invalid: string[] } {
  if (!Array.isArray(input)) {
    return { valid: true, roles: defaultRoles };
  }
  const strings = input.filter((r): r is string => typeof r === 'string');
  const invalid = strings.filter((r) => !(VALID_MESSAGE_ROLES as readonly string[]).includes(r));
  if (invalid.length > 0) {
    return { valid: false, invalid };
  }
  const roles = strings.length > 0 ? (strings as MessageRole[]) : defaultRoles;
  return { valid: true, roles };
}

// ─── Rate limiting ──────────────────────────────────────────────────────────

export function getMcpRateLimit(env: Env): number {
  const val = parsePositiveInt(env.MCP_RATE_LIMIT as string, DEFAULT_MCP_RATE_LIMIT);
  return val;
}

function getMcpRateLimitWindow(env: Env): number {
  const val = parsePositiveInt(env.MCP_RATE_LIMIT_WINDOW_SECONDS as string, DEFAULT_MCP_RATE_LIMIT_WINDOW_SECONDS);
  return val;
}

/**
 * Check MCP endpoint rate limit using KV. Keyed by taskId to limit per-agent throughput.
 *
 * NOTE: KV does not support atomic read-modify-write. Under high concurrency from
 * the same taskId, two requests may read the same count and both increment to the
 * same value, allowing limit+1 requests through. This is a known limitation shared
 * with all KV-based rate limiters in the codebase (see middleware/rate-limit.ts).
 * For the MCP use case this is acceptable — each agent has a unique taskId, so
 * concurrency is bounded by agent parallelism (typically 1). A Durable Object-based
 * rate limiter would provide true atomicity if stricter enforcement is needed.
 */
export async function checkMcpRateLimit(
  kv: KVNamespace,
  taskId: string,
  env: Env,
): Promise<{ allowed: true; remaining: number; resetAt: number } | { allowed: false; remaining: 0; resetAt: number; retryAfter: number }> {
  const limit = getMcpRateLimit(env);
  const windowSeconds = getMcpRateLimitWindow(env);
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / windowSeconds) * windowSeconds;
  const resetAt = windowStart + windowSeconds;
  const key = `ratelimit:mcp:${taskId}:${windowStart}`;

  const existing = await kv.get<{ count: number; windowStart: number }>(key, 'json');

  if (!existing || existing.windowStart !== windowStart) {
    await kv.put(key, JSON.stringify({ count: 1, windowStart }), {
      expirationTtl: windowSeconds + 60,
    });
    return { allowed: true, remaining: limit - 1, resetAt };
  }

  const newCount = existing.count + 1;
  const allowed = newCount <= limit;
  const remaining = Math.max(0, limit - newCount);

  await kv.put(key, JSON.stringify({ count: newCount, windowStart }), {
    expirationTtl: windowSeconds + 60,
  });

  if (!allowed) {
    const retryAfter = Math.max(1, resetAt - now);
    return { allowed: false, remaining: 0, resetAt, retryAfter };
  }

  return { allowed: true, remaining, resetAt };
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

/**
 * Returns [tokenData, rawToken] or [null, null].
 * Unlike extractBearerToken(), this returns null on missing/malformed auth
 * because MCP endpoints fall through to unauthenticated handling.
 */
export async function authenticateMcpRequest(
  authHeader: string | undefined,
  kv: KVNamespace,
): Promise<[McpTokenData, string] | [null, null]> {
  if (!authHeader?.startsWith('Bearer ') || authHeader.length <= 7) {
    return [null, null];
  }
  const token = authHeader.slice(7);
  const data = await validateMcpToken(kv, token);
  return data ? [data, token] : [null, null];
}

// ─── Session resolution ─────────────────────────────────────────────────────

/**
 * Resolve the current chat session ID from the workspace ID in the MCP token.
 * Returns null if the workspace has no linked session.
 */
export async function resolveSessionId(env: Env, workspaceId: string): Promise<string | null> {
  try {
    const row = await env.DATABASE.prepare('SELECT chat_session_id FROM workspaces WHERE id = ?')
      .bind(workspaceId)
      .first<{ chat_session_id: string | null }>();
    return row?.chat_session_id ?? null;
  } catch (err) {
    log.error('mcp.resolve_session_id_failed', { workspaceId, error: String(err) });
    return null;
  }
}

// Re-export tool definitions from dedicated file
export { MCP_TOOLS } from './tool-definitions';
