/**
 * Browser WebSockets on the ProjectData Durable Object (`GET /api/projects/:id/sessions/ws`).
 *
 * Two kinds of socket connect here:
 * - session sockets (`?sessionId=`), opened by the chat view, which render one transcript;
 * - project sockets (no `sessionId`), opened by the session list, which use lifecycle,
 *   attention, comment and access events only.
 *
 * A socket advertises `message-append-v1` when it can apply `message.append`. Clients built
 * before chunk merging (#2760) do not, and they stay connected until the tab reloads.
 *
 * Contract kept here:
 * - Transcript frames go only to sockets subscribed to that session. No project-socket consumer
 *   has ever read them (`useProjectWebSocket` since its creation), so a project socket without the
 *   capability cannot miss text and must not switch merging off.
 * - A session socket without the capability switches merging off for its own session only.
 * - `message.append` is filtered by capability when it is sent, not only when the batch starts:
 *   a legacy session socket can be admitted while a merged batch awaits its side effects.
 */
import {
  CHAT_MESSAGE_APPEND_CAPABILITY,
  CHAT_MESSAGE_RESYNC_CLOSE_CODE,
} from '@simple-agent-manager/shared';
import { createModuleLogger } from '@simple-agent-manager/worker-core';

import {
  BROWSER_SOCKET_ACTOR_ID_HEADER,
  BROWSER_SOCKET_EXPIRES_AT_HEADER,
  BROWSER_SOCKET_READ_CAPABILITY,
  BROWSER_SOCKET_UNAUTHORIZED_CLOSE_CODE,
} from '../browser-socket-auth';
import { sealMessageStream } from './message-stream-ingest';

const log = createModuleLogger('project_data.sockets');

const SESSION_TAG_PREFIX = 'session:';
const SESSION_ID_PATTERN = /^[0-9a-f-]{36}$/i;
/** Frames that carry transcript rows; sent only to sockets subscribed to the session. */
const TRANSCRIPT_FRAME_TYPES: ReadonlySet<string> = new Set([
  'message.new',
  'messages.batch',
  'message.append',
]);
const MESSAGE_APPEND_FRAME = 'message.append';

function sessionTag(sessionId: string): string {
  return `${SESSION_TAG_PREFIX}${sessionId}`;
}

export interface BrowserSocketAuthorization {
  version: 1;
  actorId: string;
  projectId: string;
  sessionId: string | null;
  capability: typeof BROWSER_SOCKET_READ_CAPABILITY;
  expiresAt: number;
}

function readAuthorization(ws: WebSocket): BrowserSocketAuthorization | null {
  try {
    const value: unknown = ws.deserializeAttachment();
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const actorId = record.actorId;
    const projectId = record.projectId;
    const sessionId = record.sessionId;
    const expiresAt = record.expiresAt;
    if (
      record.version !== 1 ||
      typeof actorId !== 'string' ||
      !actorId ||
      typeof projectId !== 'string' ||
      !projectId ||
      (sessionId !== null && (typeof sessionId !== 'string' || !sessionId)) ||
      record.capability !== BROWSER_SOCKET_READ_CAPABILITY ||
      typeof expiresAt !== 'number' ||
      !Number.isFinite(expiresAt)
    ) {
      return null;
    }
    return {
      version: 1,
      actorId,
      projectId,
      sessionId,
      capability: BROWSER_SOCKET_READ_CAPABILITY,
      expiresAt,
    };
  } catch {
    return null;
  }
}

function authorizationMatchesSocket(
  ctx: DurableObjectState,
  ws: WebSocket,
  projectId: string,
  now = Date.now()
): BrowserSocketAuthorization | null {
  const authorization = readAuthorization(ws);
  if (
    !authorization ||
    authorization.projectId !== projectId ||
    authorization.expiresAt <= now
  ) {
    return null;
  }
  const tags = tagsOf(ctx, ws);
  if (!tags) return null;
  const taggedSession = tags.find((tag) => tag.startsWith(SESSION_TAG_PREFIX)) ?? null;
  const expectedSession = authorization.sessionId
    ? sessionTag(authorization.sessionId)
    : null;
  return taggedSession === expectedSession ? authorization : null;
}

