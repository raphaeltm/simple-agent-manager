/**
 * MCP Server Route
 *
 * Implements a lightweight MCP (Model Context Protocol) server using
 * JSON-RPC 2.0 over HTTP (Streamable HTTP transport). Exposes tools
 * to agents running in SAM workspaces.
 *
 * Auth: task-scoped opaque token stored in KV, passed as Bearer token.
 */
import { Hono } from 'hono';
import type { Env } from '../../index';
import {
  type JsonRpcRequest,
  jsonRpcSuccess,
  jsonRpcError,
  METHOD_NOT_FOUND,
  MCP_TOOLS,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  authenticateMcpRequest,
  checkMcpRateLimit,
  getMcpRateLimit,
} from './_helpers';
import { handleGetInstructions, handleRequestHumanInput } from './instruction-tools';
import {
  handleUpdateTaskStatus,
  handleCompleteTask,
  handleListTasks,
  handleGetTaskDetails,
  handleSearchTasks,
} from './task-tools';
import { handleDispatchTask } from './dispatch-tool';
import {
  handleListSessions,
  handleGetSessionMessages,
  handleSearchMessages,
} from './session-tools';
import { handleGetDeploymentCredentials } from './deployment-tools';
import {
  handleLinkIdea,
  handleUnlinkIdea,
  handleListLinkedIdeas,
  handleFindRelatedIdeas,
  handleCreateIdea,
  handleUpdateIdea,
  handleGetIdea,
  handleListIdeas,
  handleSearchIdeas,
} from './idea-tools';

// Re-export public API for backward compatibility
export { groupTokensIntoMessages } from './session-tools';
export type { TokenRow } from './session-tools';

export const mcpRoutes = new Hono<{ Bindings: Env }>();

// ─── MCP endpoint ────────────────────────────────────────────────────────────

mcpRoutes.post('/', async (c) => {
  // Authenticate — returns parsed token data and raw token
  const [tokenData, rawToken] = await authenticateMcpRequest(
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
        case 'get_deployment_credentials':
          return c.json(await handleGetDeploymentCredentials(requestId, tokenData, c.env, rawToken!));
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
