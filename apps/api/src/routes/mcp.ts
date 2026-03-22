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
 * Agent-initiated notifications:
 * - request_human_input: Request human input when blocked/need a decision (sends high-urgency notification)
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
 * Idea management:
 * - create_idea: Create a new idea (draft task) without triggering execution
 * - update_idea: Update an idea's title, content, or priority (append or replace)
 * - get_idea: Get full details of a specific idea
 * - list_ideas: List all ideas (draft tasks) in the project
 * - search_ideas: Search ideas by keyword in title and content
 *
 * Auth: task-scoped opaque token stored in KV, passed as Bearer token.
 */

import { Hono } from 'hono';
import { and, eq, like, or, desc, sql, inArray } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { Env } from '../index';
import type { VMSize, VMLocation, WorkspaceProfile, CredentialProvider } from '@simple-agent-manager/shared';
import { DEFAULT_VM_SIZE, DEFAULT_VM_LOCATION, DEFAULT_WORKSPACE_PROFILE, MAX_HUMAN_INPUT_CONTEXT_LENGTH, MAX_HUMAN_INPUT_OPTIONS_COUNT, MAX_HUMAN_INPUT_OPTION_LENGTH, MAX_NOTIFICATION_BODY_LENGTH, HUMAN_INPUT_CATEGORIES } from '@simple-agent-manager/shared';
import type { HumanInputCategory } from '@simple-agent-manager/shared';
import * as schema from '../db/schema';
import { validateMcpToken, type McpTokenData } from '../services/mcp-token';
import * as projectDataService from '../services/project-data';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import { ulid } from '../lib/ulid';
import { generateBranchName } from '../services/branch-name';
import { startTaskRunnerDO } from '../services/task-runner-do';
import { generateTaskTitle, getTaskTitleConfig } from '../services/task-title';
import * as notificationService from '../services/notification';

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
    messageListLimit: parsePositiveInt(env.MCP_MESSAGE_LIST_LIMIT as string, DEFAULT_MCP_MESSAGE_LIST_LIMIT),
    messageListMax: parsePositiveInt(env.MCP_MESSAGE_LIST_MAX as string, DEFAULT_MCP_MESSAGE_LIST_MAX),
    messageSearchMax: parsePositiveInt(env.MCP_MESSAGE_SEARCH_MAX as string, DEFAULT_MCP_MESSAGE_SEARCH_MAX),
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
    ideaContextMaxLength: parsePositiveInt(env.MCP_IDEA_CONTEXT_MAX_LENGTH as string, DEFAULT_MCP_IDEA_CONTEXT_MAX_LENGTH),
    ideaContentMaxLength: parsePositiveInt(env.MCP_IDEA_CONTENT_MAX_LENGTH as string, DEFAULT_MCP_IDEA_CONTENT_MAX_LENGTH),
    ideaListLimit: parsePositiveInt(env.MCP_IDEA_LIST_LIMIT as string, DEFAULT_MCP_IDEA_LIST_LIMIT),
    ideaListMax: parsePositiveInt(env.MCP_IDEA_LIST_MAX as string, DEFAULT_MCP_IDEA_LIST_MAX),
    ideaSearchMax: parsePositiveInt(env.MCP_IDEA_SEARCH_MAX as string, DEFAULT_MCP_IDEA_SEARCH_MAX),
    ideaTitleMaxLength: parsePositiveInt(env.MCP_IDEA_TITLE_MAX_LENGTH as string, DEFAULT_MCP_IDEA_TITLE_MAX_LENGTH),
  };
}

