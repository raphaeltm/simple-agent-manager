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

async function authenticateMcpRequest(
  authHeader: string | undefined,
  kv: KVNamespace,
): Promise<McpTokenData | null> {
  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.slice(7);
  if (!token) {
    return null;
  }
  return validateMcpToken(kv, token);
}

// ─── Tool handlers ───────────────────────────────────────────────────────────

async function handleGetInstructions(
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
    return jsonRpcError(null, INTERNAL_ERROR, 'Task not found');
  }

  // Fetch project
  const projectRows = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, tokenData.projectId))
    .limit(1);

  const project = projectRows[0];
  if (!project) {
    return jsonRpcError(null, INTERNAL_ERROR, 'Project not found');
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

  return jsonRpcSuccess(null, {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  });
}

async function handleUpdateTaskStatus(
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const message = params.message;
  if (typeof message !== 'string' || !message.trim()) {
    return jsonRpcError(null, INVALID_PARAMS, 'message is required and must be a non-empty string');
  }

  const db = drizzle(env.DATABASE, { schema });

  // Verify task exists and belongs to this project
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
    return jsonRpcError(null, INTERNAL_ERROR, 'Task not found');
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
          message: message.trim().slice(0, 500),
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
    message: message.trim().slice(0, 200),
  });

  return jsonRpcSuccess(null, {
    content: [{ type: 'text', text: 'Progress update recorded.' }],
  });
}

async function handleCompleteTask(
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const summary = typeof params.summary === 'string' ? params.summary.trim() : null;

  const db = drizzle(env.DATABASE, { schema });

  // Fetch the task
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
    return jsonRpcError(null, INTERNAL_ERROR, 'Task not found');
  }

  // Only allow completion from active states
  const completableStatuses = ['in_progress', 'delegated', 'awaiting_followup'];
  if (!completableStatuses.includes(task.status)) {
    return jsonRpcError(
      null,
      INVALID_PARAMS,
      `Task cannot be completed from status '${task.status}'`,
    );
  }

  const now = new Date().toISOString();

  // Update task status to completed
  await db
    .update(schema.tasks)
    .set({
      status: 'completed',
      completedAt: now,
      outputSummary: summary ? summary.slice(0, 2000) : task.outputSummary,
      updatedAt: now,
    })
    .where(eq(schema.tasks.id, tokenData.taskId));

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
          summary: summary?.slice(0, 500) ?? null,
        },
      }),
    }));
  } catch (err) {
    log.warn('mcp.complete_task.activity_event_failed', {
      taskId: tokenData.taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  log.info('mcp.complete_task', {
    taskId: tokenData.taskId,
    projectId: tokenData.projectId,
    summary: summary?.slice(0, 200) ?? null,
  });

  return jsonRpcSuccess(null, {
    content: [{ type: 'text', text: 'Task marked as completed.' }],
  });
}

// ─── MCP endpoint ────────────────────────────────────────────────────────────

mcpRoutes.post('/', async (c) => {
  // Authenticate
  const tokenData = await authenticateMcpRequest(
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
        case 'get_instructions': {
          const result = await handleGetInstructions(tokenData, c.env);
          result.id = requestId;
          return c.json(result);
        }
        case 'update_task_status': {
          const result = await handleUpdateTaskStatus(toolArgs, tokenData, c.env);
          result.id = requestId;
          return c.json(result);
        }
        case 'complete_task': {
          const result = await handleCompleteTask(toolArgs, tokenData, c.env);
          result.id = requestId;
          return c.json(result);
        }
        default:
          return c.json(jsonRpcError(requestId, METHOD_NOT_FOUND, `Unknown tool: ${toolName}`));
      }
    }

    // MCP protocol: initialize
    case 'initialize': {
      return c.json(jsonRpcSuccess(requestId, {
        protocolVersion: '2025-03-26',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'sam-mcp', version: '1.0.0' },
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
