/**
 * MCP Server Route
 *
 * Implements a lightweight MCP (Model Context Protocol) server using
 * JSON-RPC 2.0 over HTTP (Streamable HTTP transport). Exposes tools
 * to agents running in SAM workspaces:
 *
 * Task lifecycle:
 * - get_instructions: Bootstrap tool — returns task context, project info, and behavioral guidance
 * - update_task_status: Report incremental progress on task checklist items
 * - complete_task: Mark the task as completed with an optional summary
 *
 * Task dispatch (agent-to-agent):
 * - dispatch_task: Spawn a new task in the current project (with recursion depth + rate limiting)
 *
 * Project awareness (read-only):
 * - list_tasks: List other tasks in the same project
 * - get_task_details: Get full details of a specific task
 * - search_tasks: Search tasks by keyword in title/description
 * - list_sessions: List chat sessions in the project
 * - get_session_messages: Read messages from a specific session
 * - search_messages: Search messages across sessions by keyword
 *
 * Auth: task-scoped opaque token stored in KV, passed as Bearer token.
 */

import { Hono } from 'hono';
import { and, eq, like, or, desc, sql, inArray } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { Env } from '../index';
import type { VMSize, VMLocation, WorkspaceProfile, CredentialProvider } from '@simple-agent-manager/shared';
import { DEFAULT_VM_SIZE, DEFAULT_VM_LOCATION, DEFAULT_WORKSPACE_PROFILE } from '@simple-agent-manager/shared';
import * as schema from '../db/schema';
import { validateMcpToken, type McpTokenData } from '../services/mcp-token';
import * as projectDataService from '../services/project-data';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import { ulid } from '../lib/ulid';
import { generateBranchName } from '../services/branch-name';
import { startTaskRunnerDO } from '../services/task-runner-do';
import { generateTaskTitle, getTaskTitleConfig } from '../services/task-title';

export const mcpRoutes = new Hono<{ Bindings: Env }>();

// ─── JSON-RPC types ──────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function jsonRpcSuccess(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

// Standard JSON-RPC error codes
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

// ─── Configurable limits ─────────────────────────────────────────────────────

/** Default max length for progress/summary messages. Override via MAX_ACTIVITY_MESSAGE_LENGTH env var. */
const DEFAULT_ACTIVITY_MESSAGE_MAX_LENGTH = 2000;
/** Default max length for log messages. Override via MAX_LOG_MESSAGE_LENGTH env var. */
const DEFAULT_LOG_MESSAGE_MAX_LENGTH = 1000;
/** Default max length for task output summary stored in D1. Override via MAX_OUTPUT_SUMMARY_LENGTH env var. */
const DEFAULT_OUTPUT_SUMMARY_MAX_LENGTH = 10000;

/** Valid message roles for filtering in get_session_messages and search_messages. */
const VALID_MESSAGE_ROLES = ['user', 'assistant', 'system', 'tool', 'thinking', 'plan'] as const;
type MessageRole = typeof VALID_MESSAGE_ROLES[number];

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

function getMcpLimits(env: Env) {
  return {
    activityMessageMaxLength: parsePositiveInt(env.MAX_ACTIVITY_MESSAGE_LENGTH as string, DEFAULT_ACTIVITY_MESSAGE_MAX_LENGTH),
    logMessageMaxLength: parsePositiveInt(env.MAX_LOG_MESSAGE_LENGTH as string, DEFAULT_LOG_MESSAGE_MAX_LENGTH),
    outputSummaryMaxLength: parsePositiveInt(env.MAX_OUTPUT_SUMMARY_LENGTH as string, DEFAULT_OUTPUT_SUMMARY_MAX_LENGTH),
    taskListLimit: DEFAULT_MCP_TASK_LIST_LIMIT,
    taskListMax: DEFAULT_MCP_TASK_LIST_MAX,
    taskSearchMax: DEFAULT_MCP_TASK_SEARCH_MAX,
    sessionListLimit: DEFAULT_MCP_SESSION_LIST_LIMIT,
    sessionListMax: DEFAULT_MCP_SESSION_LIST_MAX,
    messageListLimit: DEFAULT_MCP_MESSAGE_LIST_LIMIT,
    messageListMax: DEFAULT_MCP_MESSAGE_LIST_MAX,
    messageSearchMax: DEFAULT_MCP_MESSAGE_SEARCH_MAX,
    taskDescriptionSnippetLength: parsePositiveInt(
      env.MCP_TASK_DESCRIPTION_SNIPPET_LENGTH as string,
      DEFAULT_MCP_TASK_DESCRIPTION_SNIPPET_LENGTH,
    ),
    dispatchMaxDepth: parsePositiveInt(env.MCP_DISPATCH_MAX_DEPTH as string, DEFAULT_MCP_DISPATCH_MAX_DEPTH),
    dispatchMaxPerTask: parsePositiveInt(env.MCP_DISPATCH_MAX_PER_TASK as string, DEFAULT_MCP_DISPATCH_MAX_PER_TASK),
    dispatchMaxActivePerProject: parsePositiveInt(env.MCP_DISPATCH_MAX_ACTIVE_PER_PROJECT as string, DEFAULT_MCP_DISPATCH_MAX_ACTIVE_PER_PROJECT),
    dispatchDescriptionMaxLength: parsePositiveInt(env.MCP_DISPATCH_DESCRIPTION_MAX_LENGTH as string, DEFAULT_MCP_DISPATCH_DESCRIPTION_MAX_LENGTH),
    dispatchMaxReferences: parsePositiveInt(env.MCP_DISPATCH_MAX_REFERENCES as string, DEFAULT_MCP_DISPATCH_MAX_REFERENCES),
    dispatchMaxReferenceLength: parsePositiveInt(env.MCP_DISPATCH_MAX_REFERENCE_LENGTH as string, DEFAULT_MCP_DISPATCH_MAX_REFERENCE_LENGTH),
    dispatchMaxPriority: parsePositiveInt(env.MCP_DISPATCH_MAX_PRIORITY as string, DEFAULT_MCP_DISPATCH_MAX_PRIORITY),
  };
}

