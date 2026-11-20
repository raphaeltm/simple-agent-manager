/**
 * MCP adapters for the agent inbox tools (slices D and H1): `inbox_write` (ask, review, result,
 * assign, comment, attach, update, cancel)
 * and `inbox_read` (list, get). Each one resolves where the call came from (project, chat, task,
 * person) from the verified token, runs the shared operation (`fileAgentAsk`, ...), and formats
 * the result. No inbox rule lives here.
 */
import {
  type AgentAssignResult,
  type AgentFileResult,
  type AgentInboxSource,
  assignAgentTask,
  attachAgentTask,
  cancelAgentAsk,
  commentAgentTask,
  fileAgentAsk,
  fileAgentResult,
  fileAgentReview,
  getAgentItem,
  inboxAgentReplyState,
  listAgentAsks,
  type OperationContext,
  OperationError,
  resolveAgentInboxItem,
  respondToAgentInboxItem,
  updateAgentAsk,
} from '@simple-agent-manager/operations';
import { ValiError } from 'valibot';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { createOperationPorts } from '../../operation-ports';
import * as notificationService from '../../services/notification';
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
} from './_helpers';

type Source = { source: AgentInboxSource } | { error: string };

/**
 * The chat, task and person the call is from. The task must belong to the token's project and
 * person; the chat is the token's, else the task's, else the workspace's.
 */
async function resolveSource(tokenData: McpTokenData, env: Env): Promise<Source> {
  if (!tokenData.taskId) return { error: 'Inbox tools need a task-backed agent session' };
  const task = await env.DATABASE.prepare(
    'SELECT user_id, chat_session_id FROM tasks WHERE id = ? AND project_id = ?'
  )
    .bind(tokenData.taskId, tokenData.projectId)
    .first<{ user_id: string; chat_session_id: string | null }>();
  if (!task || task.user_id !== tokenData.userId) {
    log.error('mcp.inbox.task_mismatch', {
      taskId: tokenData.taskId,
      projectId: tokenData.projectId,
      tokenUserId: tokenData.userId,
      taskUserId: task?.user_id ?? null,
      action: 'rejected',
    });
    return { error: 'Task not found' };
  }
  const sessionId =
    tokenData.chatSessionId ??
    task.chat_session_id ??
    (await notificationService.getChatSessionId(env, tokenData.workspaceId));
  if (!sessionId) return { error: 'This session has no chat to file inbox items from' };
  return {
    source: {
      projectId: tokenData.projectId,
      sessionId,
      taskId: tokenData.taskId,
      workspaceId: tokenData.workspaceId || null,
      userId: tokenData.userId,
    },
  };
}

function operationContext(
  tokenData: McpTokenData,
  env: Env,
  requestId: string | number | null
): OperationContext {
  return {
    env,
    ports: createOperationPorts(env),
    requestId: String(requestId ?? ''),
    actor: {
      userId: tokenData.userId,
      via: 'workspace-agent',
      scopes: new Set(['sam.read', 'sam.write']),
      workspace: {
        workspaceId: tokenData.workspaceId,
        taskId: tokenData.taskId,
        projectId: tokenData.projectId,
        agentSessionId: tokenData.agentSessionId,
      },
    },
  };
}

function json(requestId: string | number | null, payload: unknown): JsonRpcResponse {
  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  });
}

