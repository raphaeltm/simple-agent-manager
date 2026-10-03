import { type Hono } from 'hono';

import type { Env } from '../../env';
import { errors } from '../../middleware/error';
import {
  abandonProjectDataArchiveMigration,
  copyBackProjectDataArchiveMigration,
  getProjectDataArchiveFrozenIntentInspectionConfig,
  inspectFrozenProjectDataArchiveIntents,
  ProjectDataArchiveCoordinatorStateError,
  runScopedProjectDataArchiveCanary,
} from '../../scheduled/project-data-archive-sharding';
import {
  jsonValidator,
  parseOptionalBody,
  ProjectDataArchiveCanaryControlSchema,
  ProjectDataArchiveCircuitBreakerSchema,
  ProjectDataArchiveFreezeProjectSchema,
  ProjectDataArchiveRecoveryControlSchema,
} from '../../schemas';
import {
  freezeProjectDataArchiveProject,
  getProjectDataArchiveManualCanaryConfig,
  getProjectDataArchiveRolloutState,
  listProjectDataArchiveProblemMigrations,
  setProjectDataArchiveCircuitBreaker,
} from '../../services/project-data-archive-rollout-controls';
import { parseArchiveRolloutLimit } from './project-data-archive-breakers';
import { assertProjectId } from './project-data-storage-route-helpers';

/** Archive-sharding rollout, canary and recovery controls under /api/admin/project-data/storage. */

function parseArchiveFrozenIntentLimit(rawLimit: string | undefined, env: Env): number {
  const { defaultLimit, maxLimit } = getProjectDataArchiveFrozenIntentInspectionConfig(env);
  const parsedLimit = rawLimit ? Number.parseInt(rawLimit, 10) : defaultLimit;
  if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > maxLimit) {
    throw errors.badRequest(`limit must be between 1 and ${maxLimit}`);
  }
  return parsedLimit;
}

