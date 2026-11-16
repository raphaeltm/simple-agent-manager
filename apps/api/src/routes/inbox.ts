/**
 * Inbox REST adapter (idea 01M7G03ZCQ6TM6CMEYDRKQ8ST9, slice A). Transport only: every route
 * calls the shared inbox operation core in `@simple-agent-manager/operations`, the same code the
 * Connector tools run.
 *
 *   GET  /api/inbox?filter=&limit=&cursor=                       — cross-project list
 *   GET  /api/inbox/count                                         — badge counts
 *   GET  /api/projects/:projectId/inbox?filter=&limit=&cursor=   — one project's list
 *   GET  /api/projects/:projectId/inbox/count
 *   GET  /api/projects/:projectId/inbox/items/:ref?context=true  — one item (+ transcript context)
 *   POST /api/projects/:projectId/inbox/items/:ref/answer         — answer through the item's store
 *     (a system error item takes `{action}`: retry, wake or resume, `inbox-error-core.ts`)
 *   POST /api/projects/:projectId/inbox/items/:ref/archive        — close; the agent is told
 *
 * Writes come only from the app's own pages (exact origin, JSON body), like the interaction and
 * secret answer routes. The answer body can carry a secret value: it is parsed here with fixed
 * error messages (no validator that could echo it, `.claude/rules/51`) and never logged.
 */
import {
  answerInboxItem,
  archiveInboxItem,
  countInbox,
  getInboxItem,
  INBOX_SETTINGS,
  type InboxAnswerInput,
  listInbox,
  toOperationHttpError,
} from '@simple-agent-manager/operations';
import {
  INBOX_ERROR_ACTIONS,
  INBOX_FILTERS,
  type InboxErrorAction,
  type InboxFilter,
  parseInboxRef,
} from '@simple-agent-manager/shared';
import { type Context, Hono } from 'hono';

import type { Env } from '../env';
import { readBoundedRequestBody, RequestBodyTooLargeError } from '../lib/bounded-request-body';
import { requireRouteParam } from '../lib/route-helpers';
import {
  assertNotAgentSignInSession,
  getUserId,
  requireApproved,
  requireAuth,
} from '../middleware/auth';
import { errors } from '../middleware/error';
import { webOperationContext } from '../operation-ports';
import { getRuntimeLimits } from '../services/limits';
import {
  assertBrowserJsonWrite,
  EXPECTED_EXISTING_VERSION_MAX_LENGTH,
} from './projects/secret-requests';

const session = [requireAuth(), requireApproved()] as const;
/** Body overhead allowed on top of an answer or secret value: JSON framing and other fields. */
const ANSWER_BODY_OVERHEAD_BYTES = 64 * 1024;
/** The most `inbox.answerMaxChars` can be set to (its registry range). */
const ANSWER_MAX_CHARS_CEILING =
  INBOX_SETTINGS.find((setting) => setting.name === 'inbox.answerMaxChars')?.range.max ?? 20_000;

type AppContext = Context<{ Bindings: Env }>;

function filterParam(value: string | undefined): InboxFilter | undefined {
  if (value === undefined || value === '') return undefined;
  if (!(INBOX_FILTERS as readonly string[]).includes(value))
    throw errors.badRequest(`filter must be one of: ${INBOX_FILTERS.join(', ')}`);
  return value as InboxFilter;
}

function limitParam(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw errors.badRequest('limit must be a positive integer');
  return parsed;
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw toOperationHttpError(error);
  }
}

async function list(c: AppContext, projectId: string | undefined) {
  const ctx = webOperationContext(c, getUserId(c));
  return c.json(
    await run(() =>
      listInbox(ctx, {
        projectId,
        filter: filterParam(c.req.query('filter')),
        limit: limitParam(c.req.query('limit')),
        cursor: c.req.query('cursor') || undefined,
      })
    )
  );
}

async function count(c: AppContext, projectId: string | undefined) {
  const ctx = webOperationContext(c, getUserId(c));
  return c.json(await run(() => countInbox(ctx, { projectId })));
}

// Field lengths are checked by the operation against the admin settings (`inbox.answerMaxChars`);
// the route bounds only the body.
const text = (value: unknown, field: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0)
    throw errors.badRequest(`${field} must be a non-empty string`);
  return value;
};