// MCP protocol constants
const MCP_PROTOCOL_VERSION = '2025-03-26';
const MCP_SERVER_NAME = 'sam-mcp';
const MCP_SERVER_VERSION = '1.0.0';

// Task status sets
const ACTIVE_STATUSES = ['queued', 'in_progress', 'delegated', 'awaiting_followup'];

// ─── MCP tool definitions ────────────────────────────────────────────────────

const MCP_TOOLS = [
  {
    name: 'get_instructions',
    description:
      'You MUST call this tool before starting any work. It provides your task context, project information, and instructions for reporting progress.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'update_task_status',
    description:
      'Report incremental progress on your current task. Call this when you complete a checklist item or reach a milestone.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        message: {
          type: 'string',
          description: 'Progress update message describing what was completed',
        },
      },
      required: ['message'],
      additionalProperties: false,
    },
  },
  {
    name: 'complete_task',
    description:
      'Mark the current task as completed. Call this after all work is done and changes are pushed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        summary: {
          type: 'string',
          description: 'Brief summary of what was accomplished',
        },
      },
      additionalProperties: false,
    },
  },
  // ─── Task dispatch (agent-to-agent) ────────────────────────────────────
  {
    name: 'dispatch_task',
    description:
      'Dispatch a new task to another agent in the current project. Use this to spawn parallel work, delegate sub-tasks, or follow up on findings. The dispatched task runs independently in a new workspace. Rate-limited: max dispatch depth, per-task limit, and per-project active limit apply.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        description: {
          type: 'string',
          description: 'Task description — synthesize context from your conversation into a clear, actionable brief. Do NOT dump raw conversation history.',
        },
        vmSize: {
          type: 'string',
          description: 'VM size for the dispatched task (small, medium, large). Defaults to project default.',
          enum: ['small', 'medium', 'large'],
        },
        priority: {
          type: 'number',
          description: 'Task priority (0 = default). Higher values = higher priority.',
        },
        references: {
          type: 'array',
          items: { type: 'string' },
          description: 'File paths, spec references, or URLs to include as context for the dispatched agent.',
        },
      },
      required: ['description'],
      additionalProperties: false,
    },
  },
  // ─── Project awareness tools (read-only) ──────────────────────────────
  {
    name: 'list_tasks',
    description:
      'List tasks in your project. Useful for understanding what other work exists, avoiding duplicates, or finding context from completed tasks. Your own task is excluded by default.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        status: {
          type: 'string',
          description: 'Filter by task status (draft, queued, in_progress, delegated, awaiting_followup, completed, failed, cancelled). Omit for all statuses.',
          enum: ['draft', 'queued', 'in_progress', 'delegated', 'awaiting_followup', 'completed', 'failed', 'cancelled'],
        },
        include_own: {
          type: 'boolean',
          description: 'Include your own task in the results (default: false)',
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default: 10, max: 50)',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_task_details',
    description:
      'Get full details of a specific task in your project, including its description, output summary, output branch, and PR URL.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: {
          type: 'string',
          description: 'The task ID to retrieve',
        },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_tasks',
    description:
      'Search tasks in your project by keyword. Searches both title and description fields.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search keyword to find in task titles and descriptions',
        },
        status: {
          type: 'string',
          description: 'Filter by task status. Omit for all statuses.',
          enum: ['draft', 'queued', 'in_progress', 'delegated', 'awaiting_followup', 'completed', 'failed', 'cancelled'],
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default: 10, max: 20)',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_sessions',
    description:
      'List chat sessions in your project. Each session represents a conversation between a user and an agent. Sessions may be linked to tasks.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        status: {
          type: 'string',
          description: 'Filter by session status (active, stopped). Omit for all.',
          enum: ['active', 'stopped'],
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default: 10, max: 50)',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_session_messages',
    description:
      'Read messages from a specific chat session. Returns messages in chronological order. By default only returns user and assistant messages (skips tool calls and system messages).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: {
          type: 'string',
          description: 'The session ID to read messages from',
        },
        limit: {
          type: 'number',
          description: 'Max messages to return (default: 50, max: 200)',
        },
        roles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by message roles (default: ["user", "assistant"]). Use ["user", "assistant", "system", "tool", "thinking", "plan"] for all.',
        },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_messages',
    description:
      'Search messages across all chat sessions in your project by keyword. Returns matching message snippets with session context. Useful for finding past discussions about specific topics, decisions, or code.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search keyword to find in message content',
        },
        sessionId: {
          type: 'string',
          description: 'Narrow search to a specific session (optional)',
        },
        roles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by message roles (default: ["user", "assistant"])',
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default: 10, max: 20)',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
];

/**
 * Validate and filter a roles array against the allowlist.
 * Returns null if any role is invalid (caller should return 400).
 * Returns filtered valid roles, or the default if input is not an array.
 */
