import { Hono } from 'hono';

import { resolveStorageSafetyConfig } from '../../durable-objects/project-data/storage-safety';
import { ProjectDataManualToolPayloadCleanupStateError } from '../../durable-objects/project-data/tool-payload-cleanup-types';
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
  ProjectDataManualToolPayloadCleanupSchema,
  ProjectDataStorageEmergencyPurgeSchema,
  ProjectDataStorageReliefMeasureSchema,
} from '../../schemas';
import {
  measureProjectDataStorage,
  measureProjectDataStorageRelief,
  runProjectDataGroupedFtsCleanup,
  runProjectDataManualToolPayloadCleanup,
  runProjectDataStorageEmergencyPurge,
} from '../../services/project-data';
import {
  freezeProjectDataArchiveProject,
  getProjectDataArchiveManualCanaryConfig,
  getProjectDataArchiveRolloutListConfig,
  getProjectDataArchiveRolloutState,
  listProjectDataArchiveProblemMigrations,
  setProjectDataArchiveCircuitBreaker,
} from '../../services/project-data-archive-rollout-controls';

const PROJECT_DATA_STORAGE_STATUSES = new Set(['ok', 'notice', 'warning', 'critical', 'degraded']);
const PROJECT_DATA_STORAGE_CLEANUP_HEALTH_STATES = new Set([
  'not_needed',
  'running',
  'target_reached',
  'target_unreachable',
  'failed',
]);
const DEFAULT_STORAGE_TELEMETRY_LIST_LIMIT = 50;
const DEFAULT_STORAGE_TELEMETRY_LIST_MAX = 200;

export const adminProjectDataStorageRoutes = new Hono<{ Bindings: Env }>();

function parsePositiveIntegerConfig(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
  return parsed;
}

function getStorageTelemetryListConfig(env: Env): { defaultLimit: number; maxLimit: number } {
  const maxLimit = parsePositiveIntegerConfig(
    env.PROJECT_DATA_STORAGE_TELEMETRY_LIST_LIMIT_MAX,
    DEFAULT_STORAGE_TELEMETRY_LIST_MAX
  );
  const configuredDefault = parsePositiveIntegerConfig(
    env.PROJECT_DATA_STORAGE_TELEMETRY_LIST_LIMIT_DEFAULT,
    DEFAULT_STORAGE_TELEMETRY_LIST_LIMIT
  );
  return {
    defaultLimit: Math.min(configuredDefault, maxLimit),
    maxLimit,
  };
}

function parseStorageTelemetryLimit(rawLimit: string | undefined, env: Env): number {
  const { defaultLimit, maxLimit } = getStorageTelemetryListConfig(env);
  const parsedLimit = rawLimit ? Number.parseInt(rawLimit, 10) : defaultLimit;
  if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > maxLimit) {
    throw errors.badRequest(`limit must be between 1 and ${maxLimit}`);
  }
  return parsedLimit;
}

function parseArchiveRolloutLimit(rawLimit: string | undefined, env: Env): number {
  const { defaultLimit, maxLimit } = getProjectDataArchiveRolloutListConfig(env);
  const parsedLimit = rawLimit ? Number.parseInt(rawLimit, 10) : defaultLimit;
  if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > maxLimit) {
    throw errors.badRequest(`limit must be between 1 and ${maxLimit}`);
  }
  return parsedLimit;
}

function parseArchiveFrozenIntentLimit(rawLimit: string | undefined, env: Env): number {
  const { defaultLimit, maxLimit } = getProjectDataArchiveFrozenIntentInspectionConfig(env);
  const parsedLimit = rawLimit ? Number.parseInt(rawLimit, 10) : defaultLimit;
  if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > maxLimit) {
    throw errors.badRequest(`limit must be between 1 and ${maxLimit}`);
  }
  return parsedLimit;
}

function assertProjectId(projectId: string | undefined): string {
  if (!projectId?.trim()) throw errors.badRequest('projectId is required');
  return projectId.trim();
}

function assertManualToolPayloadCleanupBudgetBounds(
  body: {
    batchRows?: number;
    batchBytes?: number;
    wallTimeMs?: number;
  },
  env: Env
): void {
  const config = resolveStorageSafetyConfig(env);
  if (
    body.batchRows !== undefined &&
    body.batchRows > config.toolPayloadManualCleanupMaxBatchRows
  ) {
    throw errors.badRequest(
      `batchRows must be between 1 and ${config.toolPayloadManualCleanupMaxBatchRows}`
    );
  }
  if (
    body.batchBytes !== undefined &&
    body.batchBytes > config.toolPayloadManualCleanupMaxBatchBytes
  ) {
    throw errors.badRequest(
      `batchBytes must be between 1 and ${config.toolPayloadManualCleanupMaxBatchBytes}`
    );
  }
  if (
    body.wallTimeMs !== undefined &&
    body.wallTimeMs > config.toolPayloadManualCleanupMaxWallTimeMs
  ) {
    throw errors.badRequest(
      `wallTimeMs must be between 1 and ${config.toolPayloadManualCleanupMaxWallTimeMs}`
    );
  }
}

