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
import { errors } from '../middleware/error';

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
        inArray(schema.workspaces.status, ['running', 'recovery', 'sleeping'])
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

/**
 * Resolve the live workspace AND its running agent session for a chat action
 * (e.g. /prompt, /cancel), enforcing tenant scoping at every layer.
 *
 * Consolidates the shared resolution path used by the /prompt and /cancel
 * handlers: workspace bridge resolution (project + user scoped), node-liveness
 * guards, and the defence-in-depth user-scoped agent-session lookup (backed by
 * idx_agent_sessions_ws_user_status). Throws the same fail-fast errors both
 * handlers relied on so callers can forward straight to the VM agent.
 *
 * @throws notFound when no active workspace/node or running agent session exists
 * @throws conflict when the workspace node is no longer running
 */
export async function resolveLiveAgentSessionForChat(
  db: ChatDb,
  { projectId, sessionId, userId }: { projectId: string; sessionId: string; userId: string }
): Promise<{ workspace: { id: string; nodeId: string }; agentSession: { id: string } }> {
  // Find the workspace linked to this chat session, scoped to the owning
  // project + user (see resolveLiveWorkspaceForSession). The node join also
  // verifies the node is still active: when a node is destroyed (e.g., after
  // task timeout), its DNS record is cleaned up but the workspace may still be
  // marked 'running' in D1. Without this check, the request to the VM agent
  // would hit the wildcard DNS record and loop back to this Worker (404).
  const workspace = await resolveLiveWorkspaceForSession(db, { projectId, sessionId, userId });

  if (!workspace || !workspace.nodeId) {
    throw errors.notFound('No active workspace found for this session');
  }

  // Verify the node is still reachable — prevents requests to destroyed VMs
  // whose DNS records no longer exist (would loop back via wildcard DNS).
  // D1 nodes.status uses 'running' for healthy nodes (not 'active'/'warm', which are DO states).
  if (workspace.nodeStatus === 'sleeping') {
    // Phase 3 of idea 01KX4KSXEXQMP41KS34TW9EN01 will wake and rehydrate the
    // cf-container before forwarding this prompt.
    throw errors.conflict('The workspace container is asleep. Send a new message after wake/rehydrate support lands.');
  }

  if (workspace.nodeStatus !== 'running') {
    throw errors.conflict(
      'The workspace node is no longer running. Start a new chat to create a fresh workspace.'
    );
  }

  // Find the running agent session on that workspace, scoped to the user
  // for defence-in-depth (uses idx_agent_sessions_ws_user_status composite index).
  const [agentSession] = await db
    .select({ id: schema.agentSessions.id })
    .from(schema.agentSessions)
    .where(
      and(
        eq(schema.agentSessions.workspaceId, workspace.id),
        eq(schema.agentSessions.userId, userId),
        eq(schema.agentSessions.status, 'running')
      )
    )
    .limit(1);

  if (!agentSession) {
    throw errors.notFound('No running agent session found');
  }

  return { workspace: { id: workspace.id, nodeId: workspace.nodeId }, agentSession };
}
