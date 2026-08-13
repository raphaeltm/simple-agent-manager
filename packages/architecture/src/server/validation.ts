import * as v from 'valibot';

import {
  DEFAULT_SOURCE_PATH_LIMIT,
  DEFAULT_THREAD_AUTHOR_LIMIT,
  DEFAULT_THREAD_BODY_LIMIT,
  DEFAULT_THREAD_TITLE_LIMIT,
} from '../constants';

const idSchema = v.pipe(v.string(), v.minLength(1), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/));

export interface ArchitectureRequestLimits {
  threadAuthorChars: number;
  threadBodyChars: number;
  threadTitleChars: number;
  sourcePathChars: number;
}

export const DEFAULT_REQUEST_LIMITS: ArchitectureRequestLimits = {
  threadAuthorChars: DEFAULT_THREAD_AUTHOR_LIMIT,
  threadBodyChars: DEFAULT_THREAD_BODY_LIMIT,
  threadTitleChars: DEFAULT_THREAD_TITLE_LIMIT,
  sourcePathChars: DEFAULT_SOURCE_PATH_LIMIT,
};

export function makeRequestSchemas(limits: ArchitectureRequestLimits = DEFAULT_REQUEST_LIMITS) {
  const optionalAuthorSchema = v.optional(
    v.pipe(v.string(), v.minLength(1), v.maxLength(limits.threadAuthorChars))
  );
  const bodySchema = v.pipe(v.string(), v.minLength(1), v.maxLength(limits.threadBodyChars));
  const titleSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(limits.threadTitleChars));
  return {
    sourcePreview: v.strictObject({
      target: idSchema,
      sourceIndex: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 0),
      path: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(limits.sourcePathChars))),
    }),
    createThread: v.strictObject({
      target: idSchema,
      title: titleSchema,
      body: bodySchema,
      author: optionalAuthorSchema,
    }),
    reply: v.strictObject({
      body: bodySchema,
      author: optionalAuthorSchema,
      replyTo: v.optional(idSchema),
    }),
  };
}

const defaultSchemas = makeRequestSchemas();
export const sourcePreviewRequestSchema = defaultSchemas.sourcePreview;
export const createThreadRequestSchema = defaultSchemas.createThread;
export const replyRequestSchema = defaultSchemas.reply;
