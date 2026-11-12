/**
 * REST adapter behind the in-chat secret request card (`services/runtime-secret-requests.ts`).
 *
 *   GET  /api/projects/:id/secret-requests/:requestId           — metadata (secret:read)
 *   POST /api/projects/:id/secret-requests/:requestId/fulfill   — store the value (secret:write)
 *   POST /api/projects/:id/secret-requests/:requestId/decline   — refuse it (secret:write)
 *
 * The fulfil body carries the plaintext value. It is parsed here with fixed error messages (no
 * schema library that could echo the input, `.claude/rules/51`), handed to the service once, and
 * never logged or returned.
 */
import type { RuntimeSecretRequestResponse } from '@simple-agent-manager/shared';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { type Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { readBoundedRequestBody, RequestBodyTooLargeError } from '../../lib/bounded-request-body';
import { requireRouteParam } from '../../lib/route-helpers';
import { sanitizeUserInput } from '../../lib/sanitize-user-input';
import { getUserId } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { hasProjectCapability, requireProjectCapability } from '../../middleware/project-auth';
import { getRuntimeLimits } from '../../services/limits';
import { toRuntimeSecretRequest } from '../../services/runtime-secret-request-records';
import {
  declineRuntimeSecretRequest,
  describeExistingValue,
  fulfillRuntimeSecretRequest,
  getRuntimeSecretRequest,
} from '../../services/runtime-secret-requests';

type Db = ReturnType<typeof drizzle<typeof schema>>;

/** Body overhead allowed on top of the value itself: JSON framing and the confirm flag. */
const FULFIL_BODY_OVERHEAD_BYTES = 1_024;

async function readFulfilBody(
  request: Request,
  maxValueBytes: number
): Promise<{ value: string; replaceExisting: boolean }> {
  let parsed: unknown;
  try {
    // Escaping can make the JSON up to six times the value's byte length (\uXXXX).
    const bytes = await readBoundedRequestBody(
      request,
      maxValueBytes * 6 + FULFIL_BODY_OVERHEAD_BYTES
    );
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      throw errors.badRequest(`value exceeds max size of ${maxValueBytes} bytes`);
    }
    // Never include the parser's message: it can quote the body.
    throw errors.badRequest('Request body must be JSON with a string value');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw errors.badRequest('Request body must be JSON with a string value');
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.value !== 'string' || record.value.length === 0) {
    throw errors.badRequest('value is required and must be a non-empty string');
  }
  if (record.replaceExisting !== undefined && typeof record.replaceExisting !== 'boolean') {
    throw errors.badRequest('replaceExisting must be a boolean');
  }
  return { value: record.value, replaceExisting: record.replaceExisting === true };
}

/** Longest display name passed to the agent's notice. A display bound, not a policy limit. */
const ACTOR_NAME_MAX_CHARS = 64;

/**
 * The person's display name for the agent's notice and the card. It reaches an agent prompt, so
 * control characters and newlines are stripped and it is capped; the email is never used.
 */
async function actorName(db: Db, userId: string): Promise<string | null> {
  const rows = await db
    .select({ name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  const name = sanitizeUserInput(rows[0]?.name ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, ACTOR_NAME_MAX_CHARS);
  return name || null;
}

/**
 * Both actions change state on a session cookie. Requiring a JSON content type makes any
 * cross-origin call a preflighted request, which the credentialed CORS allowlist refuses, so a
 * page on another origin (including a workspace port on the same site) cannot submit or decline
 * a request on someone's behalf with a "simple" form or text/plain POST.
 */
function assertJsonRequest(request: Request): void {
  const contentType = request.headers.get('content-type') ?? '';
  if (!/^application\/json\b/i.test(contentType.trim())) {
    throw errors.unsupportedMediaType('Content-Type must be application/json');
  }
}

export function registerProjectSecretRequestRoutes(crudRoutes: Hono<{ Bindings: Env }>): void {
  crudRoutes.get('/:id/secret-requests/:requestId', async (c) => {
    const userId = getUserId(c);
    const projectId = requireRouteParam(c, 'id');
    const requestId = requireRouteParam(c, 'requestId');
    const db = drizzle(c.env.DATABASE, { schema });
    await requireProjectCapability(db, projectId, userId, 'secret:read');
    const { row, resolvedByName } = await getRuntimeSecretRequest(db, projectId, requestId);
    const now = Date.now();
    const request = toRuntimeSecretRequest(row, resolvedByName, now);
    const [existing, canWrite] = await Promise.all([
      describeExistingValue(db, projectId, row.envKey, now),
      hasProjectCapability(db, projectId, userId, 'secret:write'),
    ]);
    const response: RuntimeSecretRequestResponse = {
      request,
      existing,
      canResolve: canWrite && request.status === 'pending',
    };
    return c.json(response);
  });

  crudRoutes.post('/:id/secret-requests/:requestId/fulfill', async (c) => {
    const userId = getUserId(c);
    const projectId = requireRouteParam(c, 'id');
    const requestId = requireRouteParam(c, 'requestId');
    const db = drizzle(c.env.DATABASE, { schema });
    await requireProjectCapability(db, projectId, userId, 'secret:write');
    assertJsonRequest(c.req.raw);
    const body = await readFulfilBody(
      c.req.raw,
      getRuntimeLimits(c.env).maxProjectRuntimeEnvValueBytes
    );
    const result = await fulfillRuntimeSecretRequest(c.env, db, {
      projectId,
      requestId,
      actorUserId: userId,
      actorName: await actorName(db, userId),
      value: body.value,
      replaceExisting: body.replaceExisting,
    });
    return c.json(result);
  });

  crudRoutes.post('/:id/secret-requests/:requestId/decline', async (c) => {
    const userId = getUserId(c);
    const projectId = requireRouteParam(c, 'id');
    const requestId = requireRouteParam(c, 'requestId');
    const db = drizzle(c.env.DATABASE, { schema });
    await requireProjectCapability(db, projectId, userId, 'secret:write');
    assertJsonRequest(c.req.raw);
    const result = await declineRuntimeSecretRequest(c.env, db, {
      projectId,
      requestId,
      actorUserId: userId,
      actorName: await actorName(db, userId),
    });
    return c.json(result);
  });
}