/** Strip null bytes, Unicode bidi overrides, and C0/C1 control chars (except \n, \t) from user/agent input. */
function sanitizeUserInput(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '');
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
        branch: {
          type: 'string',
          description: 'Git branch for the new workspace to check out. Defaults to the project\'s default branch (usually main). Only set this if you have already pushed the branch to the remote.',
        },
      },
      required: ['description'],
      additionalProperties: false,
    },
  },
  // ─── Agent-initiated notifications ──────────────────────────────────────
  {
    name: 'request_human_input',
    description:
      'Request human input when you are blocked, need a decision, need clarification, or need approval. ' +
      'This sends a high-urgency notification to the user and returns immediately — you can continue working or end your turn.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        context: {
          type: 'string',
          description: 'Explain what you need from the human — be specific about the decision, question, or blocker.',
        },
        category: {
          type: 'string',
          description: 'Category of input needed.',
          enum: ['decision', 'clarification', 'approval', 'error_help'],
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of choices for the human to pick from (e.g., ["Option A", "Option B"]).',
        },
      },
      required: ['context'],
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
      'Read messages from a specific chat session. Returns logical messages in chronological order (consecutive streaming tokens with the same role are concatenated for assistant, tool, and thinking roles; user/system/plan messages pass through as-is). The `limit` parameter controls how many raw tokens are fetched before grouping, so the returned message count may be fewer than `limit`. `hasMore` indicates whether additional raw tokens exist beyond the fetched window. By default only returns user and assistant messages (skips tool calls and system messages).',
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
      'Search messages across all chat sessions in your project by keyword using full-text search. Returns matching message snippets with session context. Useful for finding past discussions about specific topics, decisions, or code. Completed sessions use FTS5 indexing (matches messages containing all search words); active sessions fall back to keyword matching.',
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
  // ─── Session–Idea linking tools ──────────────────────────────────────
  {
    name: 'link_idea',
    description:
      'Associate the current chat session with an idea (task). Use this when the conversation touches on an existing idea. Linking is idempotent — linking the same idea twice is a no-op.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: {
          type: 'string',
          description: 'The idea (task) ID to link to the current session',
        },
        context: {
          type: 'string',
          description: 'Optional reasoning for why this session relates to the idea',
        },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'unlink_idea',
    description:
      'Remove the association between the current chat session and an idea (task). No-op if the link does not exist.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: {
          type: 'string',
          description: 'The idea (task) ID to unlink from the current session',
        },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_linked_ideas',
    description:
      'List all ideas (tasks) linked to the current chat session. Returns each idea with its title, status, link context, and when it was linked.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'find_related_ideas',
    description:
      'Search existing ideas in your project by keyword. Defaults to searching draft (idea) tasks only. Use this to find ideas that might relate to the current conversation before creating a new one.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search keyword to find in idea titles and descriptions',
        },
        status: {
          type: 'string',
          description: 'Filter by idea status. Omit for all statuses.',
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
  // ─── Idea management tools ───────────────────────────────────────────
  {
    name: 'create_idea',
    description:
      'Create a new idea in the current project. Ideas are lightweight notes for future consideration — they are NOT dispatched for execution. ' +
      'Use this to capture ideas, feature requests, or anything worth tracking. Returns the idea ID so you can link it to the current session via link_idea.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: {
          type: 'string',
          description: 'Short title for the idea (max 200 chars)',
        },
        content: {
          type: 'string',
          description: 'Detailed content — supports checklists, notes, research findings, etc. (max 64KB)',
        },
        priority: {
          type: 'number',
          description: 'Priority (0 = default). Higher = more important.',
        },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_idea',
    description:
      'Update an existing idea. By default, new content is appended to the existing content (great for adding notes from multiple conversations). Set append=false to replace content entirely.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ideaId: {
          type: 'string',
          description: 'The idea ID to update',
        },
        title: {
          type: 'string',
          description: 'New title (optional — only updates if provided)',
        },
        content: {
          type: 'string',
          description: 'Content to append (or replace if append=false)',
        },
        append: {
          type: 'boolean',
          description: 'If true (default), append content to existing description. If false, replace it.',
        },
        priority: {
          type: 'number',
          description: 'New priority (optional — only updates if provided)',
        },
      },
      required: ['ideaId'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_idea',
    description:
      'Get full details of a specific idea, including its complete content. Use this to read the full text of an idea before updating it.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ideaId: {
          type: 'string',
          description: 'The idea ID to retrieve',
        },
      },
      required: ['ideaId'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_ideas',
    description:
      'List all ideas (draft tasks) in your project, ordered by most recently updated. Use this to see what ideas exist before creating duplicates.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: {
          type: 'number',
          description: 'Max results to return (default: 20, max: 100)',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'search_ideas',
    description:
      'Search ideas in your project by keyword. Searches both title and content fields. Only returns ideas (draft tasks), not executed tasks.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search keyword to find in idea titles and content',
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
 *
 * NOTE: KV does not support atomic read-modify-write. Under high concurrency from
 * the same taskId, two requests may read the same count and both increment to the
 * same value, allowing limit+1 requests through. This is a known limitation shared
 * with all KV-based rate limiters in the codebase (see middleware/rate-limit.ts).
 * For the MCP use case this is acceptable — each agent has a unique taskId, so
 * concurrency is bounded by agent parallelism (typically 1). A Durable Object-based
 * rate limiter would provide true atomicity if stricter enforcement is needed.
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
    instructions: task.taskMode === 'conversation'
      ? [
          'You are in a conversation with a human. Respond to their messages directly.',
          'Use `dispatch_task` to spawn follow-up work to other agents when needed.',
          'Use `update_task_status` to report significant findings or progress.',
          'Do NOT call `complete_task` — the human will end the conversation when they are ready.',
          'If you encounter blockers, report them via `update_task_status` with a clear description.',
        ]
      : [
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
    .select({
      id: schema.tasks.id,
      status: schema.tasks.status,
      userId: schema.tasks.userId,
      title: schema.tasks.title,
    })
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

  // Emit progress notification (best-effort) — use tokenData.userId as authoritative target
  if (env.NOTIFICATION && tokenData.userId) {
    try {
      const [projectName, sessionId] = await Promise.all([
        notificationService.getProjectName(env, tokenData.projectId),
        notificationService.getChatSessionId(env, tokenData.workspaceId),
      ]);
      await notificationService.notifyProgress(env as any, tokenData.userId, {
        projectId: tokenData.projectId,
        projectName,
        taskId: tokenData.taskId,
        taskTitle: task.title,
        message: message.trim().slice(0, MAX_NOTIFICATION_BODY_LENGTH),
        sessionId,
      });
    } catch (err) {
      log.warn('mcp.update_task_status.notification_failed', {
        taskId: tokenData.taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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

  // Check task mode — in conversation mode, complete_task silently remaps to awaiting_followup
  // instead of completing the task. This prevents agents that ignore conversation-mode instructions
  // from prematurely ending the conversation.
  const taskRow = await env.DATABASE.prepare(
    `SELECT task_mode, user_id, title, output_pr_url, output_branch FROM tasks WHERE id = ? AND project_id = ?`,
  ).bind(tokenData.taskId, tokenData.projectId).first<{
    task_mode: string;
    user_id: string;
    title: string;
    output_pr_url: string | null;
    output_branch: string | null;
  }>();

  const isConversation = taskRow?.task_mode === 'conversation';

  if (isConversation) {
    // In conversation mode, remap complete_task to awaiting_followup — keep the task active.
    const result = await env.DATABASE.prepare(
      `UPDATE tasks SET execution_step = 'awaiting_followup', output_summary = COALESCE(?, output_summary), updated_at = ?
       WHERE id = ? AND project_id = ? AND status IN ('in_progress', 'delegated', 'awaiting_followup')`,
    ).bind(
      summary ? summary.slice(0, getMcpLimits(env).outputSummaryMaxLength) : null,
      now,
      tokenData.taskId,
      tokenData.projectId,
    ).run();

    if (!result.meta.changes || result.meta.changes === 0) {
      return jsonRpcError(
        requestId,
        INVALID_PARAMS,
        'Task cannot be updated — it may not exist or is not in an active status',
      );
    }

    log.info('mcp.complete_task.conversation_remapped', {
      taskId: tokenData.taskId,
      projectId: tokenData.projectId,
      summary: summary?.slice(0, getMcpLimits(env).logMessageMaxLength) ?? null,
    });

    // Fire activity event so the remap is visible in activity feeds
    try {
      const doId = env.PROJECT_DATA.idFromName(tokenData.projectId);
      const doStub = env.PROJECT_DATA.get(doId);
      await doStub.fetch(new Request('https://do/activity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'task.awaiting_followup',
          actorType: 'agent',
          actorId: tokenData.workspaceId,
          metadata: {
            taskId: tokenData.taskId,
            summary: summary?.slice(0, getMcpLimits(env).activityMessageMaxLength) ?? null,
          },
        }),
      }));
    } catch (err) {
      log.warn('mcp.complete_task.conversation_activity_event_failed', {
        taskId: tokenData.taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Emit session_ended notification for conversation-mode remap (agent finished turn)
    // Use tokenData.userId as authoritative target
    if (env.NOTIFICATION && tokenData.userId) {
      try {
        const [projectName, sessionId] = await Promise.all([
          notificationService.getProjectName(env, tokenData.projectId),
          notificationService.getChatSessionId(env, tokenData.workspaceId),
        ]);
        await notificationService.notifySessionEnded(env as any, tokenData.userId, {
          projectId: tokenData.projectId,
          projectName,
          sessionId,
          taskId: tokenData.taskId,
          taskTitle: taskRow.title,
        });
      } catch (err) {
        log.warn('mcp.complete_task.conversation_notification_failed', {
          taskId: tokenData.taskId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return jsonRpcSuccess(requestId, {
      content: [{ type: 'text', text: 'Acknowledged. Conversation remains open for follow-up.' }],
    });
  }

  // Task mode: standard completion
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
  //   1. KV TTL auto-expiration (default 4 hours, configurable via MCP_TOKEN_TTL_SECONDS)
  //   2. Task-runner DO cleanup on failure (task-runner.ts)

  // Emit task completion notification (best-effort)
  if (env.NOTIFICATION && taskRow?.user_id) {
    try {
      const [projectName, sessionId] = await Promise.all([
        notificationService.getProjectName(env, tokenData.projectId),
        notificationService.getChatSessionId(env, tokenData.workspaceId),
      ]);
      await notificationService.notifyTaskComplete(env as any, taskRow.user_id, {
        projectId: tokenData.projectId,
        projectName,
        taskId: tokenData.taskId,
        taskTitle: taskRow.title,
        outputPrUrl: taskRow.output_pr_url,
        outputBranch: taskRow.output_branch,
        sessionId,
      });
    } catch (err) {
      log.warn('mcp.complete_task.notification_failed', {
        taskId: tokenData.taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info('mcp.complete_task', {
    taskId: tokenData.taskId,
    projectId: tokenData.projectId,
    summary: summary?.slice(0, getMcpLimits(env).logMessageMaxLength) ?? null,
  });

  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: 'Task marked as completed.' }],
  });
}

// ─── Agent-initiated notification handlers ──────────────────────────────────

async function handleRequestHumanInput(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const context = params.context;
  if (typeof context !== 'string' || !context.trim()) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'context is required and must be a non-empty string');
  }

  if (context.length > MAX_HUMAN_INPUT_CONTEXT_LENGTH) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `context exceeds maximum length of ${MAX_HUMAN_INPUT_CONTEXT_LENGTH} characters`,
    );
  }

  // Sanitize context: strip null bytes, Unicode bidi overrides, and C0/C1 control chars (except \n, \t)
  const sanitizedContext = sanitizeUserInput(context.trim());

  // Validate category if provided
  let category: HumanInputCategory | null = null;
  if (params.category !== undefined) {
    if (typeof params.category !== 'string' || !(HUMAN_INPUT_CATEGORIES as readonly string[]).includes(params.category)) {
      return jsonRpcError(requestId, INVALID_PARAMS, `category must be one of: ${HUMAN_INPUT_CATEGORIES.join(', ')}`);
    }
    category = params.category as HumanInputCategory;
  }

  // Validate options if provided
  let options: string[] | null = null;
  if (params.options !== undefined) {
    if (!Array.isArray(params.options)) {
      return jsonRpcError(requestId, INVALID_PARAMS, 'options must be an array of strings');
    }
    if (params.options.some((o: unknown) => typeof o !== 'string')) {
      return jsonRpcError(requestId, INVALID_PARAMS, 'options must contain only strings');
    }
    options = (params.options as string[])
      .slice(0, MAX_HUMAN_INPUT_OPTIONS_COUNT)
      .map((o) => sanitizeUserInput(o).slice(0, MAX_HUMAN_INPUT_OPTION_LENGTH));
    if (options.length === 0) options = null;
  }

  // Fetch task title (user_id verified against token below)
  const taskRow = await env.DATABASE.prepare(
    `SELECT user_id, title FROM tasks WHERE id = ? AND project_id = ?`,
  ).bind(tokenData.taskId, tokenData.projectId).first<{
    user_id: string;
    title: string;
  }>();

  if (!taskRow) {
    return jsonRpcError(requestId, INTERNAL_ERROR, 'Task not found');
  }

  // Verify task ownership matches token — use tokenData.userId as authoritative target
  if (taskRow.user_id !== tokenData.userId) {
    log.error('mcp.request_human_input.user_id_mismatch', {
      tokenUserId: tokenData.userId,
      taskUserId: taskRow.user_id,
      taskId: tokenData.taskId,
    });
    return jsonRpcError(requestId, INTERNAL_ERROR, 'Task ownership mismatch');
  }

  // Emit high-urgency notification (best-effort)
  if (env.NOTIFICATION) {
    try {
      const [projectName, sessionId] = await Promise.all([
        notificationService.getProjectName(env, tokenData.projectId),
        notificationService.getChatSessionId(env, tokenData.workspaceId),
      ]);
      await notificationService.notifyNeedsInput(env as any, tokenData.userId, {
        projectId: tokenData.projectId,
        projectName,
        taskId: tokenData.taskId,
        taskTitle: taskRow.title,
        context: sanitizedContext,
        category,
        options,
        sessionId,
      });
    } catch (err) {
      log.warn('mcp.request_human_input.notification_failed', {
        taskId: tokenData.taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info('mcp.request_human_input', {
    taskId: tokenData.taskId,
    projectId: tokenData.projectId,
    category,
    hasOptions: options !== null,
  });

  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: 'Human input request sent. The user has been notified. You may continue working or end your turn.' }],
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

  // Validate optional branch parameter
  let explicitBranch: string | undefined;
  if (params.branch !== undefined) {
    if (typeof params.branch !== 'string' || params.branch.trim().length === 0) {
      return jsonRpcError(requestId, INVALID_PARAMS, 'branch must be a non-empty string');
    }
    explicitBranch = params.branch.trim();
  }

  // ── Look up current task to get dispatch depth ──────────────────────────
  const [currentTask] = await db
    .select({
      id: schema.tasks.id,
      dispatchDepth: schema.tasks.dispatchDepth,
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

  // Explicit branch > project default branch.
  // We intentionally do NOT fall back to the parent task's outputBranch because
  // that branch may never have been pushed to the remote (it's generated at task
  // creation time, not on push). If an agent wants a child task on its branch,
  // it must pass `branch` explicitly — which implies it has already pushed.
  const checkoutBranch = explicitBranch || project.defaultBranch;

  // ── Atomic conditional INSERT (prevents TOCTOU race) ─────────────────
  // Uses INSERT ... SELECT ... WHERE to embed the rate-limit check as a
  // subquery within a single SQL statement. SQLite evaluates the WHERE
  // clause atomically — if a concurrent request inserts a task between
  // our advisory pre-check and this statement, the subquery count will
  // reflect it and the INSERT will produce zero rows. No phantom rows,
  // no compensating cancellation needed.
  const statusPlaceholders = ACTIVE_STATUSES.map(() => '?').join(', ');
  const conditionalInsertResult = await env.DATABASE.prepare(
    `INSERT INTO tasks (id, project_id, user_id, parent_task_id, title, description,
     status, execution_step, priority, dispatch_depth, output_branch, created_by,
     created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, 'queued', 'node_selection', ?, ?, ?, ?, ?, ?
     WHERE (
       SELECT count(*) FROM tasks
       WHERE parent_task_id = ? AND project_id = ?
       AND status IN (${statusPlaceholders})
     ) < ?
     AND (
       SELECT count(*) FROM tasks
       WHERE project_id = ? AND status IN (${statusPlaceholders})
       AND dispatch_depth > 0
     ) < ?`,
  ).bind(
    // INSERT values
    taskId, tokenData.projectId, tokenData.userId, tokenData.taskId,
    taskTitle, fullDescription, priority, newDepth, branchName,
    tokenData.userId, now, now,
    // Per-task child count subquery
    tokenData.taskId, tokenData.projectId,
    ...ACTIVE_STATUSES,
    limits.dispatchMaxPerTask,
    // Per-project active count subquery
    tokenData.projectId,
    ...ACTIVE_STATUSES,
    limits.dispatchMaxActivePerProject,
  ).run();

  if (!conditionalInsertResult.meta.changes || conditionalInsertResult.meta.changes === 0) {
    // The conditional INSERT produced zero rows — a concurrent dispatch
    // pushed the count over the limit between our advisory check and now.
    log.warn('mcp.dispatch_task.atomic_limit_breach', {
      taskId,
      projectId: tokenData.projectId,
      maxPerTask: limits.dispatchMaxPerTask,
      maxActive: limits.dispatchMaxActivePerProject,
    });
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'Dispatch rate limit exceeded (concurrent dispatch detected). Please retry.',
    );
  }

  // Record status event: null -> queued
  const statusEventId = ulid();
  await env.DATABASE.prepare(
    `INSERT INTO task_status_events (id, task_id, from_status, to_status,
     actor_type, actor_id, reason, created_at)
     VALUES (?, ?, NULL, 'queued', 'agent', ?, ?, ?)`,
  ).bind(
    statusEventId, taskId, tokenData.workspaceId,
    `Dispatched by agent (depth ${newDepth}, parent task ${tokenData.taskId})`,
    now,
  ).run();

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

// Roles whose consecutive tokens should be concatenated into a single logical message.
// Mirrors the frontend groupMessages() in ProjectMessageView.tsx.
const GROUPABLE_ROLES = new Set(['assistant', 'tool', 'thinking']);

export interface TokenRow {
  id: string;
  role: string;
  content: string;
  createdAt: number;
}

/**
 * Groups consecutive same-role streaming tokens into logical messages.
 * Each row in chat_messages is an individual streaming chunk ("token").
 * This function concatenates consecutive tokens with the same groupable role
 * (assistant, tool, thinking) into a single message, using the first token's
 * id and createdAt. Non-groupable roles (user, system, plan) pass through as-is.
 */
export function groupTokensIntoMessages(tokens: TokenRow[]): TokenRow[] {
  const grouped: TokenRow[] = [];
  for (const token of tokens) {
    const last = grouped[grouped.length - 1];
    if (last && last.role === token.role && GROUPABLE_ROLES.has(token.role)) {
      last.content += token.content;
    } else {
      grouped.push({ ...token });
    }
  }
  return grouped;
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

  // Each row in chat_messages is a streaming token (chunk). Group consecutive
  // same-role tokens into logical messages before returning to agents.
  const tokens = messages.map((m: Record<string, unknown>) => ({
    id: m.id as string,
    role: m.role as string,
    content: m.content as string,
    createdAt: m.createdAt as number,
  }));
  const result = groupTokensIntoMessages(tokens);

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

// ─── Session–Idea linking handlers ────────────────────────────────────────────

/**
 * Resolve the current chat session ID from the workspace ID in the MCP token.
 * Returns null if the workspace has no linked session.
 */
async function resolveSessionId(env: Env, workspaceId: string): Promise<string | null> {
  try {
    const row = await env.DATABASE.prepare('SELECT chat_session_id FROM workspaces WHERE id = ?')
      .bind(workspaceId)
      .first<{ chat_session_id: string | null }>();
    return row?.chat_session_id ?? null;
  } catch {
    return null;
  }
}

async function handleLinkIdea(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const taskId = typeof params.taskId === 'string' ? params.taskId.trim() : '';
  if (!taskId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'taskId is required');
  }

  const limits = getMcpLimits(env);
  const context = typeof params.context === 'string' ? sanitizeUserInput(params.context.trim()).slice(0, limits.ideaContextMaxLength) : null;

  // Resolve session ID from workspace
  const sessionId = await resolveSessionId(env, tokenData.workspaceId);
  if (!sessionId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'No chat session found for the current workspace');
  }

  // Verify the task exists in this project
  const task = await env.DATABASE.prepare(
    'SELECT id, title FROM tasks WHERE id = ? AND project_id = ?',
  ).bind(taskId, tokenData.projectId).first<{ id: string; title: string }>();

  if (!task) {
    return jsonRpcError(requestId, INVALID_PARAMS, `Idea not found in this project: ${taskId}`);
  }

  await projectDataService.linkSessionIdea(env, tokenData.projectId, sessionId, taskId, context);

  return jsonRpcSuccess(requestId, {
    content: [{
      type: 'text',
      text: JSON.stringify({
        linked: true,
        sessionId,
        taskId,
        taskTitle: task.title,
        context,
      }, null, 2),
    }],
  });
}

async function handleUnlinkIdea(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const taskId = typeof params.taskId === 'string' ? params.taskId.trim() : '';
  if (!taskId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'taskId is required');
  }

  const sessionId = await resolveSessionId(env, tokenData.workspaceId);
  if (!sessionId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'No chat session found for the current workspace');
  }

  await projectDataService.unlinkSessionIdea(env, tokenData.projectId, sessionId, taskId);

  return jsonRpcSuccess(requestId, {
    content: [{
      type: 'text',
      text: JSON.stringify({ unlinked: true, sessionId, taskId }, null, 2),
    }],
  });
}

async function handleListLinkedIdeas(
  requestId: string | number | null,
  _params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const sessionId = await resolveSessionId(env, tokenData.workspaceId);
  if (!sessionId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'No chat session found for the current workspace');
  }

  const links = await projectDataService.getIdeasForSession(env, tokenData.projectId, sessionId);

  // Enrich with task details from D1
  const enriched: Array<{
    taskId: string;
    title: string | null;
    status: string | null;
    context: string | null;
    linkedAt: number;
  }> = [];

  if (links.length > 0) {
    // Batch-fetch task details in a single D1 query
    const placeholders = links.map(() => '?').join(', ');
    const rows = await env.DATABASE.prepare(
      `SELECT id, title, status FROM tasks WHERE project_id = ? AND id IN (${placeholders})`,
    ).bind(tokenData.projectId, ...links.map((l) => l.taskId)).all<{ id: string; title: string; status: string }>();

    const taskMap = new Map((rows.results ?? []).map((t) => [t.id, t]));

    for (const link of links) {
      const task = taskMap.get(link.taskId);
      enriched.push({
        taskId: link.taskId,
        title: task?.title ?? null,
        status: task?.status ?? null,
        context: link.context,
        linkedAt: link.createdAt,
      });
    }
  }

  return jsonRpcSuccess(requestId, {
    content: [{
      type: 'text',
      text: JSON.stringify({
        sessionId,
        ideas: enriched,
        count: enriched.length,
      }, null, 2),
    }],
  });
}

async function handleFindRelatedIdeas(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const query = typeof params.query === 'string' ? params.query.trim() : '';
  if (!query) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'query is required');
  }
  if (query.length < 2) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'query must be at least 2 characters');
  }

  const limits = getMcpLimits(env);
  const requestedLimit = typeof params.limit === 'number' ? params.limit : 10;
  const limit = Math.min(Math.max(1, Math.round(requestedLimit)), limits.taskSearchMax);
  // Default to 'draft' status (ideas) when no explicit status filter is provided
  const statusFilter = typeof params.status === 'string' ? params.status.trim() : 'draft';

  const searchPattern = `%${query}%`;

  let queryStr = `SELECT id, title, description, status, priority, updated_at FROM tasks WHERE project_id = ? AND (title LIKE ? OR description LIKE ?)`;
  const bindParams: unknown[] = [tokenData.projectId, searchPattern, searchPattern];

  queryStr += ' AND status = ?';
  bindParams.push(statusFilter);

  queryStr += ' ORDER BY updated_at DESC LIMIT ?';
  bindParams.push(limit);

  const stmt = env.DATABASE.prepare(queryStr);
  const results = await stmt.bind(...bindParams).all<{
    id: string;
    title: string;
    description: string | null;
    status: string;
    priority: number;
    updated_at: string;
  }>();

  const snippetLength = limits.taskDescriptionSnippetLength;

  return jsonRpcSuccess(requestId, {
    content: [{
      type: 'text',
      text: JSON.stringify({
        ideas: (results.results ?? []).map((t) => ({
          taskId: t.id,
          title: t.title,
          status: t.status,
          priority: t.priority,
          description: t.description
            ? t.description.slice(0, snippetLength) + (t.description.length > snippetLength ? '...' : '')
            : null,
          updatedAt: t.updated_at,
        })),
        count: results.results?.length ?? 0,
        query,
      }, null, 2),
    }],
  });
}

// ─── Idea management handlers ────────────────────────────────────────────────

async function handleCreateIdea(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const limits = getMcpLimits(env);

  const title = typeof params.title === 'string' ? sanitizeUserInput(params.title.trim()).slice(0, limits.ideaTitleMaxLength) : '';
  if (!title) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'title is required and must be a non-empty string');
  }

  const content = typeof params.content === 'string'
    ? sanitizeUserInput(params.content).slice(0, limits.ideaContentMaxLength)
    : null;

  const priority = typeof params.priority === 'number'
    ? Math.min(Math.max(0, Math.round(params.priority)), limits.dispatchMaxPriority)
    : 0;

  const ideaId = ulid();
  const now = new Date().toISOString();

  await env.DATABASE.prepare(
    `INSERT INTO tasks (id, project_id, user_id, title, description, status, priority, task_mode, dispatch_depth, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'draft', ?, 'task', 0, 'mcp', ?, ?)`,
  ).bind(ideaId, tokenData.projectId, tokenData.userId, title, content, priority, now, now).run();

  log.info('mcp.create_idea', {
    ideaId,
    projectId: tokenData.projectId,
    userId: tokenData.userId,
    titleLength: title.length,
    contentLength: content?.length ?? 0,
  });

  return jsonRpcSuccess(requestId, {
    content: [{
      type: 'text',
      text: JSON.stringify({
        ideaId,
        title,
        contentLength: content?.length ?? 0,
        priority,
        status: 'draft',
        message: 'Idea created. Use link_idea to associate it with the current session.',
      }, null, 2),
    }],
  });
}

