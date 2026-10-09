import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { requireRouteParam } from '../lib/route-helpers';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireProjectCapability } from '../middleware/project-auth';
import { operationReceiptId } from '../services/cli-operation-receipts';

export const cliOperationReceiptRoutes = new Hono<{ Bindings: Env }>();
cliOperationReceiptRoutes.get('/', requireAuth(), requireApproved(), async (c) => {
  const projectId = requireRouteParam(c, 'projectId');
  const userId = getUserId(c);
  await requireProjectCapability(
    drizzle(c.env.DATABASE, { schema }),
    projectId,
    userId,
    'task:read'
  );
  c.header('Cache-Control', 'private, no-store');
  const key = c.req.query('key');
  const operation = c.req.query('operation');
  if (!key || !/^[A-Za-z0-9._:-]{1,128}$/.test(key)) throw errors.badRequest('Invalid receipt key');
  let path: string;
  if (operation === 'profile-create' || operation === 'skill-create') {
    path = `/api/projects/${projectId}/cli/${operation === 'profile-create' ? 'profiles' : 'skills'}`;
  } else if (operation === 'submit') path = `/api/projects/${projectId}/tasks/submit`;
  else if (operation === 'prompt') {
    const sessionId = c.req.query('sessionId');
    if (!sessionId || !/^[A-Za-z0-9_-]+$/.test(sessionId))
      throw errors.badRequest('sessionId is required');
    path = `/api/projects/${projectId}/sessions/${sessionId}/prompt`;
  } else
    throw errors.badRequest('operation must be submit, prompt, profile-create or skill-create');
  const receiptId = await operationReceiptId(projectId, userId, 'POST', path, key);
  const receipt = await c.env.DATABASE.prepare(
    'SELECT state, response_json, response_status, created_at FROM cli_operation_receipts WHERE receipt_id = ? AND project_id = ? AND user_id = ?'
  )
    .bind(receiptId, projectId, userId)
    .first();
  if (!receipt) return c.json({ receiptId, known: false, safeToResubmit: false });
  // This route returns only the caller's receipt, never the request body.
  return c.json({
    receiptId,
    known: true,
    state: receipt.state,
    responseStatus: receipt.response_status,
    response: receipt.response_json ? JSON.parse(String(receipt.response_json)) : null,
    createdAt: receipt.created_at,
  });
});
