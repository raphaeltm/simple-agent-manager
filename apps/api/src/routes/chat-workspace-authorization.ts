import { and, eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { log } from '../lib/logger';
import { errors } from '../middleware/error';
import {
  ACTIVE_WORKSPACE_STATUSES,
  hasAuthorizedWorkspaceSessionLink,
} from '../services/workspace-cleanup-authorization';

type ChatDb = ReturnType<typeof drizzle<typeof schema>>;

interface ChatWorkspaceScope {
  projectId: string;
  userId: string;
  workspaceId: string;
  source: 'session_create' | 'session_stop';
}

function optionalString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export async function requireSessionWorkspaceScope(
  db: ChatDb,
  input: {
    projectId: string;
    userId: string;
    sessionId: string;
    session: Record<string, unknown>;
  }
): Promise<void> {
  const sessionWorkspaceId = optionalString(input.session, 'workspaceId');
  if (!sessionWorkspaceId) return;

  const workspace = await requireChatWorkspaceScope(db, {
    projectId: input.projectId,
    userId: input.userId,
    workspaceId: sessionWorkspaceId,
    source: 'session_stop',
  });

  if (workspace.chatSessionId && workspace.chatSessionId !== input.sessionId) {
    log.warn('chat.session_workspace_backlink_mismatch', {
      projectId: input.projectId,
      userId: input.userId,
      sessionId: input.sessionId,
      workspaceId: sessionWorkspaceId,
      workspaceSessionId: workspace.chatSessionId,
      action: 'rejected',
    });
    throw errors.notFound('Chat session');
  }
}

/**
 * Resolve a caller-supplied workspace only when both its project and owner match
 * the authenticated chat scope. The post-query checks are deliberate defence in
 * depth against a weakened predicate or an unfaithful database adapter.
 */
export async function requireChatWorkspaceScope(
  db: ChatDb,
  scope: ChatWorkspaceScope
): Promise<schema.Workspace> {
  const [workspace] = await db
    .select()
    .from(schema.workspaces)
    .where(
      and(
        eq(schema.workspaces.id, scope.workspaceId),
        eq(schema.workspaces.projectId, scope.projectId),
        eq(schema.workspaces.userId, scope.userId)
      )
    )
    .limit(1);

  if (
    !workspace ||
    workspace.id !== scope.workspaceId ||
    workspace.projectId !== scope.projectId ||
    workspace.userId !== scope.userId ||
    !ACTIVE_WORKSPACE_STATUSES.has(workspace.status)
  ) {
    log.warn('chat.workspace_scope_rejected', {
      projectId: scope.projectId,
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      source: scope.source,
      workspaceStatus: workspace?.status ?? null,
      action: 'rejected',
    });
    throw errors.notFound('Workspace');
  }

  return workspace;
}

/**
 * A task-backed session must name the same workspace in both stores before an
 * archive is allowed to reach cleanup. This catches stale/corrupt cross-store
 * links before task state or external resources are mutated.
 */
export async function requireSessionTaskWorkspaceScope(
  db: ChatDb,
  input: {
    projectId: string;
    userId: string;
    sessionId: string;
    session: Record<string, unknown>;
    task: schema.Task;
  }
): Promise<void> {
  const sessionWorkspaceId = optionalString(input.session, 'workspaceId');
  const taskWorkspaceId = input.task.workspaceId?.trim() || null;

  const taskMatchesSessionScope =
    input.task.projectId === input.projectId && input.task.chatSessionId === input.sessionId;

  if (!taskMatchesSessionScope || sessionWorkspaceId !== taskWorkspaceId) {
    log.warn('chat.session_task_workspace_mismatch', {
      projectId: input.projectId,
      userId: input.userId,
      sessionId: input.sessionId,
      taskId: input.task.id,
      taskProjectId: input.task.projectId,
      taskSessionId: input.task.chatSessionId,
      sessionWorkspaceId,
      taskWorkspaceId,
      action: 'rejected',
    });
    throw errors.notFound('Chat session');
  }

  if (!taskWorkspaceId) return;

  const workspace = await requireChatWorkspaceScope(db, {
    projectId: input.projectId,
    userId: input.userId,
    workspaceId: taskWorkspaceId,
    source: 'session_stop',
  });

  if (workspace.chatSessionId && workspace.chatSessionId !== input.sessionId) {
    log.warn('chat.session_workspace_backlink_mismatch', {
      projectId: input.projectId,
      userId: input.userId,
      sessionId: input.sessionId,
      taskId: input.task.id,
      workspaceId: taskWorkspaceId,
      workspaceSessionId: workspace.chatSessionId,
      action: 'rejected',
    });
    throw errors.notFound('Chat session');
  }

  if (
    !hasAuthorizedWorkspaceSessionLink(
      input.task.chatSessionId,
      workspace.chatSessionId,
      input.task.taskMode,
      input.task.userId,
      workspace.userId,
      true
    )
  ) {
    log.warn('chat.session_workspace_link_rejected', {
      projectId: input.projectId,
      userId: input.userId,
      sessionId: input.sessionId,
      taskId: input.task.id,
      workspaceId: taskWorkspaceId,
      workspaceSessionId: workspace.chatSessionId,
      action: 'rejected',
    });
    throw errors.notFound('Chat session');
  }
}