/**
 * GET /api/admin/project-data/storage - Read latest ProjectData storage telemetry.
 *
 * Bounded D1 query only. Force-measure a specific project through the POST
 * endpoint when the row is missing or stale.
 */
adminProjectDataStorageRoutes.get('/', async (c) => {
  const status = c.req.query('status')?.trim();
  if (status && !PROJECT_DATA_STORAGE_STATUSES.has(status)) {
    throw errors.badRequest('status must be ok, notice, warning, critical, or degraded');
  }

  const projectId = c.req.query('projectId')?.trim();
  const limit = parseStorageTelemetryLimit(c.req.query('limit'), c.env);

  const filters: string[] = [];
  const params: Array<string | number> = [];
  if (status) {
    filters.push('t.status = ?');
    params.push(status);
  }
  if (projectId) {
    filters.push('t.project_id = ?');
    params.push(projectId);
  }

  const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  const result = await c.env.DATABASE.prepare(
    `SELECT
       t.project_id,
       p.name AS project_name,
       p.repository AS repository,
       t.measured_at,
       t.database_size_bytes,
       t.limit_bytes,
       t.usage_ratio,
       t.status,
       t.growth_rate_bytes_per_day,
       t.estimated_days_to_limit,
       t.cleanup_health,
       t.reclaimable_bytes,
       t.category_breakdown_json,
       t.last_alarm_at,
       t.last_alert_at,
       t.last_alert_status,
       t.last_alert_reason,
       t.last_purge_at,
       t.last_purge_reason,
       t.last_purge_rows,
       t.last_purge_database_size_bytes,
       t.last_error,
       t.updated_at
     FROM project_data_storage_telemetry t
     LEFT JOIN projects p ON p.id = t.project_id
     ${whereClause}
     ORDER BY t.usage_ratio DESC, t.measured_at DESC
     LIMIT ?`
  )
    .bind(...params, limit)
    .all();

  return c.json({ telemetry: result.results ?? [] });
});

/**
 * GET /api/admin/project-data/storage/history - Read append-only storage history.
 *
 * Bounded D1 query only. Use projectId for a single-project trend or cleanupHealth
 * to find target-unreachable measurements.
 */
adminProjectDataStorageRoutes.get('/history', async (c) => {
  const status = c.req.query('status')?.trim();
  if (status && !PROJECT_DATA_STORAGE_STATUSES.has(status)) {
    throw errors.badRequest('status must be ok, notice, warning, critical, or degraded');
  }

  const cleanupHealth = c.req.query('cleanupHealth')?.trim();
  if (cleanupHealth && !PROJECT_DATA_STORAGE_CLEANUP_HEALTH_STATES.has(cleanupHealth)) {
    throw errors.badRequest(
      'cleanupHealth must be not_needed, running, target_reached, target_unreachable, or failed'
    );
  }

  const projectId = c.req.query('projectId')?.trim();
  const limit = parseStorageTelemetryLimit(c.req.query('limit'), c.env);

  const filters: string[] = [];
  const params: Array<string | number> = [];
  if (status) {
    filters.push('h.status = ?');
    params.push(status);
  }
  if (cleanupHealth) {
    filters.push('h.cleanup_health = ?');
    params.push(cleanupHealth);
  }
  if (projectId) {
    filters.push('h.project_id = ?');
    params.push(projectId);
  }

  const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  const result = await c.env.DATABASE.prepare(
    `SELECT
       h.id,
       h.project_id,
       p.name AS project_name,
       p.repository AS repository,
       h.measured_at,
       h.database_size_bytes,
       h.limit_bytes,
       h.usage_ratio,
       h.status,
       h.growth_rate_bytes_per_day,
       h.estimated_days_to_limit,
       h.cleanup_health,
       h.reclaimable_bytes,
       h.category_breakdown_json,
       h.created_at
     FROM project_data_storage_telemetry_history h
     LEFT JOIN projects p ON p.id = h.project_id
     ${whereClause}
     ORDER BY h.measured_at DESC
     LIMIT ?`
  )
    .bind(...params, limit)
    .all();

  return c.json({ history: result.results ?? [] });
});

/**
 * GET /api/admin/project-data/storage/:projectId/archive-sharding/state
 *
 * D1-only rollout state summary for archive-sharding journal/location/breaker rows.
 */
