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
 * Every socket is tagged with the user the API route authenticated (`actor:<userId>`, from
 * `BROWSER_SOCKET_ACTOR_HEADER`, which the route overwrites so a browser cannot choose it). When
 * that user loses project access (offboarding, account suspension), the API closes their sockets
 * with `closeBrowserSocketsForActor`; the upgrade route refuses them a new one.
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
  CHAT_TOOL_REPLACE_CAPABILITY,
  toolMessageRevision,
} from '@simple-agent-manager/shared';
import { createModuleLogger } from '@simple-agent-manager/worker-core';

import { sealMessageStream } from './message-stream-ingest';
import { sealToolMerging } from './tool-call-changes';

const log = createModuleLogger('project_data.sockets');

const SESSION_TAG_PREFIX = 'session:';
const ACTOR_TAG_PREFIX = 'actor:';
/** Hibernation tags are capped at 256 characters; user ids are far shorter. */
const MAX_ACTOR_ID_LENGTH = 200;
/** Set by the authenticated API route on the forwarded upgrade; never taken from the browser. */
export const BROWSER_SOCKET_ACTOR_HEADER = 'x-sam-browser-socket-actor';
/** Close code for a socket whose user lost access to the project. */
export const BROWSER_SOCKET_ACCESS_REVOKED_CLOSE_CODE = 4403;
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

function actorTag(actorId: string): string {
  return `${ACTOR_TAG_PREFIX}${actorId}`;
}

/** Printable ASCII only, so the tag's byte length equals its character length. */
const ACTOR_ID_PATTERN = new RegExp(`^[\\x21-\\x7e]{1,${MAX_ACTOR_ID_LENGTH}}$`);

function isValidActorId(actorId: string | null): actorId is string {
  return !!actorId && ACTOR_ID_PATTERN.test(actorId);
}

/** Accept a browser socket upgrade forwarded by the API route. */
export function admitBrowserSocket(
  ctx: DurableObjectState,
  sql: SqlStorage,
  url: URL,
  actorId: string | null,
  onToolSeal?: () => void,
  onAdmitted?: (ws: WebSocket, actorId: string) => void
): Response {
  // Without the authenticated user the socket could not be closed when their access ends.
  if (!isValidActorId(actorId)) {
    log.warn('websocket.admission_rejected_no_actor', {
      hasActor: actorId !== null,
      action: 'rejected',
    });
    return new Response('Socket actor is required', { status: 400 });
  }
  const requested = url.searchParams.get('sessionId');
  const tags: string[] = [actorTag(actorId)];
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
  if (url.searchParams.get('toolReplace') === CHAT_TOOL_REPLACE_CAPABILITY)
    tags.push(CHAT_TOOL_REPLACE_CAPABILITY);
  else if (sessionId) {
    const row = sql
      .exec('SELECT stream_ingest_state FROM chat_sessions WHERE id = ?', sessionId)
      .toArray()[0];
    if (
      typeof row?.stream_ingest_state === 'string' &&
      Number(JSON.parse(row.stream_ingest_state).toolRevision ?? 0) > 0 &&
      sealToolMerging(sql, sessionId)
    )
      onToolSeal?.();
  }
  const pair = new WebSocketPair();
  pair[1].serializeAttachment({ accessPending: true });
  ctx.acceptWebSocket(pair[1], tags);
  onAdmitted?.(pair[1], actorId);
  return new Response(null, { status: 101, webSocket: pair[0] });
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
    // Attachments survive hibernation. Legacy sockets have no admission attachment;
    // they retain their existing behavior and are still closed by actor revocation.
    const attachment: unknown = ws.deserializeAttachment();
    if (
      attachment !== null &&
      typeof attachment === 'object' &&
      'accessPending' in attachment &&
      attachment.accessPending === true
    )
      return;
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(message);
  } catch {
    /* closed */
  }
}

/**
 * Close every socket the given user opened on this project, plus any open socket that carries no
 * actor tag. An untagged socket was admitted before sockets were attributed to users, so it cannot
 * be shown not to belong to the revoked user; its client reconnects through the upgrade route,
 * which re-checks membership. Returns how many open sockets were closed.
 */