function validateRoles(
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

function getMcpRateLimit(env: Env): number {
  const val = parsePositiveInt(env.MCP_RATE_LIMIT as string, DEFAULT_MCP_RATE_LIMIT);
  return val;
}

function getMcpRateLimitWindow(env: Env): number {
  const val = parsePositiveInt(env.MCP_RATE_LIMIT_WINDOW_SECONDS as string, DEFAULT_MCP_RATE_LIMIT_WINDOW_SECONDS);
  return val;
}

/**
 * Check MCP endpoint rate limit using KV. Keyed by taskId to limit per-agent throughput.
 * Returns null if allowed, or a JSON-RPC error response if rate limited.
 */
async function checkMcpRateLimit(
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

// ─── Auth middleware ─────────────────────────────────────────────────────────

/** Returns [tokenData, rawToken] or [null, null] */
async function authenticateMcpRequest(
  authHeader: string | undefined,
  kv: KVNamespace,
): Promise<[McpTokenData, string] | [null, null]> {
  if (!authHeader?.startsWith('Bearer ')) {
    return [null, null];
  }
  const token = authHeader.slice(7);
  if (!token) {
    return [null, null];
  }
  const data = await validateMcpToken(kv, token);
  return data ? [data, token] : [null, null];
}

// ─── Tool handlers ───────────────────────────────────────────────────────────

async function handleGetInstructions(
  requestId: string | number | null,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const db = drizzle(env.DATABASE, { schema });

  // Fetch task
  const taskRows = await db
    .select()
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.id, tokenData.taskId),
        eq(schema.tasks.projectId, tokenData.projectId),
      ),
    )
    .limit(1);

  const task = taskRows[0];
  if (!task) {
    return jsonRpcError(requestId, INTERNAL_ERROR, 'Task not found');
  }

  // Fetch project
  const projectRows = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, tokenData.projectId))
    .limit(1);

  const project = projectRows[0];
  if (!project) {
    return jsonRpcError(requestId, INTERNAL_ERROR, 'Project not found');
  }

  const result = {
    task: {
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      priority: task.priority,
      outputBranch: task.outputBranch,
    },
    project: {
      id: project.id,
      name: project.name,
      repository: project.repository,
      defaultBranch: project.defaultBranch,
    },
    instructions: [
      'Call `update_task_status` to report progress as you complete significant milestones.',
      'Call `complete_task` with a summary when all work is done.',
      'Push your changes to the output branch before calling `complete_task`.',
      'If you encounter blockers, report them via `update_task_status` with a clear description.',
    ],
  };

  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  });
}

async function handleUpdateTaskStatus(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const message = params.message;
  if (typeof message !== 'string' || !message.trim()) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'message is required and must be a non-empty string');
  }

  const db = drizzle(env.DATABASE, { schema });

  // Verify task exists, belongs to this project, and is in an active state
  const taskRows = await db
    .select({ id: schema.tasks.id, status: schema.tasks.status })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.id, tokenData.taskId),
        eq(schema.tasks.projectId, tokenData.projectId),
      ),
    )
    .limit(1);

  const task = taskRows[0];
  if (!task) {
    return jsonRpcError(requestId, INTERNAL_ERROR, 'Task not found');
  }

  // Reject updates on tasks in terminal states
  if (!ACTIVE_STATUSES.includes(task.status)) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `Task status updates cannot be made after task reaches status '${task.status}'`,
    );
  }

  // Record the progress update as an activity event via ProjectData DO
  try {
    const doId = env.PROJECT_DATA.idFromName(tokenData.projectId);
    const doStub = env.PROJECT_DATA.get(doId);
    await doStub.fetch(new Request('https://do/activity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'task.progress',
        actorType: 'agent',
        actorId: tokenData.workspaceId,
        metadata: {
          taskId: tokenData.taskId,
          message: message.trim().slice(0, getMcpLimits(env).activityMessageMaxLength),
        },
      }),
    }));
  } catch (err) {
    log.warn('mcp.update_task_status.activity_event_failed', {
      taskId: tokenData.taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  log.info('mcp.update_task_status', {
    taskId: tokenData.taskId,
    projectId: tokenData.projectId,
    message: message.trim().slice(0, getMcpLimits(env).logMessageMaxLength),
  });

  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: 'Progress update recorded.' }],
  });
}

async function handleCompleteTask(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const summary = typeof params.summary === 'string' ? params.summary.trim() : null;

  const now = new Date().toISOString();

  // Atomic conditional UPDATE — only transitions from completable statuses.
  // This prevents the TOCTOU race of a separate SELECT + UPDATE.
  const result = await env.DATABASE.prepare(
    `UPDATE tasks SET status = 'completed', completed_at = ?, output_summary = COALESCE(?, output_summary), updated_at = ?
     WHERE id = ? AND project_id = ? AND status IN ('in_progress', 'delegated', 'awaiting_followup')`,
  ).bind(
    now,
    summary ? summary.slice(0, getMcpLimits(env).outputSummaryMaxLength) : null,
    now,
    tokenData.taskId,
    tokenData.projectId,
  ).run();

  if (!result.meta.changes || result.meta.changes === 0) {
    // Either task doesn't exist, wrong project, or not in a completable state
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'Task cannot be completed — it may not exist or is not in a completable status',
    );
  }

  // Record completion activity event
  try {
    const doId = env.PROJECT_DATA.idFromName(tokenData.projectId);
    const doStub = env.PROJECT_DATA.get(doId);
    await doStub.fetch(new Request('https://do/activity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'task.completed',
        actorType: 'agent',
        actorId: tokenData.workspaceId,
        metadata: {
          taskId: tokenData.taskId,
          summary: summary?.slice(0, getMcpLimits(env).activityMessageMaxLength) ?? null,
        },
      }),
    }));
  } catch (err) {
    log.warn('mcp.complete_task.activity_event_failed', {
      taskId: tokenData.taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Note: Token is NOT revoked here. The MCP connection outlives individual
  // tasks (scoped to the ACP session / workspace lifetime). Revoking on
  // complete_task would break all subsequent MCP calls in the same session.
  // Token cleanup is handled by:
  //   1. KV TTL auto-expiration (default 2 hours, configurable via MCP_TOKEN_TTL_SECONDS)
  //   2. Task-runner DO cleanup on failure (task-runner.ts)

  log.info('mcp.complete_task', {
    taskId: tokenData.taskId,
    projectId: tokenData.projectId,
    summary: summary?.slice(0, getMcpLimits(env).logMessageMaxLength) ?? null,
  });

  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: 'Task marked as completed.' }],
  });
}

// ─── Task dispatch handler ───────────────────────────────────────────────────