async function handleUpdateIdea(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const limits = getMcpLimits(env);

  const ideaId = typeof params.ideaId === 'string' ? params.ideaId.trim() : '';
  if (!ideaId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'ideaId is required');
  }

  // Fetch the existing idea — must be draft status and in this project
  const existing = await env.DATABASE.prepare(
    'SELECT id, title, description, status, priority FROM tasks WHERE id = ? AND project_id = ?',
  ).bind(ideaId, tokenData.projectId).first<{ id: string; title: string; description: string | null; status: string; priority: number }>();

  if (!existing) {
    return jsonRpcError(requestId, INVALID_PARAMS, `Idea not found in this project: ${ideaId}`);
  }
  if (existing.status !== 'draft') {
    return jsonRpcError(requestId, INVALID_PARAMS, `Cannot update: task ${ideaId} has status '${existing.status}' (only draft ideas can be updated via this tool)`);
  }

  // Build update fields
  const updates: string[] = [];
  const bindValues: unknown[] = [];

  // Title update
  if (typeof params.title === 'string') {
    const newTitle = sanitizeUserInput(params.title.trim()).slice(0, limits.ideaTitleMaxLength);
    if (newTitle) {
      updates.push('title = ?');
      bindValues.push(newTitle);
    }
  }

  // Content update (append or replace)
  if (typeof params.content === 'string') {
    const newContent = sanitizeUserInput(params.content).slice(0, limits.ideaContentMaxLength);
    const append = params.append !== false; // default true

    if (append && existing.description) {
      const combined = (existing.description + '\n\n' + newContent).slice(0, limits.ideaContentMaxLength);
      updates.push('description = ?');
      bindValues.push(combined);
    } else {
      updates.push('description = ?');
      bindValues.push(newContent);
    }
  }

  // Priority update
  if (typeof params.priority === 'number') {
    const newPriority = Math.min(Math.max(0, Math.round(params.priority)), limits.dispatchMaxPriority);
    updates.push('priority = ?');
    bindValues.push(newPriority);
  }

  if (updates.length === 0) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'No fields to update. Provide at least one of: title, content, priority.');
  }

  updates.push('updated_at = ?');
  const now = new Date().toISOString();
  bindValues.push(now);
  bindValues.push(ideaId, tokenData.projectId);

  await env.DATABASE.prepare(
    `UPDATE tasks SET ${updates.join(', ')} WHERE id = ? AND project_id = ?`,
  ).bind(...bindValues).run();

  log.info('mcp.update_idea', {
    ideaId,
    projectId: tokenData.projectId,
    updatedFields: updates.filter((u) => !u.startsWith('updated_at')).map((u) => u.split(' = ')[0]),
  });

  return jsonRpcSuccess(requestId, {
    content: [{
      type: 'text',
      text: JSON.stringify({
        updated: true,
        ideaId,
        updatedFields: updates.filter((u) => !u.startsWith('updated_at')).map((u) => u.split(' = ')[0]),
      }, null, 2),
    }],
  });
}

