import type { SessionViewerAccess } from '@simple-agent-manager/shared';

import type { ChatSessionResponse } from '../../lib/api';

/**
 * What the current viewer may do in one project chat session. The server decides this
 * (`viewerAccess` on session detail) and enforces it on every route; the UI only mirrors it.
 *
 * - `owner`   — created the session.
 * - `grantee` — the owner shared the session with them: owner-equivalent control of this
 *               session, running on the owner's accounts.
 * - `reader`  — any other project member: read, comment and @mention; never drives the agent.
 */
export interface SessionViewerCapabilities {
  viewerAccess: SessionViewerAccess;
  /** Prompt, interrupt, answer the agent, sleep, archive. Owner and grantees. */
  canDriveSession: boolean;
  /** Start comment threads and reply. Every project member who can see the session. */
  canComment: boolean;
  /** Press "Send to agent" on a comment. Owner and grantees, like any other prompt. */
  canSendToAgent: boolean;
  /** Share the session or remove someone's access. Owner and grantees. */
  canManageAccess: boolean;
  /** Fork an archived chat: it restores the owner's saved files, so owner only. */
  canFork: boolean;
  /**
   * The Files and Git panels. Owner and grantees; a grantee's reads are limited to the
   * repository folder by the server and the workspace agent.
   */
  canBrowseWorkspace: boolean;
  isGrantee: boolean;
}

/**
 * `viewerAccess` is absent on list items and on detail responses cached before shared
 * sessions shipped. Fall back to the old ownership flag, and fail closed: an unknown viewer
 * is a reader until the server says otherwise.
 */
export function resolveSessionViewerAccess(
  session: Pick<ChatSessionResponse, 'viewerAccess' | 'isMine'> | null | undefined
): SessionViewerAccess {
  if (session?.viewerAccess) return session.viewerAccess;
  return session?.isMine === true ? 'owner' : 'reader';
}

export function resolveSessionViewerCapabilities(
  session: Pick<ChatSessionResponse, 'viewerAccess' | 'isMine'> | null | undefined
): SessionViewerCapabilities {
  const viewerAccess = resolveSessionViewerAccess(session);
  const canDriveSession = viewerAccess === 'owner' || viewerAccess === 'grantee';
  return {
    viewerAccess,
    canDriveSession,
    canComment: Boolean(session),
    canSendToAgent: canDriveSession,
    canManageAccess: canDriveSession,
    canFork: viewerAccess === 'owner',
    canBrowseWorkspace: canDriveSession,
    isGrantee: viewerAccess === 'grantee',
  };
}

/**
 * The session's workspace id when the viewer owns the session, else null. Workspace routes
 * answer only the workspace's owner, so a teammate's page would fetch, 404 and retry.
 */
export function ownedWorkspaceId(
  session: Pick<ChatSessionResponse, 'viewerAccess' | 'isMine' | 'workspaceId'> | null | undefined
): string | null {
  if (resolveSessionViewerAccess(session) !== 'owner') return null;
  return session?.workspaceId ?? null;
}

/** "Prakash" for a session someone else owns; used in banners and read-only copy. */
export function sessionOwnerLabel(session: ChatSessionResponse | null | undefined): string {
  const owner = session?.access?.owner;
  const name = owner?.name ?? session?.createdBy?.name ?? null;
  if (name?.trim()) return name.trim();
  const email = session?.createdBy?.email;
  if (email) return email.split('@')[0] ?? 'the creator';
  return 'the creator';
}
