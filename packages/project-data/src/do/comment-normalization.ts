/**
 * Anchor-agnostic comment validation, limits, and column mapping.
 *
 * Shared by the message-anchored implementation (`comments.ts`) and the
 * library-file-anchored implementation (`library-file-comments.ts`) so the two
 * storage backends cannot drift on body/quote length limits, idempotency-key
 * handling, or actor normalization.
 */

import {
  DEFAULT_COMMENT_BODY_MAX_LENGTH,
  DEFAULT_COMMENT_IDEMPOTENCY_KEY_MAX_LENGTH,
  DEFAULT_COMMENT_LIST_LIMIT_DEFAULT,
  DEFAULT_COMMENT_LIST_LIMIT_MAX,
  DEFAULT_COMMENT_QUOTE_MAX_LENGTH,
  DEFAULT_COMMENT_REPLIES_PER_THREAD_MAX,
  DEFAULT_COMMENT_THREADS_PER_SESSION_MAX,
  DEFAULT_PROJECT_COMMENT_LIST_LIMIT,
  DEFAULT_PROJECT_COMMENT_LIST_MAX,
  DEFAULT_PROJECT_COMMENT_LIST_MAX_BYTES,
} from '@simple-agent-manager/shared';

import { type CommentActor, CommentValidationError } from './comment-contracts';
import type { Env } from './types';

export type CommentLimits = {
  bodyMaxLength: number;
  quoteMaxLength: number;
  idempotencyKeyMaxLength: number;
  listDefaultLimit: number;
  listMaxLimit: number;
  threadsPerSessionMax: number;
  repliesPerThreadMax: number;
};

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveCommentLimits(env: Env): CommentLimits {
  const listDefaultLimit = positiveInteger(
    env.COMMENT_LIST_LIMIT_DEFAULT,
    DEFAULT_COMMENT_LIST_LIMIT_DEFAULT
  );
  const listMaxLimit = positiveInteger(env.COMMENT_LIST_LIMIT_MAX, DEFAULT_COMMENT_LIST_LIMIT_MAX);
  return {
    bodyMaxLength: positiveInteger(env.COMMENT_BODY_MAX_LENGTH, DEFAULT_COMMENT_BODY_MAX_LENGTH),
    quoteMaxLength: positiveInteger(env.COMMENT_QUOTE_MAX_LENGTH, DEFAULT_COMMENT_QUOTE_MAX_LENGTH),
    idempotencyKeyMaxLength: positiveInteger(
      env.COMMENT_IDEMPOTENCY_KEY_MAX_LENGTH,
      DEFAULT_COMMENT_IDEMPOTENCY_KEY_MAX_LENGTH
    ),
    listDefaultLimit,
    listMaxLimit: Math.max(listDefaultLimit, listMaxLimit),
    threadsPerSessionMax: positiveInteger(
      env.COMMENT_THREADS_PER_SESSION_MAX,
      DEFAULT_COMMENT_THREADS_PER_SESSION_MAX
    ),
    repliesPerThreadMax: positiveInteger(
      env.COMMENT_REPLIES_PER_THREAD_MAX,
      DEFAULT_COMMENT_REPLIES_PER_THREAD_MAX
    ),
  };
}

export function resolveCommentListLimit(env: Env, requested?: number | null): number {
  const limits = resolveCommentLimits(env);
  const limit =
    typeof requested === 'number' && Number.isFinite(requested) && requested > 0
      ? Math.floor(requested)
      : limits.listDefaultLimit;
  return Math.min(limit, limits.listMaxLimit);
}

/**
 * Row budget for the project-wide comment inbox.
 *
 * Separate from `resolveCommentListLimit` because it bounds a different thing:
 * that one caps threads within a single conversation or file, this one caps a
 * cross-source triage page and therefore also bounds the Durable Object RPC
 * payload (threads are hydrated with their replies, from two tables at once).
 *
 * Clamped here, at the Durable Object boundary, rather than trusting the route:
 * a non-finite or negative limit reaching `LIMIT ?` means *unbounded* in SQLite
 * (.claude/rules/51, and the same reasoning as `clampRowLimit` in knowledge.ts).
 */
export function resolveProjectCommentListLimit(env: Env, requested?: number | null): number {
  const defaultLimit = positiveInteger(
    env.PROJECT_COMMENT_LIST_LIMIT,
    DEFAULT_PROJECT_COMMENT_LIST_LIMIT
  );
  const maxLimit = Math.max(
    defaultLimit,
    positiveInteger(env.PROJECT_COMMENT_LIST_MAX, DEFAULT_PROJECT_COMMENT_LIST_MAX)
  );
  const limit =
    typeof requested === 'number' && Number.isFinite(requested) && requested > 0
      ? Math.floor(requested)
      : defaultLimit;
  return Math.min(limit, maxLimit);
}

export function resolveProjectCommentListMaxBytes(env: Env): number {
  return positiveInteger(
    env.PROJECT_COMMENT_LIST_MAX_BYTES,
    DEFAULT_PROJECT_COMMENT_LIST_MAX_BYTES
  );
}

export function normalizeBody(body: string, limits: CommentLimits): string {
  const normalized = body.trim();
  if (!normalized) throw new CommentValidationError('body is required');
  if (normalized.length > limits.bodyMaxLength) {
    throw new CommentValidationError(`body must be ${limits.bodyMaxLength} characters or fewer`);
  }
  return normalized;
}

export function normalizeQuote(
  quote: string | null | undefined,
  limits: CommentLimits
): string | null {
  if (quote === null || quote === undefined) return null;
  const normalized = quote.trim();
  if (!normalized) return null;
  if (normalized.length > limits.quoteMaxLength) {
    throw new CommentValidationError(`quote must be ${limits.quoteMaxLength} characters or fewer`);
  }
  return normalized;
}

export function normalizeClientMutationId(
  clientMutationId: string | null | undefined,
  limits: CommentLimits
): string | null {
  if (clientMutationId === null || clientMutationId === undefined) return null;
  const normalized = clientMutationId.trim();
  if (!normalized) return null;
  if (normalized.length > limits.idempotencyKeyMaxLength) {
    throw new CommentValidationError(
      `clientMutationId must be ${limits.idempotencyKeyMaxLength} characters or fewer`
    );
  }
  return normalized;
}

export function normalizeActor(actor: CommentActor): CommentActor {
  if (actor.kind !== 'human' && actor.kind !== 'agent') {
    throw new CommentValidationError('actor kind must be human or agent');
  }
  const id = actor.id.trim();
  if (!id) throw new CommentValidationError('actor id is required');
  const name = actor.name?.trim() || null;
  return { kind: actor.kind, id, name };
}

export function fingerprint(value: unknown): string {
  return JSON.stringify(value);
}

export function actorFromColumns(
  kind: 'human' | 'agent' | null,
  id: string | null,
  name: string | null
): CommentActor | null {
  if (!kind || !id) return null;
  return { kind, id, name };
}
