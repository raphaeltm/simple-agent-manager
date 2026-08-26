import { Hono } from 'hono';

import type { Env } from '../../env';
import { errors } from '../../middleware/error';
import { parseOptionalBody, ProjectDataStorageEmergencyPurgeSchema } from '../../schemas';
import {
  measureProjectDataStorage,
  runProjectDataStorageEmergencyPurge,
} from '../../services/project-data';

const PROJECT_DATA_STORAGE_STATUSES = new Set([
  'ok',
  'notice',
  'warning',
  'critical',
  'degraded',
]);
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

function parseStorageTelemetryLimit(
  rawLimit: string | undefined,
  env: Env
): number {
  const { defaultLimit, maxLimit } = getStorageTelemetryListConfig(env);
  const parsedLimit = rawLimit ? Number.parseInt(rawLimit, 10) : defaultLimit;
  if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > maxLimit) {
    throw errors.badRequest(`limit must be between 1 and ${maxLimit}`);
  }
  return parsedLimit;
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
 * POST /api/admin/project-data/storage/:projectId/measure - Force a measurement.
 */
adminProjectDataStorageRoutes.post('/:projectId/measure', async (c) => {
  const { projectId } = c.req.param();
  if (!projectId) throw errors.badRequest('projectId is required');
  const telemetry = await measureProjectDataStorage(c.env, projectId);
  return c.json({ telemetry });
});

/**
 * POST /api/admin/project-data/storage/:projectId/emergency-purge
 *
 * Explicit superadmin-only recovery path. Deletes only bounded batches of
 * oldest ProjectData event-log rows (activity_events and acp_session_events).
 */
adminProjectDataStorageRoutes.post('/:projectId/emergency-purge', async (c) => {
  const { projectId } = c.req.param();
  if (!projectId) throw errors.badRequest('projectId is required');
  const body = await parseOptionalBody(c.req.raw, ProjectDataStorageEmergencyPurgeSchema, {});
  const result = await runProjectDataStorageEmergencyPurge(c.env, projectId, body);
  return c.json({ result });
});