export function registerProjectDataArchiveRoutes(router: Hono<{ Bindings: Env }>): void {
  /**
   * GET /api/admin/project-data/storage/:projectId/archive-sharding/state
   *
   * D1-only rollout state summary for archive-sharding journal/location/breaker rows.
   */
  router.get('/:projectId/archive-sharding/state', async (c) => {
    const projectId = assertProjectId(c.req.param('projectId'));
    const sessionId = c.req.query('sessionId')?.trim() || undefined;
    const limit = parseArchiveRolloutLimit(c.req.query('limit'), c.env);
    const state = await getProjectDataArchiveRolloutState(c.env, { projectId, sessionId, limit });
    return c.json({ state });
  });

  /**
   * GET /api/admin/project-data/storage/archive-sharding/problem-migrations
   *
   * Bounded list of failed/poisoned/frozen archive migrations.
   */
  router.get('/archive-sharding/problem-migrations', async (c) => {
    const projectId = c.req.query('projectId')?.trim() || undefined;
    const sessionId = c.req.query('sessionId')?.trim() || undefined;
    const limit = parseArchiveRolloutLimit(c.req.query('limit'), c.env);
    const result = await listProjectDataArchiveProblemMigrations(c.env, {
      projectId,
      sessionId,
      limit,
    });
    return c.json({ migrations: result.migrations, warnings: result.warnings, limit });
  });

  /**
   * POST /api/admin/project-data/storage/:projectId/archive-sharding/canary
   *
   * Scoped manual archive-sharding dry-run/canary path. Defaults to dry-run.
   * Non-dry canaries fail closed unless exact archive routing is active.
   */
  router.post('/:projectId/archive-sharding/canary', async (c) => {
    const projectId = assertProjectId(c.req.param('projectId'));
    const body = await parseOptionalBody(c.req.raw, ProjectDataArchiveCanaryControlSchema, {});
    if (body.dryRun === false && !body.reason?.trim()) {
      throw errors.badRequest('reason is required when dryRun is false');
    }
    const canaryConfig = getProjectDataArchiveManualCanaryConfig(c.env);
    if (
      body.limit !== undefined &&
      (!Number.isSafeInteger(body.limit) || body.limit < 1 || body.limit > canaryConfig.maxSessions)
    ) {
      throw errors.badRequest(`limit must be between 1 and ${canaryConfig.maxSessions}`);
    }
    if (
      body.wallTimeMs !== undefined &&
      (!Number.isSafeInteger(body.wallTimeMs) ||
        body.wallTimeMs < 1 ||
        body.wallTimeMs > canaryConfig.maxWallTimeMs)
    ) {
      throw errors.badRequest(`wallTimeMs must be between 1 and ${canaryConfig.maxWallTimeMs}`);
    }
    const result = await runScopedProjectDataArchiveCanary(c.env, {
      projectId,
      sessionId: body.sessionId?.trim() || undefined,
      dryRun: body.dryRun ?? true,
      reason: body.reason,
      limit: body.limit,
      wallTimeMs: body.wallTimeMs,
      chunkRows: body.chunkRows,
      chunkBytes: body.chunkBytes,
    });
    if (body.dryRun === false && result.stats.skipReason === 'exact_routing_disabled') {
      throw errors.badRequest(
        'non-dry archive-sharding canary requires exact archive routing to be enabled'
      );
    }
    return c.json({ result });
  });

  /**
   * POST /api/admin/project-data/storage/:projectId/archive-sharding/freeze
   *
   * Freeze a project's archive-sharding candidates and open the project breaker.
   */
  router.post(
    '/:projectId/archive-sharding/freeze',
    jsonValidator(ProjectDataArchiveFreezeProjectSchema),
    async (c) => {
      const projectId = assertProjectId(c.req.param('projectId'));
      const body = c.req.valid('json');
      const result = await freezeProjectDataArchiveProject(c.env, {
        projectId,
        reason: body.reason.trim(),
      });
      return c.json({ result });
    }
  );

  /**
   * POST /api/admin/project-data/storage/:projectId/archive-sharding/circuit-breaker
   *
   * Set the project archive-sharding breaker. Closing it allows future work but
   * deliberately does not thaw already frozen migration rows.
   */
  router.post(
    '/:projectId/archive-sharding/circuit-breaker',
    jsonValidator(ProjectDataArchiveCircuitBreakerSchema),
    async (c) => {
      const projectId = assertProjectId(c.req.param('projectId'));
      const body = c.req.valid('json');
      const result = await setProjectDataArchiveCircuitBreaker(c.env, {
        projectId,
        state: body.state,
        reason: body.reason.trim(),
      });
      return c.json({ result });
    }
  );

  /**
   * POST /api/admin/project-data/storage/:projectId/archive-sharding/unfreeze
   *
   * Alias for closing the project circuit breaker. Frozen migration rows remain
   * frozen until copy-back (source already deleted) or abandon (source intact) resolves them.
   */
  router.post(
    '/:projectId/archive-sharding/unfreeze',
    jsonValidator(ProjectDataArchiveFreezeProjectSchema),
    async (c) => {
      const projectId = assertProjectId(c.req.param('projectId'));
      const body = c.req.valid('json');
      const result = await setProjectDataArchiveCircuitBreaker(c.env, {
        projectId,
        state: 'closed',
        reason: body.reason.trim(),
      });
      return c.json({ result });
    }
  );

  /**
   * GET /api/admin/project-data/storage/:projectId/archive-sharding/frozen-intents
   *
   * Bounded frozen/failed/poisoned inspection using existing DO-local helpers.
   */
  router.get('/:projectId/archive-sharding/frozen-intents', async (c) => {
    const projectId = assertProjectId(c.req.param('projectId'));
    const limit = parseArchiveFrozenIntentLimit(c.req.query('limit'), c.env);
    const result = await inspectFrozenProjectDataArchiveIntents(c.env, { projectId, limit });
    return c.json({ inspections: result.inspections, warnings: result.warnings, limit });
  });

  /**
   * POST /api/admin/project-data/storage/:projectId/archive-sharding/migrations/:migrationId/copy-back
   */
  router.post(
    '/:projectId/archive-sharding/migrations/:migrationId/copy-back',
    jsonValidator(ProjectDataArchiveRecoveryControlSchema),
    async (c) => {
      const projectId = assertProjectId(c.req.param('projectId'));
      const migrationId = c.req.param('migrationId')?.trim();
      if (!migrationId) throw errors.badRequest('migrationId is required');
      const body = c.req.valid('json');
      let result;
      try {
        result = await copyBackProjectDataArchiveMigration(c.env, {
          projectId,
          migrationId,
          reason: body.reason.trim(),
        });
      } catch (error) {
        if (
          error instanceof ProjectDataArchiveCoordinatorStateError &&
          error.reason === 'exact_routing_disabled'
        ) {
          throw errors.badRequest('copy-back requires exact archive routing to be enabled');
        }
        throw error;
      }
      return c.json({ result });
    }
  );

  /**
   * POST /api/admin/project-data/storage/:projectId/archive-sharding/migrations/:migrationId/abandon
   *
   * Abandon a migration that never reached source deletion: drops the partial shard copy and
   * the root source intent, freezes the journal as `operator_abandoned`, and returns the
   * session location to `root` so the session reads again. Migrations past source deletion
   * are refused; those need copy-back.
   */
  router.post(
    '/:projectId/archive-sharding/migrations/:migrationId/abandon',
    jsonValidator(ProjectDataArchiveRecoveryControlSchema),
    async (c) => {
      const projectId = assertProjectId(c.req.param('projectId'));
      const migrationId = c.req.param('migrationId')?.trim();
      if (!migrationId) throw errors.badRequest('migrationId is required');
      const body = c.req.valid('json');
      try {
        const result = await abandonProjectDataArchiveMigration(c.env, {
          projectId,
          migrationId,
          reason: body.reason.trim(),
        });
        return c.json({ result });
      } catch (error) {
        if (
          error instanceof ProjectDataArchiveCoordinatorStateError &&
          (error.reason === 'abandon_reason_required' ||
            error.reason === 'abandon_requires_source_intact' ||
            error.reason === 'abandon_requires_expired_lease' ||
            error.reason === 'migration_project_mismatch' ||
            error.reason === 'journal_missing')
        ) {
          throw errors.badRequest(error.message);
        }
        throw error;
      }
    }
  );
}
