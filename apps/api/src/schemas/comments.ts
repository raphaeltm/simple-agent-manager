import * as v from 'valibot';

/**
 * Message-anchored comment request schemas.
 *
 * Length limits are environment-backed and enforced inside ProjectData so HTTP,
 * RPC, MCP, and future callers share one authoritative boundary.
 */

export const CreateCommentThreadSchema = v.object({
  messageId: v.pipe(v.string(), v.trim(), v.minLength(1)),
  body: v.string(),
  quote: v.optional(v.nullable(v.string())),
  clientMutationId: v.optional(v.nullable(v.string())),
});

export const CreateCommentReplySchema = v.object({
  body: v.string(),
  clientMutationId: v.optional(v.nullable(v.string())),
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