async function handleDispatchTask(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const limits = getMcpLimits(env);
  const db = drizzle(env.DATABASE, { schema });

  // ── Validate description ────────────────────────────────────────────────
  const description = typeof params.description === 'string' ? params.description.trim() : '';
  if (!description) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'description is required and must be a non-empty string');
  }
  if (description.length > limits.dispatchDescriptionMaxLength) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `description exceeds maximum length of ${limits.dispatchDescriptionMaxLength} characters`,
    );
  }

  let vmSize: VMSize | undefined;
  if (params.vmSize !== undefined) {
    if (typeof params.vmSize !== 'string' || !['small', 'medium', 'large'].includes(params.vmSize)) {
      return jsonRpcError(requestId, INVALID_PARAMS, 'vmSize must be small, medium, or large');
    }
    vmSize = params.vmSize as VMSize;
  }

  // Clamp priority to [0, max] to prevent agents from monopolizing the task queue
  const priority = typeof params.priority === 'number'
    ? Math.min(Math.max(0, Math.round(params.priority)), limits.dispatchMaxPriority)
    : 0;
  const references = Array.isArray(params.references)
    ? params.references
        .filter((r): r is string => typeof r === 'string')
        .slice(0, limits.dispatchMaxReferences)
        .map((r) => r.slice(0, limits.dispatchMaxReferenceLength))
    : [];

  // ── Look up current task to get dispatch depth ──────────────────────────
  const [currentTask] = await db
    .select({
      id: schema.tasks.id,
      dispatchDepth: schema.tasks.dispatchDepth,
      outputBranch: schema.tasks.outputBranch,
      status: schema.tasks.status,
    })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.id, tokenData.taskId),
        eq(schema.tasks.projectId, tokenData.projectId),
      ),
    )
    .limit(1);

  if (!currentTask) {
    return jsonRpcError(requestId, INTERNAL_ERROR, 'Current task not found');
  }

  if (!ACTIVE_STATUSES.includes(currentTask.status)) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `Cannot dispatch from a task in '${currentTask.status}' status`,
    );
  }

  // ── Enforce dispatch depth limit ────────────────────────────────────────
  const newDepth = currentTask.dispatchDepth + 1;
  if (newDepth > limits.dispatchMaxDepth) {
    log.warn('mcp.dispatch_task.depth_exceeded', {
      taskId: tokenData.taskId,
      projectId: tokenData.projectId,
      currentDepth: currentTask.dispatchDepth,
      maxDepth: limits.dispatchMaxDepth,
    });
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `Dispatch depth limit exceeded. Current depth: ${currentTask.dispatchDepth}, max allowed: ${limits.dispatchMaxDepth}. ` +
      'Agent-dispatched tasks have a depth limit to prevent runaway recursive spawning.',
    );
  }

  // ── Parallel: pre-flight checks, credential check, project fetch, and AI title ─
  // These queries are independent of each other (only depend on currentTask for depth,
  // which was already checked above). Running them in parallel saves 4 sequential D1
  // round-trips + 1 Workers AI call.
  // The COUNT queries here are advisory (fast-fail). Atomic enforcement happens later
  // via D1 batch (COUNT + INSERT in implicit transaction) to prevent TOCTOU races.
  const titleConfig = getTaskTitleConfig(env);
  const [
    [childCountResult],
    [activeDispatchedResult],
    [credential],
    [project],
    taskTitle,
  ] = await Promise.all([
    db.select({ count: sql<number>`count(*)` })
      .from(schema.tasks)
      .where(and(
        eq(schema.tasks.parentTaskId, tokenData.taskId),
        eq(schema.tasks.projectId, tokenData.projectId),
        inArray(schema.tasks.status, ACTIVE_STATUSES),
      )),
    db.select({ count: sql<number>`count(*)` })
      .from(schema.tasks)
      .where(and(
        eq(schema.tasks.projectId, tokenData.projectId),
        inArray(schema.tasks.status, ACTIVE_STATUSES),
        sql`${schema.tasks.dispatchDepth} > 0`,
      )),
    db.select({ id: schema.credentials.id })
      .from(schema.credentials)
      .where(and(
        eq(schema.credentials.userId, tokenData.userId),
        eq(schema.credentials.credentialType, 'cloud-provider'),
      ))
      .limit(1),
    db.select()
      .from(schema.projects)
      .where(eq(schema.projects.id, tokenData.projectId))
      .limit(1),
    generateTaskTitle(env.AI, description, titleConfig),
  ]);

  // ── Advisory pre-checks (fast-fail before expensive operations) ─────────
  const childCount = childCountResult?.count ?? 0;
  if (childCount >= limits.dispatchMaxPerTask) {
    log.warn('mcp.dispatch_task.per_task_limit', {
      taskId: tokenData.taskId,
      projectId: tokenData.projectId,
      childCount,
      maxPerTask: limits.dispatchMaxPerTask,
    });
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `Per-task dispatch limit reached (${childCount}/${limits.dispatchMaxPerTask}). ` +
      'A single agent can only dispatch a limited number of tasks to prevent resource exhaustion.',
    );
  }

  const activeDispatched = activeDispatchedResult?.count ?? 0;
  if (activeDispatched >= limits.dispatchMaxActivePerProject) {
    log.warn('mcp.dispatch_task.project_active_limit', {
      projectId: tokenData.projectId,
      activeDispatched,
      maxActive: limits.dispatchMaxActivePerProject,
    });
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `Project has ${activeDispatched} active agent-dispatched tasks (limit: ${limits.dispatchMaxActivePerProject}). ` +
      'Wait for existing tasks to complete before dispatching more.',
    );
  }

  // ── Verify cloud credentials exist for the user ─────────────────────────
  if (!credential) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'Cloud provider credentials required. The user must connect a cloud provider in Settings.',
    );
  }

  // ── Verify project exists ──────────────────────────────────────────────
  if (!project) {
    return jsonRpcError(requestId, INTERNAL_ERROR, 'Project not found');
  }

  // ── Build the task description with references ──────────────────────────
  let fullDescription = description;
  if (references.length > 0) {
    fullDescription += '\n\n## References\n' + references.map((r) => `- ${r}`).join('\n');
  }
  // Enforce length limit on the final description (after reference concatenation)
  if (fullDescription.length > limits.dispatchDescriptionMaxLength) {
    fullDescription = fullDescription.slice(0, limits.dispatchDescriptionMaxLength);
  }

  // ── Create the task ─────────────────────────────────────────────────────
  const taskId = ulid();
  const now = new Date().toISOString();

  // Generate branch name (CPU-only, no I/O)
  const branchPrefix = env.BRANCH_NAME_PREFIX || 'sam/';
  const branchMaxLength = parseInt(env.BRANCH_NAME_MAX_LENGTH || '60', 10);
  const branchName = generateBranchName(description, taskId, {
    prefix: branchPrefix,
    maxLength: branchMaxLength,
  });

  // Determine VM config (explicit > project default > platform default)
  const resolvedVmSize: VMSize = vmSize
    ?? (project.defaultVmSize as VMSize | null)
    ?? DEFAULT_VM_SIZE;
  const resolvedVmLocation: VMLocation = DEFAULT_VM_LOCATION;
  const resolvedWorkspaceProfile: WorkspaceProfile = (project.defaultWorkspaceProfile as WorkspaceProfile | null)
    ?? DEFAULT_WORKSPACE_PROFILE;
  const resolvedProvider: CredentialProvider | null = (project.defaultProvider as CredentialProvider | null) ?? null;

  // Use parent task's output branch as checkout branch if available
  const checkoutBranch = currentTask.outputBranch || project.defaultBranch;

  // ── Atomic rate-limit check + insert via D1 batch (implicit transaction) ─
  // This prevents TOCTOU races where concurrent dispatch calls both pass the
  // advisory COUNT checks above and then both INSERT, bypassing the limit.
  // D1 batch wraps all statements in an implicit transaction — the re-checked
  // COUNTs and the INSERT see a consistent snapshot.
  const activeStatusList = ACTIVE_STATUSES.map((s) => `'${s}'`).join(', ');
  const childCountStmt = env.DATABASE.prepare(
    `SELECT count(*) AS cnt FROM tasks
     WHERE parent_task_id = ? AND project_id = ?
     AND status IN (${activeStatusList})`,
  ).bind(tokenData.taskId, tokenData.projectId);

  const activeDispatchedStmt = env.DATABASE.prepare(
    `SELECT count(*) AS cnt FROM tasks
     WHERE project_id = ? AND status IN (${activeStatusList})
     AND dispatch_depth > 0`,
  ).bind(tokenData.projectId);

  const statusEventId = ulid();
  const insertTaskStmt = env.DATABASE.prepare(
    `INSERT INTO tasks (id, project_id, user_id, parent_task_id, title, description,
     status, execution_step, priority, dispatch_depth, output_branch, created_by,
     created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', 'node_selection', ?, ?, ?, ?, ?, ?)`,
  ).bind(
    taskId, tokenData.projectId, tokenData.userId, tokenData.taskId,
    taskTitle, fullDescription, priority, newDepth, branchName,
    tokenData.userId, now, now,
  );

  const insertEventStmt = env.DATABASE.prepare(
    `INSERT INTO task_status_events (id, task_id, from_status, to_status,
     actor_type, actor_id, reason, created_at)
     VALUES (?, ?, NULL, 'queued', 'agent', ?, ?, ?)`,
  ).bind(
    statusEventId, taskId, tokenData.workspaceId,
    `Dispatched by agent (depth ${newDepth}, parent task ${tokenData.taskId})`,
    now,
  );

  const batchResults = await env.DATABASE.batch([
    childCountStmt,
    activeDispatchedStmt,
    insertTaskStmt,
    insertEventStmt,
  ]);

  // Check the atomic COUNT results — if limits were exceeded between advisory
  // check and batch execution, the INSERT already happened but we detect it here
  // and fail the task. In practice this window is tiny since the batch is atomic.
  const atomicChildCount = (batchResults[0]?.results?.[0] as { cnt: number } | undefined)?.cnt ?? 0;
  const atomicActiveCount = (batchResults[1]?.results?.[0] as { cnt: number } | undefined)?.cnt ?? 0;

  // The INSERT already executed in the batch, but if limits were breached we
  // immediately mark the task as failed and return an error. This is a safety net
  // — the pre-flight checks above should catch most cases.
  if (atomicChildCount > limits.dispatchMaxPerTask || atomicActiveCount > limits.dispatchMaxActivePerProject) {
    log.warn('mcp.dispatch_task.atomic_limit_breach', {
      taskId,
      projectId: tokenData.projectId,
      atomicChildCount,
      atomicActiveCount,
      maxPerTask: limits.dispatchMaxPerTask,
      maxActive: limits.dispatchMaxActivePerProject,
    });
    // Mark the just-inserted task as cancelled to prevent it from executing
    await env.DATABASE.prepare(
      `UPDATE tasks SET status = 'cancelled', error_message = 'Rate limit exceeded (concurrent dispatch race)', updated_at = ? WHERE id = ?`,
    ).bind(now, taskId).run();
    await env.DATABASE.prepare(
      `INSERT INTO task_status_events (id, task_id, from_status, to_status, actor_type, actor_id, reason, created_at)
       VALUES (?, ?, 'queued', 'cancelled', 'system', NULL, 'Atomic rate limit check failed — concurrent dispatch race detected', ?)`,
    ).bind(ulid(), taskId, now).run();

    const limitType = atomicChildCount > limits.dispatchMaxPerTask ? 'per-task' : 'per-project';
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `Dispatch ${limitType} limit exceeded (concurrent race detected). Please retry.`,
    );
  }

  // ── Create chat session and persist initial message ─────────────────────
  let sessionId: string;
  try {
    sessionId = await projectDataService.createSession(
      env,
      tokenData.projectId,
      null, // workspaceId — linked later by TaskRunner DO
      taskTitle,
      taskId,
    );

    // Persist the description as the initial user message
    await projectDataService.persistMessage(
      env,
      tokenData.projectId,
      sessionId,
      'user',
      fullDescription,
      null,
    );
  } catch (err) {
    // Session creation failed — mark task as failed
    const failedAt = new Date().toISOString();
    const errorMsg = err instanceof Error ? err.message : String(err);
    await db.update(schema.tasks)
      .set({ status: 'failed', errorMessage: `Session creation failed: ${errorMsg}`, updatedAt: failedAt })
      .where(eq(schema.tasks.id, taskId));
    await db.insert(schema.taskStatusEvents).values({
      id: ulid(),
      taskId,
      fromStatus: 'queued',
      toStatus: 'failed',
      actorType: 'system',
      actorId: null,
      reason: `Session creation failed: ${errorMsg}`,
      createdAt: failedAt,
    });
    log.error('mcp.dispatch_task.session_failed', { taskId, projectId: tokenData.projectId, error: errorMsg });
    return jsonRpcError(requestId, INTERNAL_ERROR, `Failed to create chat session: ${errorMsg}`);
  }

  // ── Start TaskRunner DO ─────────────────────────────────────────────────
  // Look up user's githubId for noreply email fallback
  const [userRow] = await db
    .select({ name: schema.users.name, email: schema.users.email, githubId: schema.users.githubId })
    .from(schema.users)
    .where(eq(schema.users.id, tokenData.userId))
    .limit(1);

  try {
    await startTaskRunnerDO(env, {
      taskId,
      projectId: tokenData.projectId,
      userId: tokenData.userId,
      vmSize: resolvedVmSize,
      vmLocation: resolvedVmLocation,
      branch: checkoutBranch,
      userName: userRow?.name ?? null,
      userEmail: userRow?.email ?? null,
      githubId: userRow?.githubId ?? null,
      taskTitle,
      taskDescription: fullDescription,
      repository: project.repository,
      installationId: project.installationId,
      outputBranch: branchName,
      projectDefaultVmSize: project.defaultVmSize as VMSize | null,
      chatSessionId: sessionId,
      agentType: project.defaultAgentType ?? null,
      workspaceProfile: resolvedWorkspaceProfile,
      cloudProvider: resolvedProvider,
    });
  } catch (err) {
    // TaskRunner DO startup failed — mark task as failed
    const failedAt = new Date().toISOString();
    const errorMsg = err instanceof Error ? err.message : String(err);
    await db.update(schema.tasks)
      .set({ status: 'failed', errorMessage: `Task runner startup failed: ${errorMsg}`, updatedAt: failedAt })
      .where(eq(schema.tasks.id, taskId));
    await db.insert(schema.taskStatusEvents).values({
      id: ulid(),
      taskId,
      fromStatus: 'queued',
      toStatus: 'failed',
      actorType: 'system',
      actorId: null,
      reason: `Task runner startup failed: ${errorMsg}`,
      createdAt: failedAt,
    });
    log.error('mcp.dispatch_task.do_startup_failed', { taskId, projectId: tokenData.projectId, error: errorMsg });
    await projectDataService.stopSession(env, tokenData.projectId, sessionId).catch((e) => {
      log.error('mcp.dispatch_task.orphaned_session_stop_failed', { projectId: tokenData.projectId, sessionId, error: String(e) });
    });
    return jsonRpcError(requestId, INTERNAL_ERROR, `Failed to start task runner: ${errorMsg}`);
  }

  // ── Record activity event (best-effort) ─────────────────────────────────
  try {
    const doId = env.PROJECT_DATA.idFromName(tokenData.projectId);
    const doStub = env.PROJECT_DATA.get(doId);
    await doStub.fetch(new Request('https://do/activity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'task.dispatched',
        actorType: 'agent',
        actorId: tokenData.workspaceId,
        metadata: {
          taskId,
          parentTaskId: tokenData.taskId,
          dispatchDepth: newDepth,
          title: taskTitle,
          branchName,
        },
      }),
    }));
  } catch (err) {
    log.warn('mcp.dispatch_task.activity_event_failed', {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  log.info('mcp.dispatch_task.created', {
    taskId,
    sessionId,
    branchName,
    parentTaskId: tokenData.taskId,
    projectId: tokenData.projectId,
    dispatchDepth: newDepth,
    vmSize: resolvedVmSize,
  });

  const appDomain = `app.${env.BASE_DOMAIN}`;
  const taskUrl = `https://${appDomain}/projects/${tokenData.projectId}?task=${taskId}`;

  return jsonRpcSuccess(requestId, {
    content: [{
      type: 'text',
      text: JSON.stringify({
        taskId,
        sessionId,
        branchName,
        title: taskTitle,
        status: 'queued',
        dispatchDepth: newDepth,
        url: taskUrl,
        message: `Task dispatched successfully. The agent will start working independently. Track progress at: ${taskUrl}`,
      }, null, 2),
    }],
  });
}

// ─── Project awareness handlers (read-only) ─────────────────────────────────

async function handleListTasks(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const limits = getMcpLimits(env);
  const status = typeof params.status === 'string' ? params.status : undefined;
  const includeOwn = params.include_own === true;
  const requestedLimit = typeof params.limit === 'number' ? params.limit : limits.taskListLimit;
  const limit = Math.min(Math.max(1, Math.round(requestedLimit)), limits.taskListMax);

  const db = drizzle(env.DATABASE, { schema });

  const conditions: SQL[] = [eq(schema.tasks.projectId, tokenData.projectId)];

  if (!includeOwn) {
    // We can't easily do "not equal" with drizzle's eq helper, so we filter post-query
  }

  if (status) {
    conditions.push(eq(schema.tasks.status, status));
  }

  // Fetch one extra so we can filter out own task without reducing results
  const fetchLimit = includeOwn ? limit : limit + 1;

  const rows = await db
    .select({
      id: schema.tasks.id,
      title: schema.tasks.title,
      description: schema.tasks.description,
      status: schema.tasks.status,
      priority: schema.tasks.priority,
      outputBranch: schema.tasks.outputBranch,
      outputPrUrl: schema.tasks.outputPrUrl,
      outputSummary: schema.tasks.outputSummary,
      createdAt: schema.tasks.createdAt,
      updatedAt: schema.tasks.updatedAt,
    })
    .from(schema.tasks)
    .where(and(...conditions))
    .orderBy(desc(schema.tasks.updatedAt))
    .limit(fetchLimit);

  let tasks = includeOwn
    ? rows
    : rows.filter((t) => t.id !== tokenData.taskId);

  // Trim to requested limit after filtering
  tasks = tasks.slice(0, limit);

  const snippetLen = limits.taskDescriptionSnippetLength;
  const result = tasks.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    descriptionSnippet: t.description ? t.description.slice(0, snippetLen) + (t.description.length > snippetLen ? '...' : '') : null,
    outputBranch: t.outputBranch,
    outputPrUrl: t.outputPrUrl,
    outputSummary: t.outputSummary ? t.outputSummary.slice(0, snippetLen) + (t.outputSummary.length > snippetLen ? '...' : '') : null,
    updatedAt: t.updatedAt,
  }));

  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify({ tasks: result, count: result.length }, null, 2) }],
  });
}

