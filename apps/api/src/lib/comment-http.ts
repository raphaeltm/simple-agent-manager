/**
 * HTTP-boundary helpers shared by the message-comment and library-file-comment
 * routes.
 *
 * These were duplicated across `routes/chat-comments.ts` and
 * `routes/library-comments.ts`. The copies drifted: only the chat one handled
 * errors that had crossed the Durable Object RPC boundary, where the error class
 * is lost and only `name`/`message`/`code` survive — so the library routes turned
 * an expected 404 into a 500. One implementation, used by both
 * (.claude/rules/24-no-duplicate-ui-controls.md).
 */

import type { CommentStatus } from '@simple-agent-manager/shared';
import { COMMENT_STATUSES } from '@simple-agent-manager/shared';
import type { Context } from 'hono';

import type { Env } from '../env';
import { getAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import {
  CommentIdempotencyConflictError,
  CommentLimitExceededError,
  CommentNotFoundError,
  CommentValidationError,
} from '../services/project-data';

export function parseCommentStatus(rawStatus?: string): CommentStatus | null {
  if (!rawStatus) return null;
  const status = rawStatus.trim().toLowerCase();
  if (COMMENT_STATUSES.includes(status as CommentStatus)) return status as CommentStatus;
  throw errors.badRequest('status must be open, sent, or resolved');
}

export function parsePositiveIntegerQuery(name: string, rawValue?: string): number | null {
  if (!rawValue) return null;
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw errors.badRequest(`${name} must be a positive integer`);
  }
  return parsed;
}

export function parseNonNegativeIntegerQuery(name: string, rawValue?: string): number | null {
  if (!rawValue) return null;
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw errors.badRequest(`${name} must be a non-negative integer`);
  }
  return parsed;
}

export function getCommentActor(c: Context<{ Bindings: Env }>) {
  const auth = getAuth(c);
  return {
    kind: 'human' as const,
    id: auth.user.id,
    name: auth.user.name ?? auth.user.email ?? null,
  };
}

function getCommentErrorName(err: unknown): string | null {
  return err instanceof Error ? err.name : null;
}

function getCommentErrorCode(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function getCommentNotFoundResource(err: unknown): string {
  if (err && typeof err === 'object') {
    const resource = (err as { resource?: unknown }).resource;
    if (typeof resource === 'string') return resource;
  }
  const message = err instanceof Error ? err.message : '';
  if (message.startsWith('Message ')) return 'Message';
  if (message.startsWith('Comment thread ')) return 'Comment thread';
  if (message.startsWith('Chat session ')) return 'Chat session';
  if (message.startsWith('Library file ')) return 'Library file';
  return 'Resource';
}

/**
 * A CommentNotFoundError that crossed the DO RPC boundary arrives as a plain
 * Error — the class and the `code` property are both gone. Match on the exact
 * messages the DO can produce.
 */
function isSerializedCommentNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.message === 'Chat session not found' ||
    err.message === 'Message not found' ||
    err.message === 'Comment thread not found' ||
    err.message === 'Library file not found'
  );
}

export function rethrowCommentError(err: unknown): never {
  const code = getCommentErrorCode(err);
  const name = getCommentErrorName(err);
  if (
    err instanceof CommentValidationError ||
    code === 'COMMENT_VALIDATION' ||
    name === 'CommentValidationError'
  ) {
    throw errors.badRequest(err instanceof Error ? err.message : 'Invalid comment request');
  }
  if (
    err instanceof CommentNotFoundError ||
    code === 'COMMENT_NOT_FOUND' ||
    name === 'CommentNotFoundError' ||
    isSerializedCommentNotFoundError(err)
  ) {
    throw errors.notFound(getCommentNotFoundResource(err));
  }
  if (
    err instanceof CommentIdempotencyConflictError ||
    code === 'COMMENT_IDEMPOTENCY_CONFLICT' ||
    name === 'CommentIdempotencyConflictError'
  ) {
    throw errors.conflict(
      err instanceof Error
        ? err.message
        : 'clientMutationId already belongs to a different comment mutation'
    );
  }
  if (
    err instanceof CommentLimitExceededError ||
    code === 'COMMENT_LIMIT_EXCEEDED' ||
    name === 'CommentLimitExceededError'
  ) {
    throw errors.unprocessable(err instanceof Error ? err.message : 'Comment limit exceeded');
  }
  throw err;
}
