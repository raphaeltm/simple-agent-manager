import { Hono } from 'hono';

import type { Env } from '../../env';
import { errors } from '../../middleware/error';
import {
  requestProjectDataArchiveForwardFix,
  requestProjectDataArchiveRehome,
} from '../../scheduled/project-data-archive-sharding';
import {
  jsonValidator,
  ProjectDataArchiveForwardFixSchema,
  ProjectDataArchiveRehomeSchema,
} from '../../schemas';

export const adminProjectDataArchiveRoutes = new Hono<{ Bindings: Env }>();

/**
 * Explicit recovery for a frozen terminal-archive journal. The parent admin
 * router requires an approved superadmin and the coordinator remains disabled
 * unless PROJECT_DATA_ARCHIVE_SHARDING_ENABLED is explicitly true.
 */
adminProjectDataArchiveRoutes.post(
  '/migrations/:migrationId/forward-fix',
  jsonValidator(ProjectDataArchiveForwardFixSchema),
  async (c) => {
    const { migrationId } = c.req.param();
    if (!migrationId) throw errors.badRequest('migrationId is required');
    const { mode } = c.req.valid('json');
    await requestProjectDataArchiveForwardFix(c.env, migrationId, mode);
    return c.json({ migrationId, mode, accepted: true });
  }
);

/**
 * Repack an authoritative archived session to an explicit configured owner.
 * Requiring validated JSON keeps this cookie-authenticated mutation out of the
 * simple-form request class and makes caller-supplied target selection
 * explicit. A rejected root copyback uses only the caller's explicit non-root
 * fallback, keeping this synchronous mutation inside the request I/O budget.
 */
adminProjectDataArchiveRoutes.post(
  '/projects/:projectId/sessions/:sessionId/rehome',
  async (c, next) => {
    const mediaType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (mediaType !== 'application/json') {
      throw errors.badRequest('Content-Type must be application/json');
    }
    try {
      await c.req.raw.clone().json();
    } catch {
      return c.json({ error: 'BAD_REQUEST', message: 'Invalid JSON in request body' }, 400);
    }
    await next();
  },
  jsonValidator(ProjectDataArchiveRehomeSchema),
  async (c) => {
    const { projectId, sessionId } = c.req.param();
    if (!projectId) throw errors.badRequest('projectId is required');
    if (!sessionId) throw errors.badRequest('sessionId is required');
    const { targetOwnerName, fallbackTargetOwnerName } = c.req.valid('json');
    const result = await requestProjectDataArchiveRehome(
      c.env,
      projectId,
      sessionId,
      targetOwnerName,
      fallbackTargetOwnerName
    );
    return c.json({ result });
  }
);