async function handleGetTaskDetails(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const taskId = typeof params.taskId === 'string' ? params.taskId.trim() : '';
  if (!taskId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'taskId is required');
  }

  const db = drizzle(env.DATABASE, { schema });

  const rows = await db
    .select({
      id: schema.tasks.id,
      title: schema.tasks.title,
      description: schema.tasks.description,
      status: schema.tasks.status,
      priority: schema.tasks.priority,
      outputBranch: schema.tasks.outputBranch,
      outputPrUrl: schema.tasks.outputPrUrl,
      outputSummary: schema.tasks.outputSummary,
      errorMessage: schema.tasks.errorMessage,
      createdAt: schema.tasks.createdAt,
      updatedAt: schema.tasks.updatedAt,
      startedAt: schema.tasks.startedAt,
      completedAt: schema.tasks.completedAt,
    })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.id, taskId),
        eq(schema.tasks.projectId, tokenData.projectId),
      ),
    )
    .limit(1);

  const task = rows[0];
  if (!task) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Task not found in this project');
  }

  const result = {
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    outputBranch: task.outputBranch,
    outputPrUrl: task.outputPrUrl,
    outputSummary: task.outputSummary,
    errorMessage: task.errorMessage,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
  };

  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  });
}

async function handleSearchTasks(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const query = typeof params.query === 'string' ? params.query.trim() : '';
  if (!query) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'query is required and must be a non-empty string');
  }
  if (query.length < 2) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'query must be at least 2 characters');
  }

  const limits = getMcpLimits(env);
  const status = typeof params.status === 'string' ? params.status : undefined;
  const requestedLimit = typeof params.limit === 'number' ? params.limit : 10;
  const limit = Math.min(Math.max(1, Math.round(requestedLimit)), limits.taskSearchMax);

  const db = drizzle(env.DATABASE, { schema });
  const searchPattern = `%${query}%`;

  const conditions: SQL[] = [
    eq(schema.tasks.projectId, tokenData.projectId),
    or(
      like(schema.tasks.title, searchPattern),
      like(schema.tasks.description, searchPattern),
    )!,
  ];

  if (status) {
    conditions.push(eq(schema.tasks.status, status));
  }

  const rows = await db
    .select({
      id: schema.tasks.id,
      title: schema.tasks.title,
      description: schema.tasks.description,
      status: schema.tasks.status,
      priority: schema.tasks.priority,
      outputBranch: schema.tasks.outputBranch,
      outputPrUrl: schema.tasks.outputPrUrl,
      outputSummary: schema.tasks.outputSummary,
      updatedAt: schema.tasks.updatedAt,
    })
    .from(schema.tasks)
    .where(and(...conditions))
    .orderBy(desc(schema.tasks.updatedAt))
    .limit(limit);

  const snippetLen = limits.taskDescriptionSnippetLength;
  const result = rows.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    descriptionSnippet: t.description ? t.description.slice(0, snippetLen) + (t.description.length > snippetLen ? '...' : '') : null,
    outputBranch: t.outputBranch,
    outputPrUrl: t.outputPrUrl,
    outputSummary: t.outputSummary ? t.outputSummary.slice(0, snippetLen) + (t.outputSummary.length > snippetLen ? '...' : '') : null,
    updatedAt: t.updatedAt,
  }));

  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify({ tasks: result, count: result.length, query }, null, 2) }],
  });
}

