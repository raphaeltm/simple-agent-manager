import * as v from 'valibot';

/**
 * Message-anchored comment request schemas.
 *
 * Length limits are environment-backed and enforced inside ProjectData so HTTP,
 * RPC, MCP, and future callers share one authoritative boundary.
 */

/**
 * Structured @mentions: user IDs picked from the member list. The array bound is a hard
 * request ceiling; the effective per-comment limit is the admin setting
 * `collaboration.commentMentionsMax`, and membership is verified server-side.
 */
const CommentMentionsSchema = v.optional(
  v.pipe(
    v.array(v.object({ userId: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(128)) })),
    v.maxLength(50)
  )
);

export const CreateCommentThreadSchema = v.object({
  messageId: v.pipe(v.string(), v.trim(), v.minLength(1)),
  body: v.string(),
  quote: v.optional(v.nullable(v.string())),
  clientMutationId: v.optional(v.nullable(v.string())),
  mentions: CommentMentionsSchema,
});

export const CreateCommentReplySchema = v.object({
  body: v.string(),
  clientMutationId: v.optional(v.nullable(v.string())),
  mentions: CommentMentionsSchema,
});

export const CommentStatusMutationSchema = v.object({
  clientMutationId: v.optional(v.nullable(v.string())),
});

export const CreateLibraryFileCommentThreadSchema = v.object({
  body: v.string(),
  quote: v.optional(v.nullable(v.string())),
  clientMutationId: v.optional(v.nullable(v.string())),
});

export const SendCommentDirectiveSchema = v.object({
  body: v.optional(v.string()),
  clientMutationId: v.optional(v.nullable(v.string())),
});
