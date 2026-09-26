/**
 * Query-parameter parsing shared by the chat session message routes: page
 * size, exact `before`/`after` cursors, role filter, compact mode, and order.
 */
import {
  DEFAULT_CHAT_SESSION_MESSAGE_LIMIT,
  DEFAULT_CHAT_SESSION_MESSAGE_MAX,
  type MessageCursor,
  parseMessageCursor,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { errors } from '../middleware/error';

/**
 * Resolve the effective message limit for a chat session REST response.
 *
 * Two distinct knobs (see `.claude/rules/03-constitution.md` Principle XI):
 * - `CHAT_SESSION_MESSAGE_LIMIT` — the page size used when no explicit limit is
 *   requested (the 3s poll and load-more pagination). Kept small so polling does
 *   not re-fetch the whole conversation every cycle.
 * - `CHAT_SESSION_MESSAGE_MAX` — the ceiling any request is clamped to. The
 *   client's initial load explicitly requests this so the full conversation
 *   arrives in one request. The 30 MiB RPC size guard in `getMessages()` is the
 *   ultimate cap; oversized sessions keep `hasMore=true` and paginate.
 */
export function getSessionMessageLimit(env: Env, requestedLimit?: string): number {
  const configuredDefault = Number.parseInt(env.CHAT_SESSION_MESSAGE_LIMIT || '', 10);
  const defaultLimit =
    Number.isFinite(configuredDefault) && configuredDefault > 0
      ? configuredDefault
      : DEFAULT_CHAT_SESSION_MESSAGE_LIMIT;
  const configuredMax = Number.parseInt(env.CHAT_SESSION_MESSAGE_MAX || '', 10);
  const maxLimit =
    Number.isFinite(configuredMax) && configuredMax > 0
      ? configuredMax
      : DEFAULT_CHAT_SESSION_MESSAGE_MAX;
  // Guard against misconfiguration where the default page size exceeds the max.
  // We promote the ceiling to the page size so the default page always fits, but
  // this silently overrides an operator's intended (smaller) ceiling — warn so it
  // is visible in `wrangler tail`.
  if (maxLimit < defaultLimit) {
    log.warn('chat.session_message_limit_misconfigured', {
      defaultLimit,
      maxLimit,
      effectiveMax: defaultLimit,
    });
  }
  const effectiveMax = Math.max(defaultLimit, maxLimit);
  const parsedLimit = Number.parseInt(requestedLimit || '', 10);
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : defaultLimit;
  return Math.min(limit, effectiveMax);
}

export function getMessageCursor(name: 'before' | 'after', raw?: string): MessageCursor | null {
  if (!raw) return null;
  const cursor = parseMessageCursor(raw);
  if (cursor === null) {
    throw errors.badRequest(`${name} must be a timestamp or a [createdAt,sequence,id] cursor`);
  }
  return cursor;
}

export function getRequestedRoles(rawRoles?: string): string[] | undefined {
  const roles = rawRoles
    ?.split(',')
    .map((role) => role.trim())
    .filter(Boolean);
  return roles && roles.length > 0 ? roles : undefined;
}

export function getCompactMode(rawCompact: string | undefined, defaultValue: boolean): boolean {
  if (!rawCompact) return defaultValue;
  const compact = rawCompact.trim().toLowerCase();
  if (compact === 'true' || compact === '1') return true;
  if (compact === 'false' || compact === '0') return false;
  throw errors.badRequest('compact must be true or false');
}

/**
 * A page bounded only by `after` reads forward, so a caller can drain every
 * newer message page by page. Reading it newest-first would return the newest
 * rows and silently skip whatever lies between the cursor and them.
 */
export function getMessageOrder(
  rawOrder: string | undefined,
  bounds: { before: MessageCursor | null; after: MessageCursor | null }
): 'asc' | 'desc' {
  if (!rawOrder) return bounds.after !== null && bounds.before === null ? 'asc' : 'desc';
  const order = rawOrder.trim().toLowerCase();
  if (order === 'asc' || order === 'desc') return order;
  throw errors.badRequest('order must be asc or desc');
}