async function handleListSessions(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const limits = getMcpLimits(env);
  const status = typeof params.status === 'string' ? params.status : null;
  const requestedLimit = typeof params.limit === 'number' ? params.limit : limits.sessionListLimit;
  const limit = Math.min(Math.max(1, Math.round(requestedLimit)), limits.sessionListMax);

  const { sessions, total } = await projectDataService.listSessions(
    env,
    tokenData.projectId,
    status,
    limit,
  );

  const result = sessions.map((s: Record<string, unknown>) => ({
    id: s.id,
    topic: s.topic,
    status: s.status,
    messageCount: s.messageCount,
    taskId: s.taskId,
    workspaceId: s.workspaceId,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
  }));

  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify({ sessions: result, total }, null, 2) }],
  });
}

async function handleGetSessionMessages(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
  if (!sessionId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'sessionId is required');
  }

  const limits = getMcpLimits(env);
  const requestedLimit = typeof params.limit === 'number' ? params.limit : limits.messageListLimit;
  const limit = Math.min(Math.max(1, Math.round(requestedLimit)), limits.messageListMax);
  const rolesResult = validateRoles(params.roles);
  if (!rolesResult.valid) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `Invalid roles: ${rolesResult.invalid.join(', ')}. Valid roles: ${VALID_MESSAGE_ROLES.join(', ')}`,
    );
  }
  const roles = rolesResult.roles;

  // Verify session belongs to this project
  const session = await projectDataService.getSession(env, tokenData.projectId, sessionId);
  if (!session) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Session not found in this project');
  }

  const { messages, hasMore } = await projectDataService.getMessages(
    env,
    tokenData.projectId,
    sessionId,
    limit,
    null,
    roles,
  );

  const result = messages.map((m: Record<string, unknown>) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    createdAt: m.createdAt,
  }));

  return jsonRpcSuccess(requestId, {
    content: [{
      type: 'text',
      text: JSON.stringify({
        sessionId,
        topic: session.topic,
        taskId: session.taskId,
        messages: result,
        messageCount: result.length,
        hasMore,
      }, null, 2),
    }],
  });
}

