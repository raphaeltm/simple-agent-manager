/**
 * MCP Server Route
 *
 * Implements a lightweight MCP (Model Context Protocol) server using
 * JSON-RPC 2.0 over HTTP (Streamable HTTP transport). Exposes three tools
 * to agents running in SAM workspaces:
 *
 * - get_instructions: Bootstrap tool — returns task context, project info, and behavioral guidance
 * - update_task_status: Report incremental progress on task checklist items
 * - complete_task: Mark the task as completed with an optional summary
 *
 * Auth: task-scoped opaque token stored in KV, passed as Bearer token.
 */

import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { Env } from '../index';
import * as schema from '../db/schema';
import { validateMcpToken, type McpTokenData } from '../services/mcp-token';
import { log } from '../lib/logger';

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

/** Max length for progress/summary messages stored in activity events */
const ACTIVITY_MESSAGE_MAX_LENGTH = 500;
/** Max length for log messages */
const LOG_MESSAGE_MAX_LENGTH = 200;
/** Max length for task output summary stored in D1 */
const OUTPUT_SUMMARY_MAX_LENGTH = 2000;

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
          message: message.trim().slice(0, ACTIVITY_MESSAGE_MAX_LENGTH),
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
    message: message.trim().slice(0, LOG_MESSAGE_MAX_LENGTH),
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
    summary ? summary.slice(0, OUTPUT_SUMMARY_MAX_LENGTH) : null,
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
          summary: summary?.slice(0, ACTIVITY_MESSAGE_MAX_LENGTH) ?? null,
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
    summary: summary?.slice(0, LOG_MESSAGE_MAX_LENGTH) ?? null,
  });

  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: 'Task marked as completed.' }],
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
