/**
 * Shared session access ("Share chat access").
 *
 * A chat session's owner is the user who created it (`chat_sessions.created_by_user_id`).
 * The owner — or anyone the owner has shared the session with — can grant another active
 * project member owner-equivalent control of that ONE session. Everything the grantee asks
 * the agent to do still runs on the owner's agent credentials, GitHub identity and compute.
 * A grant has no expiry: it lasts until it is revoked, the grantee or the owner leaves the
 * project, or the session itself ends.
 *
 * Grants live in the project's ProjectData Durable Object beside the session they belong to
 * (`chat_session_access_grants`), so the authorization check reads them in the same RPC that
 * reads the session.
 */

export const SESSION_VIEWER_ACCESS_LEVELS = ['owner', 'grantee', 'reader'] as const;
/**
 * What the requesting user may do in one session.
 * - `owner`   — created the session.
 * - `grantee` — holds an active grant: owner-equivalent control within this session.
 * - `reader`  — any other project member: read, comment, @mention; never drives the agent.
 */
export type SessionViewerAccess = (typeof SESSION_VIEWER_ACCESS_LEVELS)[number];

export const SESSION_ACCESS_REVOKE_REASONS = [
  /** A session writer removed the grant. */
  'revoked',
  /** The grantee removed their own access. */
  'left',
  /** Removed because the grant that authorized it was revoked. */
  'cascade',
  /** The grantee is no longer an active project member. */
  'member_removed',
  /** The session owner is no longer an active project member. */
  'owner_removed',
] as const;
export type SessionAccessRevokeReason = (typeof SESSION_ACCESS_REVOKE_REASONS)[number];

/** A person referenced by a grant. Names are server-snapshotted display labels, never auth input. */
export interface SessionAccessPerson {
  id: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface SessionAccessGrant {
  id: string;
  sessionId: string;
  grantee: SessionAccessPerson;
  grantedBy: SessionAccessPerson;
  /** The grant that authorized `grantedBy`, or null when the owner granted it directly. */
  parentGrantId: string | null;
  createdAt: number;
}

export interface SessionAccessSummary {
  sessionId: string;
  viewerAccess: SessionViewerAccess;
  owner: SessionAccessPerson | null;
  /** Active grants only. */
  grants: SessionAccessGrant[];
}

export interface CreateSessionAccessGrantRequest {
  userId: string;
  /**
   * The person sharing must confirm that the grantee's requests run on the owner's
   * credentials and that the agent may be able to reveal them. Enforced server-side.
   */
  acknowledgeSharedCredentials: true;
}

export interface CreateSessionAccessGrantResponse {
  grant: SessionAccessGrant;
  /** False when the grantee already had active access (idempotent re-grant). */
  created: boolean;
  access: SessionAccessSummary;
}

export interface RevokeSessionAccessGrantResponse {
  /** Grants revoked by this call: the target plus any downstream grants it had issued. */
  revokedGrantIds: string[];
  /** Queued prompt deliveries from the revoked people that were cancelled before reaching the agent. */
  cancelledDeliveryIds: string[];
  access: SessionAccessSummary;
}

/** ProjectData WebSocket event: grants for `sessionId` changed; clients refetch access. */
export interface SessionAccessChangedEvent {
  type: 'session.access.changed';
  payload: {
    sessionId: string;
    reason: 'granted' | 'revoked';
  };
}