async function handleSearchMessages(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const query = typeof params.query === 'string' ? params.query.trim() : '';
  if (!query) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'query is required and must be a non-empty string');
  }
  if (query.length < 2) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'query must be at least 2 characters');
  }

  const limits = getMcpLimits(env);
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : null;
  const rolesResult = validateRoles(params.roles);
  if (!rolesResult.valid) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `Invalid roles: ${rolesResult.invalid.join(', ')}. Valid roles: ${VALID_MESSAGE_ROLES.join(', ')}`,
    );
  }
  const roles = rolesResult.roles;
  const requestedLimit = typeof params.limit === 'number' ? params.limit : 10;
  const limit = Math.min(Math.max(1, Math.round(requestedLimit)), limits.messageSearchMax);

  const results = await projectDataService.searchMessages(
    env,
    tokenData.projectId,
    query,
    sessionId,
    roles,
    limit,
  );

  return jsonRpcSuccess(requestId, {
    content: [{
      type: 'text',
      text: JSON.stringify({
        results: results.map((r) => ({
          messageId: r.id,
          sessionId: r.sessionId,
          sessionTopic: r.sessionTopic,
          sessionTaskId: r.sessionTaskId,
          role: r.role,
          snippet: r.snippet,
          createdAt: r.createdAt,
        })),
        count: results.length,
        query,
      }, null, 2),
    }],
  });
}