async function run(
  requestId: string | number | null,
  tool: string,
  tokenData: McpTokenData,
  env: Env,
  body: (ctx: OperationContext, source: AgentInboxSource) => Promise<unknown>
): Promise<JsonRpcResponse> {
  const resolved = await resolveSource(tokenData, env);
  if ('error' in resolved) return jsonRpcError(requestId, INVALID_PARAMS, resolved.error);
  try {
    return json(
      requestId,
      await body(operationContext(tokenData, env, requestId), resolved.source)
    );
  } catch (error) {
    if (error instanceof ValiError) {
      const issue = error.issues[0];
      const path = issue?.path?.map((item: { key: unknown }) => String(item.key)).join('.');
      return jsonRpcError(
        requestId,
        INVALID_PARAMS,
        `${tool}: ${path ? `${path}: ` : ''}${issue?.message ?? 'invalid arguments'}`
      );
    }
    if (error instanceof OperationError) {
      return jsonRpcError(
        requestId,
        error.code === 'unavailable' ? INTERNAL_ERROR : INVALID_PARAMS,
        error.message
      );
    }
    log.error('mcp.inbox.failed', {
      tool,
      projectId: tokenData.projectId,
      taskId: tokenData.taskId,
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonRpcError(requestId, INTERNAL_ERROR, `${tool} failed`);
  }
}

/**
 * The filing result. `inboxItem` is what the chat card reads (by ID only: the card re-reads the
 * item from the server); `similar` lets the agent avoid a duplicate.
 */
function filed(result: AgentFileResult) {
  const next = !result.created
    ? `This idempotencyKey already filed ${result.ref}; nothing new was filed.`
    : result.blocking
      ? 'Filed in the person’s inbox. End your turn if you cannot continue: you will be woken in this chat when they answer.'
      : result.kind === 'result'
        ? 'Filed in the person’s inbox. If they reply while your task is still running, you will be woken in this chat with the reply; "Got it" does not wake you.'
        : 'Filed in the person’s inbox. Keep working: you will be told in this chat when they answer.';
  const duplicateHint =
    result.similar.length > 0
      ? ' Similar open items exist (see `similar`): if one already covers this, cancel yours with inbox_write method cancel and say which one to use.'
      : '';
  return {
    message: next + duplicateHint,
    inboxItem: {
      ref: result.ref,
      id: result.id,
      sessionId: result.sessionId,
      kind: result.kind,
      blocking: result.blocking,
    },
    created: result.created,
    notificationScheduled: result.notificationScheduled,
    similar: result.similar,
  };
}

type Handler = (
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
) => Promise<JsonRpcResponse>;

export const handleInboxAsk: Handler = (requestId, params, tokenData, env) =>
  run(requestId, 'inbox_write ask', tokenData, env, async (ctx, source) =>
    filed(await fileAgentAsk(ctx, source, params as Parameters<typeof fileAgentAsk>[2]))
  );

export const handleInboxReview: Handler = (requestId, params, tokenData, env) =>
  run(requestId, 'inbox_write review', tokenData, env, async (ctx, source) =>
    filed(await fileAgentReview(ctx, source, params as Parameters<typeof fileAgentReview>[2]))
  );

export const handleInboxResult: Handler = (requestId, params, tokenData, env) =>
  run(requestId, 'inbox_write result', tokenData, env, async (ctx, source) =>
    filed(await fileAgentResult(ctx, source, params as Parameters<typeof fileAgentResult>[2]))
  );

export const handleInboxUpdateItem: Handler = (requestId, params, tokenData, env) =>
  run(requestId, 'inbox_write update', tokenData, env, async (ctx, source) => {
    const result = await updateAgentAsk(
      ctx,
      source,
      params as Parameters<typeof updateAgentAsk>[2]
    );
    return withReplyState(ctx, source, result);
  });

export const handleInboxCancelItem: Handler = (requestId, params, tokenData, env) =>
  run(requestId, 'inbox_write cancel', tokenData, env, (ctx, source) =>
    cancelAgentAsk(ctx, source, params as Parameters<typeof cancelAgentAsk>[2])
  );

export const handleInboxListItems: Handler = (requestId, params, tokenData, env) =>
  run(requestId, 'inbox_read list', tokenData, env, (ctx, source) => {
    if (params.scope !== undefined && params.scope !== 'chat' && params.scope !== 'project')
      throw new OperationError('invalid_input', 'scope must be chat or project');
    return listAgentAsks(ctx, source, {
      scope: params.scope === 'project' ? 'project' : 'chat',
      limit: typeof params.limit === 'number' ? params.limit : undefined,
    });
  });

export const handleInboxGetItem: Handler = (requestId, params, tokenData, env) =>
  run(requestId, 'inbox_read get', tokenData, env, async (ctx, source) => ({
    item: await getAgentItem(ctx, source, {
      ref: typeof params.ref === 'string' ? params.ref : '',
      ...(params.replyCursor === undefined ? {} : { replyCursor: params.replyCursor as string }),
      ...(params.responseCursor === undefined
        ? {}
        : { responseCursor: params.responseCursor as number }),
    }),
  }));

/** The assign result: `inboxItem` is what the chat card reads, as for an ask or a review. */
function assigned(result: AgentAssignResult) {
  const next = !result.created
    ? `This task was already assigned as ${result.ref}; nothing new was filed.`
    : 'Assigned. It does not block you: keep working. You will be woken in this chat when the person comments, takes it, hands it on, finishes or reopens it (archiving it wakes no one).';
  const watch = result.watching
    ? ''
    : ' This chat could not be subscribed to the task yet; repeat this assign call with the same idempotencyKey (or title) to subscribe it.';
  const duplicateHint =
    result.similar.length > 0
      ? ' Similar open items exist (see `similar`): if one already covers this, cancel yours with inbox_write method cancel.'
      : '';
  return {
    message: next + watch + duplicateHint,
    inboxItem: {
      ref: result.ref,
      id: result.id,
      sessionId: result.sessionId,
      kind: result.kind,
      blocking: result.blocking,
    },
    created: result.created,
    watching: result.watching,
    similar: result.similar,
  };
}

export const handleInboxAssign: Handler = (requestId, params, tokenData, env) =>
  run(requestId, 'inbox_write assign', tokenData, env, async (ctx, source) =>
    assigned(await assignAgentTask(ctx, source, params as Parameters<typeof assignAgentTask>[2]))
  );

export const handleInboxComment: Handler = (requestId, params, tokenData, env) =>
  run(requestId, 'inbox_write comment', tokenData, env, (ctx, source) =>
    commentAgentTask(ctx, source, params as Parameters<typeof commentAgentTask>[2])
  );

export const handleInboxAttach: Handler = (requestId, params, tokenData, env) =>
  run(requestId, 'inbox_write attach', tokenData, env, (ctx, source) =>
    attachAgentTask(ctx, source, params as Parameters<typeof attachAgentTask>[2])
  );

export const handleInboxRespond: Handler = (requestId, params, tokenData, env) =>
  run(requestId, 'inbox_write respond', tokenData, env, async (ctx, source) => {
    const result = await respondToAgentInboxItem(
      ctx,
      source,
      params as Parameters<typeof respondToAgentInboxItem>[2]
    );
    return withReplyState(ctx, source, result);
  });
export const handleInboxResolve: Handler = (requestId, params, tokenData, env) =>
  run(requestId, 'inbox_write resolve', tokenData, env, (ctx, source) =>
    resolveAgentInboxItem(ctx, source, params as Parameters<typeof resolveAgentInboxItem>[2])
  );

async function withReplyState<T extends { ref: string }>(
  ctx: OperationContext,
  source: AgentInboxSource,
  result: T
) {
  const state = await inboxAgentReplyState(ctx, source.projectId, result.ref);
  return {
    ...result,
    withAgent: state.withAgent,
    ...(state.withAgent
      ? {
          message:
            'Other replies are still outstanding. Read inbox_read get for this ref, follow conversation cursors, and explicitly handle its pendingReplyIds. Reading does not acknowledge them.',
        }
      : {}),
  };
}