export function closeBrowserSocketsForActor(ctx: DurableObjectState, actorId: string): number {
  if (!isValidActorId(actorId)) throw new Error('A valid actor id is required to close sockets');
  const targets = new Set(ctx.getWebSockets(actorTag(actorId)));
  for (const ws of ctx.getWebSockets()) {
    const tags = tagsOf(ctx, ws);
    if (tags && !tags.some((tag) => tag.startsWith(ACTOR_TAG_PREFIX))) targets.add(ws);
  }
  let closed = 0;
  for (const ws of targets) {
    if (ws.readyState === WebSocket.OPEN) closed++;
    closeQuietly(ws, BROWSER_SOCKET_ACCESS_REVOKED_CLOSE_CODE, 'project access revoked');
  }
  return closed;
}

/** Access the upgrade route checked: an active membership on an account that is not suspended. */
const ACTIVE_PROJECT_ACCESS_SQL = `SELECT 1 AS ok FROM project_members pm
  JOIN users u ON u.id = pm.user_id
  WHERE pm.project_id = ? AND pm.user_id = ? AND pm.status = 'active' AND u.status <> 'suspended'
  LIMIT 1`;

/**
 * Re-check a socket's access after it was accepted. The upgrade route checks membership before
 * forwarding, so a revocation that commits and closes the user's sockets between that check and
 * this admission would find nothing to close. Reading after acceptance covers both orders: a close
 * that runs later finds the socket, and a close that ran earlier committed its D1 write first, so
 * this read sees it. The socket is visible to revocation throughout, but its persisted pending
 * attachment prevents broadcasts until the read confirms access. A failed read closes with a
 * retryable outcome. One D1 read per socket opened, never per frame.
 */
export async function closeIfAccessRevoked(
  db: D1Database,
  projectId: string,
  actorId: string,
  ws: WebSocket
): Promise<void> {
  try {
    const row = await db.prepare(ACTIVE_PROJECT_ACCESS_SQL).bind(projectId, actorId).first();
    if (row) {
      // No await between this check and promotion: a concurrent revocation close wins.
      if (ws.readyState === WebSocket.OPEN) ws.serializeAttachment({ accessPending: false });
      return;
    }
    log.warn('websocket.admitted_after_revocation', { projectId, actorId, action: 'closed' });
    closeQuietly(ws, BROWSER_SOCKET_ACCESS_REVOKED_CLOSE_CODE, 'project access revoked');
  } catch (err) {
    log.warn('websocket.admission_recheck_failed', {
      projectId,
      actorId,
      error: err instanceof Error ? err.message : String(err),
      action: 'closed_retryable',
    });
    closeQuietly(ws, 1013, 'access verification unavailable');
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
  type: string,
  payload: Record<string, unknown>,
  sessionId?: string
): void {
  const message = JSON.stringify({ type, payload });
  const replacesTool =
    type === 'messages.batch' &&
    Array.isArray(payload.messages) &&
    payload.messages.some(
      (row: unknown) =>
        row !== null &&
        typeof row === 'object' &&
        toolMessageRevision((row as Record<string, unknown>).toolMetadata) > 1
    );
  if (!sessionId) {
    for (const ws of ctx.getWebSockets()) send(ws, message);
    return;
  }
  for (const ws of ctx.getWebSockets(sessionTag(sessionId))) {
    const tags = tagsOf(ctx, ws);
    if (!tags) continue;
    if (
      (type === MESSAGE_APPEND_FRAME && !tags.includes(CHAT_MESSAGE_APPEND_CAPABILITY)) ||
      (replacesTool && !tags.includes(CHAT_TOOL_REPLACE_CAPABILITY))
    )
      closeForResync(ws, sessionId);
    else send(ws, message);
  }
  if (TRANSCRIPT_FRAME_TYPES.has(type)) return;
  for (const ws of ctx.getWebSockets()) {
    const tags = tagsOf(ctx, ws);
    if (!tags || tags.some((tag) => tag.startsWith(SESSION_TAG_PREFIX))) continue;
    send(ws, message);
  }
}

/** A legacy reader permanently seals tool mutation, even after its socket disconnects. */
export function countLegacyToolSockets(ctx: DurableObjectState, sessionId: string): boolean {
  return ctx
    .getWebSockets(sessionTag(sessionId))
    .some(
      (socket) =>
        socket.readyState === WebSocket.OPEN &&
        !tagsOf(ctx, socket)?.includes(CHAT_TOOL_REPLACE_CAPABILITY)
    );
}
