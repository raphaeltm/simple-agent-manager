import { Hono } from 'hono';

import type { Env } from '../../env';
import { errors } from '../../middleware/error';
import { getProjectDataArchiveRolloutListConfig } from '../../services/project-data-archive-rollout-controls';

/**
 * Superadmin list of per-project archive-sharding circuit breakers.
 *
 * Mounted at `/api/admin/project-data/storage/archive-sharding/circuit-breakers`.
 * D1-only and bounded: this backs the Admin → Storage tab, which is the
 * phone-usable path for closing a tripped breaker (the POST lives in
 * `project-data-storage.ts` as `/:projectId/archive-sharding/circuit-breaker`).
 */
export const adminProjectDataArchiveBreakerRoutes = new Hono<{ Bindings: Env }>();

const BREAKER_STATES = new Set(['closed', 'open', 'frozen']);

type BreakerRow = {
  project_id: unknown;
  project_name: unknown;
  repository: unknown;
  state: unknown;
  reason: unknown;
  opened_at: unknown;
  updated_at: unknown;
};

export function parseArchiveRolloutLimit(rawLimit: string | undefined, env: Env): number {
  const { defaultLimit, maxLimit } = getProjectDataArchiveRolloutListConfig(env);
  const parsedLimit = rawLimit ? Number.parseInt(rawLimit, 10) : defaultLimit;
  if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > maxLimit) {
    throw errors.badRequest(`limit must be between 1 and ${maxLimit}`);
  }
  return parsedLimit;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

adminProjectDataArchiveBreakerRoutes.get('/', async (c) => {
  const limit = parseArchiveRolloutLimit(c.req.query('limit'), c.env);
  const result = await c.env.DATABASE.prepare(
    `SELECT
       b.project_id,
       p.name AS project_name,
       p.repository AS repository,
       b.state,
       b.reason,
       b.opened_at,
       b.updated_at
     FROM project_data_archive_circuit_breakers b
     LEFT JOIN projects p ON p.id = b.project_id
     ORDER BY CASE WHEN b.state = 'closed' THEN 1 ELSE 0 END ASC, b.updated_at DESC
     LIMIT ?`
  )
    .bind(limit)
    .all<BreakerRow>();

  const breakers = [];
  let skippedRows = 0;
  for (const row of result.results ?? []) {
    const projectId = optionalString(row.project_id);
    const updatedAt = optionalNumber(row.updated_at);
    if (!projectId || updatedAt === null || !BREAKER_STATES.has(String(row.state))) {
      skippedRows += 1;
      continue;
    }
    breakers.push({
      projectId,
      projectName: optionalString(row.project_name),
      repository: optionalString(row.repository),
      state: row.state as 'closed' | 'open' | 'frozen',
      reason: optionalString(row.reason),
      openedAt: optionalNumber(row.opened_at),
      updatedAt,
    });
  }

  return c.json({ breakers, skippedRows, limit });
});
