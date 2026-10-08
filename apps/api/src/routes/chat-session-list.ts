/**
 * `GET /api/projects/:projectId/sessions` — the project chat sidebar's session list.
 *
 * Split out of `chat.ts` (rule 18) because the D1-index fast path and its
 * fallback are a self-contained concern with their own failure semantics, and
 * `chat.ts` had reached the 800-line ceiling.
 *
 * The sidebar reloads this list on mount, on every WebSocket reconnect, on two
 * poll timers and on six event-driven refetches, so it is one of the hottest
 * ProjectData DO callers in the product. It is served from the D1
 * `session_summaries` index whenever that index can prove it holds the same
 * answer the DO would give, and from the DO otherwise.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { Context, Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { D1_MAX_BOUND_PARAMETERS } from '../lib/d1-limits';
import { log } from '../lib/logger';
import { parsePositiveInt, requireRouteParam } from '../lib/route-helpers';
import { getUserId } from '../middleware/auth';
import { requireProjectAccess } from '../middleware/project-auth';
import * as projectDataService from '../services/project-data';
import { listSessionsFromIndex } from '../services/session-summary-index';
import { enrichSessionsWithCreators, getSessionListScope } from './chat-session-ownership';

/**
 * Kick off a D1 session-index refresh without blocking the response.
 *
 * Entirely best-effort: the caller already has an authoritative answer from the
 * Durable Object, and this only makes the NEXT read faster. So every failure
 * mode here is swallowed — including the absence of an `ExecutionContext`, which
 * Hono throws on rather than returning undefined. A stale index must never be
 * able to turn a working session list into a 500.
 */
function schedulePrimeSessionIndex(c: Context<{ Bindings: Env }>, projectId: string): void {
  try {
    const prime = projectDataService.primeSessionIndex(c.env, projectId).catch((err) => {
      log.warn('session_index_prime_failed', {
        projectId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // `c.executionCtx` THROWS when no ExecutionContext is present rather than
    // returning undefined, so it needs the same guard as everything else here.
    c.executionCtx.waitUntil(prime);
  } catch (err) {
    // Covers a missing ExecutionContext and any synchronous throw from
    // resolving the stub. The promise, if one was created, is already
    // self-catching; it simply is not kept alive past the response.
    log.warn('session_index_prime_skipped', {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Task outcomes follow the returned sessions, independent of the recent-task page. */
async function enrichTaskOutcomes(
  db: ReturnType<typeof drizzle<typeof schema>>,
  projectId: string,
  sessions: Array<Record<string, unknown>>
): Promise<Array<Record<string, unknown>>> {
  const ids = sessions
    .map((session) => session.id)
    .filter((id): id is string => typeof id === 'string');
  const bySession = new Map<
    string,
    { id: string; status: string; terminalReason: string | null }
  >();
  const chunkSize = D1_MAX_BOUND_PARAMETERS - 1; // project scope uses one bind.
  for (let offset = 0; offset < ids.length; offset += chunkSize) {
    const rows = await db
      .select({
        id: schema.tasks.id,
        chatSessionId: schema.tasks.chatSessionId,
        status: schema.tasks.status,
        terminalReason: schema.tasks.terminalReason,
      })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.projectId, projectId),
          inArray(schema.tasks.chatSessionId, ids.slice(offset, offset + chunkSize))
        )
      );
    for (const { chatSessionId, ...task } of rows) {
      if (chatSessionId) bySession.set(chatSessionId, task);
    }
  }
  return sessions.map((session) => {
    const task = bySession.get(String(session.id));
    return task ? { ...session, task } : session;
  });
}

/** Register `GET /` (the session list) on the chat router. */
export function registerChatSessionListRoute(chatRoutes: Hono<{ Bindings: Env }>): void {
  chatRoutes.get('/', async (c) => {
    const userId = getUserId(c);
    const projectId = requireRouteParam(c, 'projectId');
    const db = drizzle(c.env.DATABASE, { schema });

    await requireProjectAccess(db, projectId, userId);

    const status = c.req.query('status') || null;
    const limit = Math.min(parsePositiveInt(c.req.query('limit'), 20), 100);
    const offset = parsePositiveInt(c.req.query('offset'), 0);
    const scope = getSessionListScope(c.req.query('scope'));
    const createdByUserId = scope === 'my' ? userId : null;

    // Fast path: serve from the D1 session index when it can prove it holds the
    // same answer the DO would give. Each DO call wakes a single-threaded object
    // and runs an N+1 attention lookup per row inside it; D1 reads scale out
    // instead. (Note this is not a round-trip *reduction* — the DO's count/page
    // are in-process SQLite, so the win is avoiding the DO wake, the N+1, and
    // the contention, not hop count.)
    //
    // `listSessionsFromIndex` fails closed: anything absent, incomplete or stale
    // falls through to the DO below.
    const indexRead = await listSessionsFromIndex(c.env, {
      projectId,
      status,
      limit,
      offset,
      createdByUserId,
    });

    let result;
    if ('result' in indexRead) {
      result = indexRead.result;
    } else {
      result = await projectDataService.listSessions(
        c.env,
        projectId,
        status,
        limit,
        offset,
        null,
        createdByUserId
      );
      // Re-prime off the response path, and ONLY here — this is the one caller
      // that actually observed the index fail. A permanently over-cap project is
      // excluded because its sync short-circuits, so this cannot become a
      // per-request resync loop for large projects.
      if (indexRead.missReason !== 'incomplete_coverage') {
        schedulePrimeSessionIndex(c, projectId);
      }
    }

    return c.json({
      ...result,
      sessions: await enrichSessionsWithCreators(
        db,
        await enrichTaskOutcomes(db, projectId, result.sessions),
        userId
      ),
    });
  });
}
