import * as v from 'valibot';

import {
  DEFAULT_SOURCE_PATH_LIMIT,
  DEFAULT_THREAD_AUTHOR_LIMIT,
  DEFAULT_THREAD_BODY_LIMIT,
  DEFAULT_THREAD_TITLE_LIMIT,
} from '../constants';

const idSchema = v.pipe(v.string(), v.minLength(1), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/));

const optionalAuthorSchema = v.optional(
  v.pipe(v.string(), v.minLength(1), v.maxLength(DEFAULT_THREAD_AUTHOR_LIMIT))
);
const bodySchema = v.pipe(v.string(), v.minLength(1), v.maxLength(DEFAULT_THREAD_BODY_LIMIT));
const titleSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(DEFAULT_THREAD_TITLE_LIMIT));

export const sourcePreviewRequestSchema = v.object({
  target: idSchema,
  sourceIndex: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 0),
  path: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(DEFAULT_SOURCE_PATH_LIMIT))),
});

export const createThreadRequestSchema = v.object({
  target: idSchema,
  title: titleSchema,
  body: bodySchema,
  author: optionalAuthorSchema,
});

export const replyRequestSchema = v.object({
  body: bodySchema,
  author: optionalAuthorSchema,
  replyTo: v.optional(idSchema),
});
