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
import { and, eq, like, or, desc } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { Env } from '../index';
import * as schema from '../db/schema';
import { validateMcpToken, type McpTokenData } from '../services/mcp-token';
import * as projectDataService from '../services/project-data';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';

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
  const roles = Array.isArray(params.roles)
    ? params.roles.filter((r): r is string => typeof r === 'string')
    : ['user', 'assistant'];

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
  const roles = Array.isArray(params.roles)
    ? params.roles.filter((r): r is string => typeof r === 'string')
    : ['user', 'assistant'];
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