/** Parse the answer body with fixed messages; the secret value is never echoed. */
async function readAnswerBody(c: AppContext): Promise<Omit<InboxAnswerInput, 'projectId' | 'ref'>> {
  let parsed: unknown;
  try {
    // Room for the larger of a secret value and the largest answer the settings allow (up to
    // four bytes per character); escaping can make JSON up to six times that (\uXXXX).
    const maxValueBytes = Math.max(
      getRuntimeLimits(c.env).maxProjectRuntimeEnvValueBytes,
      ANSWER_MAX_CHARS_CEILING * 4
    );
    const bytes = await readBoundedRequestBody(
      c.req.raw,
      maxValueBytes * 6 + ANSWER_BODY_OVERHEAD_BYTES
    );
    parsed = bytes.byteLength === 0 ? {} : JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError)
      throw errors.badRequest('Request body is too large');
    // Never include the parser's message: it can quote the body.
    throw errors.badRequest('Request body must be a JSON object');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw errors.badRequest('Request body must be a JSON object');
  const body = parsed as Record<string, unknown>;
  const out: Omit<InboxAnswerInput, 'projectId' | 'ref'> = {
    answer: text(body.answer, 'answer'),
    optionId: text(body.optionId, 'optionId'),
    note: text(body.note, 'note'),
  };
  if (body.decline !== undefined) {
    if (body.decline !== true) throw errors.badRequest('decline must be true when given');
    out.decline = true;
  }
  if (body.decision !== undefined) {
    if (body.decision !== 'approve' && body.decision !== 'deny')
      throw errors.badRequest('decision must be approve or deny');
    out.decision = body.decision;
  }
  if (body.action !== undefined) {
    if (
      typeof body.action !== 'string' ||
      !(INBOX_ERROR_ACTIONS as readonly string[]).includes(body.action)
    )
      throw errors.badRequest(`action must be one of ${INBOX_ERROR_ACTIONS.join(', ')}`);
    out.action = body.action as InboxErrorAction;
  }
  if (body.formContent !== undefined) {
    if (
      !body.formContent ||
      typeof body.formContent !== 'object' ||
      Array.isArray(body.formContent)
    )
      throw errors.badRequest('formContent must be an object');
    out.formContent = body.formContent as Record<string, unknown>;
  }
  if (body.secret !== undefined) {
    const secret = body.secret;
    if (!secret || typeof secret !== 'object' || Array.isArray(secret))
      throw errors.badRequest('secret must be an object with a string value');
    const record = secret as Record<string, unknown>;
    if (typeof record.value !== 'string' || record.value.length === 0)
      throw errors.badRequest('secret.value is required and must be a non-empty string');
    if (record.replaceExisting !== undefined && typeof record.replaceExisting !== 'boolean')
      throw errors.badRequest('secret.replaceExisting must be a boolean');
    const expected = record.expectedExistingVersion;
    if (
      expected !== undefined &&
      (typeof expected !== 'string' ||
        expected.length === 0 ||
        expected.length > EXPECTED_EXISTING_VERSION_MAX_LENGTH)
    )
      throw errors.badRequest('secret.expectedExistingVersion must be the version string shown');
    out.secret = {
      value: record.value,
      replaceExisting: record.replaceExisting === true,
      ...(typeof expected === 'string' ? { expectedExistingVersion: expected } : {}),
    };
  }
  return out;
}

/** Cross-project reads, mounted at `/api/inbox`. */
export const inboxRoutes = new Hono<{ Bindings: Env }>();
inboxRoutes.get('/', ...session, (c) => list(c, undefined));
inboxRoutes.get('/count', ...session, (c) => count(c, undefined));

/** One project's inbox, mounted at `/api/projects/:projectId/inbox`. */
export const projectInboxRoutes = new Hono<{ Bindings: Env }>();
projectInboxRoutes.get('/', ...session, (c) => list(c, requireRouteParam(c, 'projectId')));
projectInboxRoutes.get('/count', ...session, (c) => count(c, requireRouteParam(c, 'projectId')));

projectInboxRoutes.get('/items/:ref', ...session, async (c) => {
  const ctx = webOperationContext(c, getUserId(c));
  return c.json(
    await run(() =>
      getInboxItem(ctx, {
        projectId: requireRouteParam(c, 'projectId'),
        ref: requireRouteParam(c, 'ref'),
        context: c.req.query('context') === 'true',
      })
    )
  );
});

projectInboxRoutes.post('/items/:ref/answer', ...session, async (c) => {
  assertBrowserJsonWrite(c, 'inbox');
  const body = await readAnswerBody(c);
  // A system error's fix (retry, wake, resume) is a person's call: an agent's sign-in session may
  // not run it, as the trigger PATCH route refuses an agent a resume (`onlyStandsDown`).
  if (body.action !== undefined) assertNotAgentSignInSession(c);
  const ctx = webOperationContext(c, getUserId(c));
  return c.json(
    await run(() =>
      answerInboxItem(ctx, {
        ...body,
        projectId: requireRouteParam(c, 'projectId'),
        ref: requireRouteParam(c, 'ref'),
      })
    )
  );
});

projectInboxRoutes.post('/items/:ref/archive', ...session, async (c) => {
  assertBrowserJsonWrite(c, 'inbox');
  const projectId = requireRouteParam(c, 'projectId');
  const ref = requireRouteParam(c, 'ref');
  // A system error item is SAM's alert to the person, and archiving it keeps later repeats quiet:
  // an agent's sign-in session may not dismiss it. One read, for agent sign-in sessions only.
  if (c.get('auth')?.session.agentSignIn && (await isErrorItemRef(c.env, projectId, ref)))
    assertNotAgentSignInSession(c);
  const ctx = webOperationContext(c, getUserId(c));
  return c.json(await run(() => archiveInboxItem(ctx, { projectId, ref })));
});

async function isErrorItemRef(env: Env, projectId: string, ref: string): Promise<boolean> {
  const parsed = parseInboxRef(ref);
  if (parsed?.store !== 'ask') return false;
  const row = await env.DATABASE.prepare(
    `SELECT 1 AS ok FROM asks WHERE id = ? AND project_id = ? AND kind = 'error'`
  )
    .bind(parsed.id, projectId)
    .first();
  return Boolean(row);
}
