import { sanitizeUserInput } from '../lib/sanitize-user-input';
import { ulid } from '../lib/ulid';
import { resolveAdminSetting } from '../services/admin-settings';
import * as projectData from '../services/project-data';
import { formatOperationCursor, readOperationCursor } from './cursors';
import { OperationError } from './errors';
import { ideaTaskPredicateSql } from './idea-identity';
import type { OperationContext } from './types';

async function requireIdea(ctx: OperationContext, projectId: string, ideaId: string) {
  const row = await ctx.env.DATABASE.prepare(
    `SELECT id FROM tasks WHERE id = ? AND project_id = ? AND ${ideaTaskPredicateSql()}`
  )
    .bind(ideaId, projectId)
    .first<{ id: string }>();
  if (!row) throw new OperationError('not_found', 'Idea not found in this project');
}

async function setting(ctx: OperationContext, name: Parameters<typeof resolveAdminSetting>[1]) {
  return Number(await resolveAdminSetting(ctx.env, name));
}

export async function validateIdeaUpdateNote(
  ctx: OperationContext,
  bodyInput: string,
  quoteInput?: string
) {
  const [bodyMax, quoteMax] = await Promise.all([
    setting(ctx, 'collaboration.ideaUpdateBodyMaxLength'),
    setting(ctx, 'collaboration.ideaUpdateQuoteMaxLength'),
  ]);
  const body = typeof bodyInput === 'string' ? sanitizeUserInput(bodyInput.trim()) : '';
  const quote = typeof quoteInput === 'string' ? sanitizeUserInput(quoteInput.trim()) : null;
  if (!body || body.length > bodyMax)
    throw new OperationError('invalid_input', `Note must contain 1–${bodyMax} characters`);
  if (quote && quote.length > quoteMax)
    throw new OperationError('invalid_input', `Quote exceeds ${quoteMax} characters`);
  return { body, quote };
}

export async function addIdeaUpdate(
  ctx: OperationContext,
  input: { projectId: string; ideaId: string; body: string; quote?: string }
) {
  await requireIdea(ctx, input.projectId, input.ideaId);
  const [{ body, quote }, interval] = await Promise.all([
    validateIdeaUpdateNote(ctx, input.body, input.quote),
    setting(ctx, 'collaboration.ideaAgentNoteMinIntervalSeconds'),
  ]);
  let sessionId: string | null = null;
  if (ctx.actor.workspace) {
    const row = await ctx.env.DATABASE.prepare(
      'SELECT chat_session_id FROM workspaces WHERE id = ? AND project_id = ?'
    )
      .bind(ctx.actor.workspace.workspaceId, input.projectId)
      .first<{ chat_session_id: string | null }>();
    sessionId = row?.chat_session_id ?? null;
    if (!sessionId)
      throw new OperationError('invalid_input', 'No chat session found for the current workspace');
  }
  const author = await ctx.env.DATABASE.prepare('SELECT name FROM users WHERE id = ?')
    .bind(ctx.actor.userId)
    .first<{ name: string | null }>();
  let authorName = author?.name ?? null;
  let sessionTopic: string | null = null;
  if (sessionId && ctx.actor.workspace) {
    const agent = ctx.actor.workspace.agentSessionId
      ? await ctx.env.DATABASE.prepare(
          `SELECT COALESCE(p.name, a.label, a.agent_type) AS name
       FROM agent_sessions a LEFT JOIN agent_profiles p ON p.id = a.agent_profile_id
       WHERE a.id = ? AND a.workspace_id = ? LIMIT 1`
        )
          .bind(ctx.actor.workspace.agentSessionId, ctx.actor.workspace.workspaceId)
          .first<{ name: string | null }>()
      : null;
    authorName = agent?.name ?? 'Agent';
    const session = await projectData.getSession(ctx.env, input.projectId, sessionId);
    sessionTopic = typeof session?.topic === 'string' ? session.topic : null;
  }
  const update = {
    id: ulid(),
    ideaId: input.ideaId,
    authorKind: ctx.actor.via === 'workspace-agent' ? ('agent' as const) : ('user' as const),
    authorUserId: ctx.actor.userId,
    authorName,
    sessionId,
    sessionTopic,
    body,
    quote,
    createdAt: new Date().toISOString(),
    editedAt: null,
  };
  try {
    return {
      update: await projectData.addIdeaUpdate(ctx.env, input.projectId, update, interval * 1000),
    };
  } catch (error) {
    if (error instanceof Error && error.message === 'Agent note rate limit exceeded')
      throw new OperationError(
        'rate_limited',
        'Please wait before adding another note to this idea'
      );
    throw error;
  }
}

export async function listIdeaUpdates(
  ctx: OperationContext,
  input: { projectId: string; ideaId: string; cursor?: string; limit?: number }
) {
  await requireIdea(ctx, input.projectId, input.ideaId);
  const cursor = readOperationCursor(input.cursor);
  const pageSize = await setting(ctx, 'collaboration.ideaUpdatePageSize');
  // The optional override is internal and comes from the typed agent-context setting.
  const limit = input.limit ?? pageSize;
  const page = await projectData.listIdeaUpdates(
    ctx.env,
    input.projectId,
    input.ideaId,
    cursor ? { createdAt: cursor.updatedAt, id: cursor.id } : null,
    limit
  );
  return {
    updates: page.updates,
    total: page.total,
    nextCursor: page.nextCursor
      ? formatOperationCursor({ updatedAt: page.nextCursor.createdAt, id: page.nextCursor.id })
      : null,
    untrustedContent: true as const,
  };
}

export async function deleteIdeaUpdate(
  ctx: OperationContext,
  input: { projectId: string; ideaId: string; updateId: string }
) {
  await requireIdea(ctx, input.projectId, input.ideaId);
  const member = await ctx.env.DATABASE.prepare(
    "SELECT role FROM project_members WHERE project_id = ? AND user_id = ? AND status = 'active'"
  )
    .bind(input.projectId, ctx.actor.userId)
    .first<{ role: string }>();
  if (!member) throw new OperationError('forbidden', 'Project membership required');
  const deleted = await projectData.deleteIdeaUpdate(
    ctx.env,
    input.projectId,
    input.ideaId,
    input.updateId,
    ctx.actor.userId,
    member.role === 'owner' || member.role === 'admin',
    new Date().toISOString()
  );
  if (!deleted)
    throw new OperationError('not_found', 'Update not found or deletion is not allowed');
  return { deleted: true };
}
