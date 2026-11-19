/**
 * Shared session access ("Share chat access").
 *
 * A chat session's owner is the user who created it (`chat_sessions.created_by_user_id`).
 * The owner — or anyone the owner has shared the session with — can grant another active
 * project member owner-equivalent control of that ONE session. Everything the grantee asks
 * the agent to do still runs on the owner's agent credentials, GitHub identity and compute.
 * A grant lasts for a chosen 5, 10, 30 or 60 minutes. It ends then, or earlier if it is revoked,
 * the grantee or the owner leaves the project, or the session itself ends. Only the owner can
 * renew it; ending access cannot undo what was already done with it.
 *
 * Grants live in the project's ProjectData Durable Object beside the session they belong to
 * (`chat_session_access_grants`), so the authorization check reads them in the same RPC that
 * reads the session.
 */

import type { ChatSessionStatus } from './session';

/**
 * Chat states that can still take another message, and so can be shared. A sleeping chat is a
 * live conversation that wakes on its next message (Instant chats sleep within minutes of going
 * idle); only a stopped or failed chat has ended. An allowlist, so a new status has to be placed
 * deliberately (.claude/rules/79).
 */
export const SHAREABLE_CHAT_SESSION_STATUSES: readonly ChatSessionStatus[] = ['active', 'sleeping'];

export function isShareableChatSessionStatus(status: string | null | undefined): boolean {
  return (SHAREABLE_CHAT_SESSION_STATUSES as readonly string[]).includes(status ?? '');
}

/**
 * How long a share lasts, in minutes. Sharing requires choosing one; there is no default and no
 * unlimited option (Raphaël, 2026-10-19). Access ends at the chosen time unless the owner renews
 * it, and is enforced against server time on every request and at prompt delivery.
 */
export const SESSION_ACCESS_DURATION_MINUTES = [5, 10, 30, 60] as const;
export type SessionAccessDurationMinutes = (typeof SESSION_ACCESS_DURATION_MINUTES)[number];

export function isSessionAccessDurationMinutes(
  value: unknown
): value is SessionAccessDurationMinutes {
  return (SESSION_ACCESS_DURATION_MINUTES as readonly unknown[]).includes(value);
}

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
  /** When access ends (epoch ms). A grant passed on never outlasts the grant it came from. */
  expiresAt: number;
  /** The duration chosen when the grant was created or last renewed. */
  durationMinutes: number;
}

/** Why a teammate's queued message never reached the agent. */
export type SessionUndeliveredReason = 'sender_access_revoked' | 'sender_access_expired';

/** A transcript message cancelled before delivery because its sender's access ended. */
export interface SessionUndeliveredPrompt {
  messageId: string;
  reason: SessionUndeliveredReason;
}

export interface SessionAccessSummary {
  sessionId: string;
  viewerAccess: SessionViewerAccess;
  owner: SessionAccessPerson | null;
  /** Active (unexpired, unrevoked) grants only. */
  grants: SessionAccessGrant[];
  /**
   * Messages cancelled before delivery because their sender's access ended, newest first. The
   * transcript row also carries this, but a client that cached the row earlier would not
   * re-read it; this list arrives with every access read so the label still appears.
   */
  undelivered?: SessionUndeliveredPrompt[];
  /** Server clock when this summary was built, so clients can show remaining time without skew. */
  serverTime: number;
}

export interface CreateSessionAccessGrantRequest {
  userId: string;
  /** Required. Renewing someone who already has access sets a new end time from now. */
  durationMinutes: SessionAccessDurationMinutes;
  /**
   * The person sharing must confirm that the grantee's requests run on the owner's
   * credentials and that the agent may be able to reveal them. Enforced server-side.
   */
  acknowledgeSharedCredentials: true;
}

export interface CreateSessionAccessGrantResponse {
  grant: SessionAccessGrant;
  /** True when the person had no active access before this call. */
  created: boolean;
  /** True when the owner renewed access the person already had (a new end time from now). */
  renewed: boolean;
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
    reason: 'granted' | 'renewed' | 'revoked' | 'expired';
  };
}
