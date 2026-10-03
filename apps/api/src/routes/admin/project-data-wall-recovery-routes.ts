import { type Hono } from 'hono';

import {
  type GroupedFtsWallRecoveryConfig,
  resolveGroupedFtsWallRecoveryConfig,
} from '../../durable-objects/project-data/grouped-fts-wall-recovery';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { getUserId } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { jsonValidator, ProjectDataGroupedFtsWallRecoverySchema } from '../../schemas';
import { runProjectDataGroupedFtsWallRecovery } from '../../services/project-data';
import { assertProjectId } from './project-data-storage-route-helpers';

/** Grouped-FTS wall recovery under /api/admin/project-data/storage (superadmin). */

const GROUPED_FTS_WALL_RECOVERY_BOUNDS: Array<{
  field: 'maxRows' | 'maxBytes' | 'maxSessions';
  ceiling: keyof GroupedFtsWallRecoveryConfig;
}> = [
  { field: 'maxRows', ceiling: 'maxRows' },
  { field: 'maxBytes', ceiling: 'maxBytes' },
  { field: 'maxSessions', ceiling: 'maxSessions' },
];

function assertGroupedFtsWallRecoveryBounds(
  body: Record<'maxRows' | 'maxBytes' | 'maxSessions', number> & { skipSessionIds: string[] },
  env: Env
): void {
  const config = resolveGroupedFtsWallRecoveryConfig(env);
  for (const { field, ceiling } of GROUPED_FTS_WALL_RECOVERY_BOUNDS) {
    if (body[field] > config[ceiling]) {
      throw errors.badRequest(`${field} must be between 1 and ${config[ceiling]}`);
    }
  }
  if (body.skipSessionIds.length > config.maxSessions) {
    throw errors.badRequest(`skipSessionIds may hold at most ${config.maxSessions} ids`);
  }
}

export function registerProjectDataWallRecoveryRoutes(router: Hono<{ Bindings: Env }>): void {
  /**
   * POST /api/admin/project-data/storage/:projectId/grouped-fts-wall-recovery
   *
   * Superadmin storage relief that works at the hard per-object cap: prunes
   * grouped/FTS search rows of old terminal sessions delete-first, never touching
   * message text. `dryRun` and every budget are required and bounded by env
   * ceilings; `skipSessionIds` bypasses a session whose page keeps failing.
   */
  router.post(
    '/:projectId/grouped-fts-wall-recovery',
    jsonValidator(ProjectDataGroupedFtsWallRecoverySchema),
    async (c) => {
      const projectId = assertProjectId(c.req.param('projectId'));
      const body = c.req.valid('json');
      assertGroupedFtsWallRecoveryBounds(body, c.env);
      log.warn('admin.grouped_fts_wall_recovery_requested', {
        projectId,
        userId: getUserId(c),
        reason: body.reason,
        dryRun: body.dryRun,
        maxRows: body.maxRows,
        maxBytes: body.maxBytes,
        maxSessions: body.maxSessions,
        skipSessionIds: body.skipSessionIds.length,
      });
      const result = await runProjectDataGroupedFtsWallRecovery(c.env, projectId, {
        reason: body.reason,
        dryRun: body.dryRun,
        maxRows: body.maxRows,
        maxBytes: body.maxBytes,
        maxSessions: body.maxSessions,
        skipSessionIds: body.skipSessionIds,
      });
      return c.json({ result });
    }
  );
}