function closeUnauthorized(ws: WebSocket): void {
  closeQuietly(ws, BROWSER_SOCKET_UNAUTHORIZED_CLOSE_CODE, 'authorization expired');
}

/** Accept a browser socket upgrade forwarded by the API route. */
export function admitBrowserSocket(
  ctx: DurableObjectState,
  sql: SqlStorage,
  request: Request,
  projectId: string
): Response {
  const actorId = request.headers.get(BROWSER_SOCKET_ACTOR_ID_HEADER)?.trim();
  const expiresAt = Number(request.headers.get(BROWSER_SOCKET_EXPIRES_AT_HEADER));
  if (!actorId || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    log.warn('websocket.authorization_rejected', {
      projectId,
      hasActorId: Boolean(actorId),
      hasValidExpiry: Number.isFinite(expiresAt) && expiresAt > Date.now(),
      action: 'rejected',
    });
    return new Response('WebSocket authorization is missing or expired', { status: 403 });
  }

  const url = new URL(request.url);
  const requested = url.searchParams.get('sessionId');
  const tags: string[] = [];
  // Session IDs are stored lowercase; an uppercase spelling must still match the
  // broadcast tag and the merge gate, or the socket would be invisible to both.
  const sessionId = requested ? requested.toLowerCase() : null;
  if (sessionId) {
    if (!SESSION_ID_PATTERN.test(sessionId))
      return new Response('Invalid sessionId format', { status: 400 });
    tags.push(sessionTag(sessionId));
  }
  if (url.searchParams.get('messageAppend') === CHAT_MESSAGE_APPEND_CAPABILITY) {
    tags.push(CHAT_MESSAGE_APPEND_CAPABILITY);
  } else if (sessionId) {
    // This client may already hold the open row and cannot apply appends to it.
    sealMessageStream(sql, sessionId);
  }
  const pair = new WebSocketPair();
  ctx.acceptWebSocket(pair[1], tags);
  pair[1].serializeAttachment({
    version: 1,
    actorId,
    projectId,
    sessionId,
    capability: BROWSER_SOCKET_READ_CAPABILITY,
    expiresAt,
  } satisfies BrowserSocketAuthorization);
  return new Response(null, { status: 101, webSocket: pair[0] });
}

/** Current D1 authority for a socket heartbeat. Failure is handled fail-closed by the caller. */
export async function hasCurrentBrowserSocketAuthority(
  database: D1Database,
  authorization: BrowserSocketAuthorization
): Promise<boolean> {
  if (authorization.expiresAt <= Date.now()) return false;
  const row = await database
    .prepare(
      `SELECT 1 AS authorized
       FROM project_members pm
       JOIN users u ON u.id = pm.user_id
       WHERE pm.project_id = ? AND pm.user_id = ? AND pm.status = 'active'
         AND (u.status IS NULL OR u.status != 'suspended')
       LIMIT 1`
    )
    .bind(authorization.projectId, authorization.actorId)
    .first<{ authorized: number }>();
  return row?.authorized === 1;
}

/** Validate the socket's immutable attachment and its session tag before handling a frame. */
export function getBrowserSocketAuthorization(
  ctx: DurableObjectState,
  ws: WebSocket,
  projectId: string
): BrowserSocketAuthorization | null {
  return authorizationMatchesSocket(ctx, ws, projectId);
}

/** Close every socket for a member whose project authority was revoked. */
export function revokeBrowserSocketsForActor(
  ctx: DurableObjectState,
  projectId: string,
  actorId: string
): number {
  let closed = 0;
  for (const ws of ctx.getWebSockets()) {
    const authorization = readAuthorization(ws);
    // Sockets admitted before actor binding shipped cannot be attributed safely.
    if (
      !authorization ||
      authorization.projectId !== projectId ||
      authorization.actorId === actorId
    ) {
      closeUnauthorized(ws);
      closed++;
    }
  }
  return closed;
}

