import { CHAT_TOOL_REPLACE_CAPABILITY } from '@simple-agent-manager/shared';
import type { Context } from 'hono';

import type { Env } from '../env';
import { errors } from '../middleware/error';
import { resolveAdminSetting } from '../services/admin-settings';
import { getToolChanges } from '../services/project-data';

/** Legacy reads seal mutability BEFORE their snapshot. OFF adds no transcript writes/RPC. */
export async function readChatToolChanges(
  c: Context<{ Bindings: Env }>,
  projectId: string,
  sessionId: string
) {
  if ((await resolveAdminSetting(c.env, 'chat.toolCallMergingEnabled')) !== true) return undefined;
  const raw = c.req.query('afterToolRevision');
  const afterRevision = raw === undefined ? undefined : Number(raw);
  if (afterRevision !== undefined && (!Number.isSafeInteger(afterRevision) || afterRevision < 0))
    throw errors.badRequest('afterToolRevision must be a nonnegative integer');
  return getToolChanges(
    c.env,
    projectId,
    sessionId,
    afterRevision,
    c.req.query('toolReplace') !== CHAT_TOOL_REPLACE_CAPABILITY
  );
}