async function handleGetIdea(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const ideaId = typeof params.ideaId === 'string' ? params.ideaId.trim() : '';
  if (!ideaId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'ideaId is required');
  }

  const idea = await env.DATABASE.prepare(
    'SELECT id, title, description, status, priority, created_at, updated_at FROM tasks WHERE id = ? AND project_id = ? AND status = ?',
  ).bind(ideaId, tokenData.projectId, 'draft').first<{
    id: string;
    title: string;
    description: string | null;
    status: string;
    priority: number;
    created_at: string;
    updated_at: string;
  }>();

  if (!idea) {
    return jsonRpcError(requestId, INVALID_PARAMS, `Idea not found in this project: ${ideaId}. Note: only draft tasks are returned by this tool — use get_task_details for non-draft tasks.`);
  }

  return jsonRpcSuccess(requestId, {
    content: [{
      type: 'text',
      text: JSON.stringify({
        ideaId: idea.id,
        title: idea.title,
        content: idea.description,
        contentLength: idea.description?.length ?? 0,
        priority: idea.priority,
        status: idea.status,
        createdAt: idea.created_at,
        updatedAt: idea.updated_at,
      }, null, 2),
    }],
  });
}

async function handleListIdeas(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const limits = getMcpLimits(env);
  const requestedLimit = typeof params.limit === 'number' ? params.limit : limits.ideaListLimit;
  const limit = Math.min(Math.max(1, Math.round(requestedLimit)), limits.ideaListMax);

  const snippetLength = limits.taskDescriptionSnippetLength;

  const results = await env.DATABASE.prepare(
    'SELECT id, title, description, priority, created_at, updated_at FROM tasks WHERE project_id = ? AND status = ? ORDER BY updated_at DESC LIMIT ?',
  ).bind(tokenData.projectId, 'draft', limit).all<{
    id: string;
    title: string;
    description: string | null;
    priority: number;
    created_at: string;
    updated_at: string;
  }>();

  return jsonRpcSuccess(requestId, {
    content: [{
      type: 'text',
      text: JSON.stringify({
        ideas: (results.results ?? []).map((idea) => ({
          ideaId: idea.id,
          title: idea.title,
          contentSnippet: idea.description
            ? idea.description.slice(0, snippetLength) + (idea.description.length > snippetLength ? '...' : '')
            : null,
          priority: idea.priority,
          createdAt: idea.created_at,
          updatedAt: idea.updated_at,
        })),
        count: results.results?.length ?? 0,
      }, null, 2),
    }],
  });
}

