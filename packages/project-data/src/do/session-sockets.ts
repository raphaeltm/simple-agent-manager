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

/** Accept a browser socket upgrade forwarded by the API route. */
export function admitBrowserSocket(ctx: DurableObjectState, sql: SqlStorage, url: URL): Response {
  const sessionId = url.searchParams.get('sessionId');
  const tags: string[] = [];
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
  return new Response(null, { status: 101, webSocket: pair[0] });
}

/** Whether a socket subscribed to this session cannot apply `message.append`. */
export function hasLegacySessionSocket(ctx: DurableObjectState, sessionId: string): boolean {
  return ctx
    .getWebSockets(sessionTag(sessionId))
    .some((ws) => !ctx.getTags(ws).includes(CHAT_MESSAGE_APPEND_CAPABILITY));
}

function send(ws: WebSocket, message: string): void {
  try {
    ws.send(message);
  } catch {
    /* closed */
  }
}

/**
 * The socket cannot apply this append, and its client has no frame that updates a row it
 * already holds. Every chat client reconnects on a non-1000 close and re-reads the newest
 * messages, which now include the committed append, and its re-admission seals the session.
 */
function closeForResync(ws: WebSocket, sessionId: string): void {
  log.info('websocket.legacy_append_resync', { sessionId, action: 'closed_for_resync' });
  try {
    ws.close(CHAT_MESSAGE_RESYNC_CLOSE_CODE, 'message append resync');
  } catch {
    /* already closing */
  }
}

export function broadcastToBrowserSockets(
  ctx: DurableObjectState,
  type: string,
  payload: Record<string, unknown>,
  sessionId?: string
): void {
  const message = JSON.stringify({ type, payload });
  if (!sessionId) {
    for (const ws of ctx.getWebSockets()) send(ws, message);
    return;
  }
  for (const ws of ctx.getWebSockets(sessionTag(sessionId))) {
    if (type === MESSAGE_APPEND_FRAME && !ctx.getTags(ws).includes(CHAT_MESSAGE_APPEND_CAPABILITY))
      closeForResync(ws, sessionId);
    else send(ws, message);
  }
  if (TRANSCRIPT_FRAME_TYPES.has(type)) return;
  for (const ws of ctx.getWebSockets()) {
    if (ctx.getTags(ws).some((tag) => tag.startsWith(SESSION_TAG_PREFIX))) continue;
    send(ws, message);
  }
}
