/**
 * Tenant-scoped resolution of the live workspace that bridges a chat session
 * to its running VM. Extracted from routes/chat.ts to keep that file under the
 * 800-line limit (.claude/rules/18) and to make the security-critical resolver
 * independently testable against real D1.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { log } from '../lib/logger';

type ChatDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Resolve the live workspace that bridges a chat session to its running VM,
 * scoped to the owning project AND user.
 *
 * Security: the workspace bridge MUST NOT be resolvable by `chatSessionId`
 * alone. Without project + user scoping, any authenticated caller who supplies
 * (or guesses/replays) a sessionId belonging to another tenant can drive the
 * VM agent for a workspace they do not own — an IDOR in the same class as past
 * cross-tenant leaks. We resolve via the narrowest canonical chat-scoped
 * identifier (`chatSessionId`) AND enforce ownership in the query WHERE clause
 * (see .claude/rules/06 canonical session routing, .claude/rules/11 identity
 * validation). A post-query defence-in-depth assertion rejects any row whose
 * ownership does not match the caller, guarding against a future WHERE-clause
 * regression (typo/refactor/ORM bug) per .claude/rules/28.
 *
 * Returns null when no matching active workspace exists for this owner.
 */
export async function resolveLiveWorkspaceForSession(
  db: ChatDb,
  { projectId, sessionId, userId }: { projectId: string; sessionId: string; userId: string }
): Promise<{ id: string; nodeId: string | null; nodeStatus: string | null } | null> {
  const [workspace] = await db
    .select({
      id: schema.workspaces.id,
      nodeId: schema.workspaces.nodeId,
      nodeStatus: schema.nodes.status,
      userId: schema.workspaces.userId,
      projectId: schema.workspaces.projectId,
    })
    .from(schema.workspaces)
    .leftJoin(schema.nodes, eq(schema.workspaces.nodeId, schema.nodes.id))
    .where(
      and(
        eq(schema.workspaces.chatSessionId, sessionId),
        eq(schema.workspaces.projectId, projectId),
        eq(schema.workspaces.userId, userId),
        inArray(schema.workspaces.status, ['running', 'recovery'])
      )
    )
    .limit(1);

  if (!workspace) {
    return null;
  }

  // Defence-in-depth: reject any row whose ownership doesn't match the caller.
  if (workspace.userId !== userId || workspace.projectId !== projectId) {
    log.error('chat: workspace ownership mismatch on session bridge', {
      sessionId,
      projectId,
      userId,
      workspaceId: workspace.id,
      rowUserId: workspace.userId,
      rowProjectId: workspace.projectId,
      action: 'rejected',
    });
    return null;
  }

  return { id: workspace.id, nodeId: workspace.nodeId, nodeStatus: workspace.nodeStatus };
}