/**
 * Open sockets without the `message.append` capability, for one session's ingest. `session`
 * counts those subscribed to the session: they gate merging for it. `project` counts unscoped
 * ones: they never receive transcript frames, so they are reported for diagnostics only. A socket
 * the server already closed (for example after a resync) stays listed while its close handshake is
 * pending; it receives nothing more, so it is not counted.
 */
export function countLegacySockets(
  ctx: DurableObjectState,
  sessionId: string
): { session: number; project: number } {
  const own = sessionTag(sessionId);
  let session = 0;
  let project = 0;
  for (const ws of ctx.getWebSockets()) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    const tags = tagsOf(ctx, ws);
    // A socket whose tags cannot be read cannot be attributed to a session (it is almost
    // certainly gone), so it is not counted for either scope.
    if (!tags || tags.includes(CHAT_MESSAGE_APPEND_CAPABILITY)) continue;
    const tag = tags.find((t) => t.startsWith(SESSION_TAG_PREFIX));
    if (!tag) project++;
    else if (tag === own) session++;
  }
  return { session, project };
}

function send(ws: WebSocket, message: string): void {
  try {
    ws.send(message);
  } catch {
    /* closed */
  }
}

/** Close a socket that may already be closing (server-initiated resync, or the peer's close). */
export function closeQuietly(ws: WebSocket, code?: number, reason?: string): void {
  try {
    ws.close(code, reason);
  } catch {
    /* already closed */
  }
}

function tagsOf(ctx: DurableObjectState, ws: WebSocket): string[] | null {
  try {
    return ctx.getTags(ws);
  } catch {
    return null;
  }
}

/**
 * The socket cannot apply this append, and its client has no frame that updates a row it
 * already holds. Every chat client reconnects on a non-1000 close and re-reads the newest
 * messages, which now include the committed append, and its re-admission seals the session.
 */
function closeForResync(ws: WebSocket, sessionId: string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  log.info('websocket.legacy_append_resync', { sessionId, action: 'closed_for_resync' });
  closeQuietly(ws, CHAT_MESSAGE_RESYNC_CLOSE_CODE, 'message append resync');
}

/**
 * Never throws: it runs after a batch has committed, and an exception here would skip the
 * remaining frames for every other socket.
 */
export function broadcastToBrowserSockets(
  ctx: DurableObjectState,
  projectId: string,
  type: string,
  payload: Record<string, unknown>,
  sessionId?: string
): void {
  const message = JSON.stringify({ type, payload });
  if (!sessionId) {
    for (const ws of ctx.getWebSockets()) {
      if (!authorizationMatchesSocket(ctx, ws, projectId)) closeUnauthorized(ws);
      else send(ws, message);
    }
    return;
  }
  for (const ws of ctx.getWebSockets(sessionTag(sessionId))) {
    if (!authorizationMatchesSocket(ctx, ws, projectId)) {
      closeUnauthorized(ws);
      continue;
    }
    const tags = tagsOf(ctx, ws);
    if (!tags) continue;
    if (type === MESSAGE_APPEND_FRAME && !tags.includes(CHAT_MESSAGE_APPEND_CAPABILITY))
      closeForResync(ws, sessionId);
    else send(ws, message);
  }
  if (TRANSCRIPT_FRAME_TYPES.has(type)) return;
  for (const ws of ctx.getWebSockets()) {
    if (!authorizationMatchesSocket(ctx, ws, projectId)) {
      closeUnauthorized(ws);
      continue;
    }
    const tags = tagsOf(ctx, ws);
    if (!tags || tags.some((tag) => tag.startsWith(SESSION_TAG_PREFIX))) continue;
    send(ws, message);
  }
}