async function handleSearchIdeas(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const query = typeof params.query === 'string' ? params.query.trim() : '';
  if (!query) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'query is required');
  }
  if (query.length < 2) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'query must be at least 2 characters');
  }

  const limits = getMcpLimits(env);
  const requestedLimit = typeof params.limit === 'number' ? params.limit : 10;
  const limit = Math.min(Math.max(1, Math.round(requestedLimit)), limits.ideaSearchMax);
  const snippetLength = limits.taskDescriptionSnippetLength;

  const searchPattern = `%${query}%`;

  const results = await env.DATABASE.prepare(
    'SELECT id, title, description, priority, created_at, updated_at FROM tasks WHERE project_id = ? AND status = ? AND (title LIKE ? OR description LIKE ?) ORDER BY updated_at DESC LIMIT ?',
  ).bind(tokenData.projectId, 'draft', searchPattern, searchPattern, limit).all<{
    id: string;
    title: string;
    description: string | null;
    priority: number;
    created_at: string;
    updated_at: string;
  }>();

  return jsonRpcSuccess(requestId, {
    content: [{
      type: 'text',
      text: JSON.stringify({
        ideas: (results.results ?? []).map((idea) => ({
          ideaId: idea.id,
          title: idea.title,
          contentSnippet: idea.description
            ? idea.description.slice(0, snippetLength) + (idea.description.length > snippetLength ? '...' : '')
            : null,
          priority: idea.priority,
          createdAt: idea.created_at,
          updatedAt: idea.updated_at,
        })),
        count: results.results?.length ?? 0,
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
        case 'request_human_input':
          return c.json(await handleRequestHumanInput(requestId, toolArgs, tokenData, c.env));
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
        case 'link_idea':
          return c.json(await handleLinkIdea(requestId, toolArgs, tokenData, c.env));
        case 'unlink_idea':
          return c.json(await handleUnlinkIdea(requestId, toolArgs, tokenData, c.env));
        case 'list_linked_ideas':
          return c.json(await handleListLinkedIdeas(requestId, toolArgs, tokenData, c.env));
        case 'find_related_ideas':
          return c.json(await handleFindRelatedIdeas(requestId, toolArgs, tokenData, c.env));
        case 'create_idea':
          return c.json(await handleCreateIdea(requestId, toolArgs, tokenData, c.env));
        case 'update_idea':
          return c.json(await handleUpdateIdea(requestId, toolArgs, tokenData, c.env));
        case 'get_idea':
          return c.json(await handleGetIdea(requestId, toolArgs, tokenData, c.env));
        case 'list_ideas':
          return c.json(await handleListIdeas(requestId, toolArgs, tokenData, c.env));
        case 'search_ideas':
          return c.json(await handleSearchIdeas(requestId, toolArgs, tokenData, c.env));
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
