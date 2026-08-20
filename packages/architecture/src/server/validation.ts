import * as v from 'valibot';

import {
  DEFAULT_SOURCE_PATH_LIMIT,
  DEFAULT_THREAD_AUTHOR_LIMIT,
  DEFAULT_THREAD_BODY_LIMIT,
} from '../constants';

const idSchema = v.pipe(v.string(), v.minLength(1), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/));

export interface ArchitectureRequestLimits {
  threadAuthorChars: number;
  threadBodyChars: number;
  sourcePathChars: number;
}

export const DEFAULT_REQUEST_LIMITS: ArchitectureRequestLimits = {
  threadAuthorChars: DEFAULT_THREAD_AUTHOR_LIMIT,
  threadBodyChars: DEFAULT_THREAD_BODY_LIMIT,
  sourcePathChars: DEFAULT_SOURCE_PATH_LIMIT,
};

export function makeRequestSchemas(limits: ArchitectureRequestLimits = DEFAULT_REQUEST_LIMITS) {
  const optionalAuthorSchema = v.optional(
    v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(limits.threadAuthorChars))
  );
  const bodySchema = v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(limits.threadBodyChars)
  );
  const lineGroupSchema = v.strictObject({
    startLine: v.pipe(v.number(), v.integer(), v.minValue(1)),
    endLine: v.pipe(v.number(), v.integer(), v.minValue(1)),
    label: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120))),
  });
  return {
    sourcePreview: v.strictObject({
      target: idSchema,
      sourceIndex: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 0),
      path: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(limits.sourcePathChars))),
      lineGroups: v.optional(v.array(lineGroupSchema)),
      fullFile: v.optional(v.boolean(), false),
    }),
    createThread: v.strictObject({
      target: idSchema,
      question: bodySchema,
      author: optionalAuthorSchema,
    }),
    reply: v.strictObject({
      body: bodySchema,
      author: optionalAuthorSchema,
      replyTo: v.optional(idSchema),
    }),
    acceptThread: v.strictObject({
      messageId: v.optional(idSchema),
      author: optionalAuthorSchema,
    }),
  };
}

const defaultSchemas = makeRequestSchemas();
export const sourcePreviewRequestSchema = defaultSchemas.sourcePreview;
export const createThreadRequestSchema = defaultSchemas.createThread;
export const replyRequestSchema = defaultSchemas.reply;