adminProjectDataStorageRoutes.get('/:projectId/archive-sharding/state', async (c) => {
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
adminProjectDataStorageRoutes.get('/archive-sharding/problem-migrations', async (c) => {
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
adminProjectDataStorageRoutes.post('/:projectId/archive-sharding/canary', async (c) => {
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
adminProjectDataStorageRoutes.post(
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
adminProjectDataStorageRoutes.post(
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
adminProjectDataStorageRoutes.post(
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
adminProjectDataStorageRoutes.get('/:projectId/archive-sharding/frozen-intents', async (c) => {
  const projectId = assertProjectId(c.req.param('projectId'));
  const limit = parseArchiveFrozenIntentLimit(c.req.query('limit'), c.env);
  const result = await inspectFrozenProjectDataArchiveIntents(c.env, { projectId, limit });
  return c.json({ inspections: result.inspections, warnings: result.warnings, limit });
});

/**
 * POST /api/admin/project-data/storage/:projectId/archive-sharding/migrations/:migrationId/copy-back
 */
adminProjectDataStorageRoutes.post(
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
adminProjectDataStorageRoutes.post(
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
        (error.reason === 'abandon_requires_source_intact' ||
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

/**
 * POST /api/admin/project-data/storage/:projectId/measure - Force a measurement.
 */
adminProjectDataStorageRoutes.post('/:projectId/measure', async (c) => {
  const projectId = assertProjectId(c.req.param('projectId'));
  const telemetry = await measureProjectDataStorage(c.env, projectId);
  return c.json({ telemetry });
});

/**
 * POST /api/admin/project-data/storage/:projectId/relief-measure
 *
 * Explicit admin-only, cursor-resumable, bounded measurement of storage relief
 * candidates. This is intentionally not part of alarm measurement.
 */
adminProjectDataStorageRoutes.post('/:projectId/relief-measure', async (c) => {
  const projectId = assertProjectId(c.req.param('projectId'));
  const body = await parseOptionalBody(c.req.raw, ProjectDataStorageReliefMeasureSchema, {});
  const result = await measureProjectDataStorageRelief(c.env, projectId, body);
  return c.json({ result });
});

/**
 * POST /api/admin/project-data/storage/:projectId/tool-payload-cleanup
 *
 * Explicit superadmin-only, project-scoped archival cleanup pass. This control
 * bypasses automatic cleanup enablement but still reuses the
 * archive-confirmed-before-delete cleanup implementation.
 */
adminProjectDataStorageRoutes.post(
  '/:projectId/tool-payload-cleanup',
  jsonValidator(ProjectDataManualToolPayloadCleanupSchema),
  async (c) => {
    const projectId = assertProjectId(c.req.param('projectId'));
    const body = c.req.valid('json');
    assertManualToolPayloadCleanupBudgetBounds(body, c.env);

    try {
      const result = await runProjectDataManualToolPayloadCleanup(c.env, projectId, {
        reason: body.reason.trim(),
        idempotencyKey: body.idempotencyKey.trim(),
        batchRows: body.batchRows,
        batchBytes: body.batchBytes,
        wallTimeMs: body.wallTimeMs,
      });
      return c.json({ result });
    } catch (error) {
      if (error instanceof ProjectDataManualToolPayloadCleanupStateError) {
        if (error.reason === 'idempotency_conflict') {
          throw errors.conflict(error.message);
        }
        throw errors.badRequest(error.message);
      }
      throw error;
    }
  }
);

/**
 * POST /api/admin/project-data/storage/:projectId/grouped-fts-cleanup
 *
 * Explicit canary/scaled cleanup of old terminal-session grouped+FTS derived
 * rows. Production default is disabled by PROJECT_DATA_GROUPED_FTS_CLEANUP_ENABLED=false.
 */
adminProjectDataStorageRoutes.post('/:projectId/grouped-fts-cleanup', async (c) => {
  const projectId = assertProjectId(c.req.param('projectId'));
  const result = await runProjectDataGroupedFtsCleanup(c.env, projectId);
  return c.json({ result });
});

/**
 * POST /api/admin/project-data/storage/:projectId/emergency-purge
 *
 * Explicit superadmin-only recovery path. Deletes only bounded batches of
 * oldest ProjectData event-log rows (activity_events and acp_session_events).
 */
adminProjectDataStorageRoutes.post('/:projectId/emergency-purge', async (c) => {
  const projectId = assertProjectId(c.req.param('projectId'));
  const body = await parseOptionalBody(c.req.raw, ProjectDataStorageEmergencyPurgeSchema, {});
  const result = await runProjectDataStorageEmergencyPurge(c.env, projectId, body);
  return c.json({ result });
});