// ─── MCP endpoint ────────────────────────────────────────────────────────────

mcpRoutes.post('/', async (c) => {
  // Authenticate — returns parsed token data (raw token no longer needed
  // since token revocation was removed from complete_task)
  const [tokenData] = await authenticateMcpRequest(
    c.req.header('Authorization'),
    c.env.KV,
  );
  if (!tokenData) {
    return c.json(
      jsonRpcError(null, -32000, 'Unauthorized: invalid or expired MCP token'),
      401,
    );
  }

  // ── HTTP-level rate limiting (per task/agent) ───────────────────────────
  const rlResult = await checkMcpRateLimit(c.env.KV, tokenData.taskId, c.env);
  c.header('X-RateLimit-Limit', getMcpRateLimit(c.env).toString());
  c.header('X-RateLimit-Remaining', rlResult.remaining.toString());
  c.header('X-RateLimit-Reset', rlResult.resetAt.toString());
  if (!rlResult.allowed) {
    c.header('Retry-After', rlResult.retryAfter.toString());
    return c.json(
      jsonRpcError(null, -32000, 'Rate limit exceeded. Please retry after the indicated period.'),
      429,
    );
  }

  // Parse JSON-RPC request
  let rpc: JsonRpcRequest;
  try {
    rpc = await c.req.json<JsonRpcRequest>();
  } catch {
    return c.json(
      jsonRpcError(null, -32700, 'Parse error: invalid JSON'),
      400,
    );
  }

  if (rpc.jsonrpc !== '2.0') {
    return c.json(
      jsonRpcError(rpc.id ?? null, -32600, 'Invalid Request: missing jsonrpc 2.0'),
      400,
    );
  }

  const requestId = rpc.id ?? null;

  // Route by method
  switch (rpc.method) {
    // MCP protocol: list available tools
    case 'tools/list': {
      return c.json(jsonRpcSuccess(requestId, { tools: MCP_TOOLS }));
    }

    // MCP protocol: call a tool
    case 'tools/call': {
      const toolName = (rpc.params as { name?: string })?.name;
      const toolArgs = ((rpc.params as { arguments?: Record<string, unknown> })?.arguments) ?? {};

      switch (toolName) {
        case 'get_instructions':
          return c.json(await handleGetInstructions(requestId, tokenData, c.env));
        case 'update_task_status':
          return c.json(await handleUpdateTaskStatus(requestId, toolArgs, tokenData, c.env));
        case 'complete_task':
          return c.json(await handleCompleteTask(requestId, toolArgs, tokenData, c.env));
        case 'dispatch_task':
          return c.json(await handleDispatchTask(requestId, toolArgs, tokenData, c.env));
        case 'list_tasks':
          return c.json(await handleListTasks(requestId, toolArgs, tokenData, c.env));
        case 'get_task_details':
          return c.json(await handleGetTaskDetails(requestId, toolArgs, tokenData, c.env));
        case 'search_tasks':
          return c.json(await handleSearchTasks(requestId, toolArgs, tokenData, c.env));
        case 'list_sessions':
          return c.json(await handleListSessions(requestId, toolArgs, tokenData, c.env));
        case 'get_session_messages':
          return c.json(await handleGetSessionMessages(requestId, toolArgs, tokenData, c.env));
        case 'search_messages':
          return c.json(await handleSearchMessages(requestId, toolArgs, tokenData, c.env));
        default:
          return c.json(jsonRpcError(requestId, METHOD_NOT_FOUND, `Unknown tool: ${toolName}`));
      }
    }

    // MCP protocol: initialize
    case 'initialize': {
      return c.json(jsonRpcSuccess(requestId, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      }));
    }

    // MCP protocol: ping
    case 'ping': {
      return c.json(jsonRpcSuccess(requestId, {}));
    }

    default:
      return c.json(jsonRpcError(requestId, METHOD_NOT_FOUND, `Method not found: ${rpc.method}`));
  }
});
