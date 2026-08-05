import type { Env } from '../env';
import { log } from '../lib/logger';
import { resolveDiagnosticIncidentConfig } from './diagnostic-incident-config';
import { ensurePendingIncidents } from './diagnostic-incidents';

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const INCIDENT_METADATA_SWEEP = 'incident-metadata-observability';
const RECONCILIATION_PHASE_COUNT = 5;

interface ReconcileArtifactRow {
  id: string;
  incident_id: string;
  node_id: string;
  status: 'pending' | 'available' | 'failed' | 'expired';
  object_key: string;
  checksum_sha256: string | null;
  expected_bytes: number;
}

interface PersistedErrorRow {
  id: string;
  node_id: string | null;
  workspace_id: string | null;
  created_at: number;
}

export interface DiagnosticIncidentReconciliationResult {
  checked: number;
  repaired: number;
  failed: number;
  expired: number;
  deleted: number;
  incidentMetadataRepaired: number;
}

async function markAvailable(env: Env, row: ReconcileArtifactRow): Promise<void> {
  await env.DATABASE.batch([
    env.DATABASE.prepare(
      `UPDATE diagnostic_artifacts SET status = 'available', actual_bytes = expected_bytes,
       failure_reason = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'`
    ).bind(row.id),
    env.DATABASE.prepare(
      `UPDATE diagnostic_incidents SET status = 'available', total_bytes = ?,
       failure_reason = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).bind(row.expected_bytes, row.incident_id),
  ]);
}

async function markFailed(env: Env, row: ReconcileArtifactRow, reason: string): Promise<void> {
  await env.DATABASE.batch([
    env.DATABASE.prepare(
      `UPDATE diagnostic_artifacts SET status = 'failed', failure_reason = ?,
       updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('pending', 'available')`
    ).bind(reason, row.id),
    env.DATABASE.prepare(
      `UPDATE diagnostic_incidents SET status = 'failed', failure_reason = ?,
       updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('pending', 'available')`
    ).bind(reason, row.incident_id),
  ]);
}

function checksumHex(value: ArrayBuffer | undefined): string | null {
  if (!value) return null;
  return [...new Uint8Array(value)].map((part) => part.toString(16).padStart(2, '0')).join('');
}

function objectMatches(row: ReconcileArtifactRow, object: R2Object | null): boolean {
  return (
    object !== null &&
    object.size === row.expected_bytes &&
    checksumHex(object.checksums?.sha256) === row.checksum_sha256
  );
}

async function reconcilePending(
  env: Env,
  limit: number,
  staleBefore: string,
  result: DiagnosticIncidentReconciliationResult
): Promise<number> {
  const rows = await env.DATABASE.prepare(
    `SELECT id, incident_id, node_id, status, object_key, checksum_sha256, expected_bytes
     FROM diagnostic_artifacts
     WHERE status = 'pending' AND updated_at < ? ORDER BY updated_at ASC LIMIT ?`
  )
    .bind(staleBefore, limit)
    .all<ReconcileArtifactRow>();
  for (const row of rows.results) {
    result.checked++;
    const object = await env.R2.head(row.object_key);
    if (objectMatches(row, object)) {
      await markAvailable(env, row);
      result.repaired++;
    } else {
      if (object) await env.R2.delete(row.object_key);
      await markFailed(env, row, 'Upload did not complete before the pending deadline');
      result.failed++;
    }
  }
  return rows.results.length;
}

async function reconcileAvailable(
  env: Env,
  limit: number,
  checkedAt: string,
  result: DiagnosticIncidentReconciliationResult
): Promise<number> {
  const rows = await env.DATABASE.prepare(
    `SELECT id, incident_id, node_id, status, object_key, checksum_sha256, expected_bytes
     FROM diagnostic_artifacts
     WHERE status = 'available' ORDER BY updated_at ASC, id ASC LIMIT ?`
  )
    .bind(limit)
    .all<ReconcileArtifactRow>();
  for (const row of rows.results) {
    result.checked++;
    const object = await env.R2.head(row.object_key);
    if (!objectMatches(row, object)) {
      await markFailed(env, row, 'Private artifact object is missing');
      result.failed++;
    } else {
      await env.DATABASE.prepare(
        `UPDATE diagnostic_artifacts SET updated_at = ? WHERE id = ? AND status = 'available'`
      )
        .bind(checkedAt, row.id)
        .run();
    }
  }
  return rows.results.length;
}

async function expireArtifacts(
  env: Env,
  limit: number,
  now: string,
  result: DiagnosticIncidentReconciliationResult
): Promise<number> {
  const rows = await env.DATABASE.prepare(
    `SELECT id, incident_id, node_id, status, object_key, checksum_sha256, expected_bytes
     FROM diagnostic_artifacts
     WHERE status <> 'expired' AND expires_at <= ? ORDER BY expires_at ASC LIMIT ?`
  )
    .bind(now, limit)
    .all<ReconcileArtifactRow>();
  for (const row of rows.results) {
    await env.R2.delete(row.object_key);
    await env.DATABASE.batch([
      env.DATABASE.prepare(
        `UPDATE diagnostic_artifacts SET status = 'expired', actual_bytes = NULL,
         failure_reason = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).bind(row.id),
      env.DATABASE.prepare(
        `UPDATE diagnostic_incidents SET status = 'expired', total_bytes = 0,
         preview_json = NULL, failure_reason = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).bind(row.incident_id),
    ]);
    result.expired++;
  }
  return rows.results.length;
}

async function deleteExpiredMetadata(
  env: Env,
  limit: number,
  now: string,
  result: DiagnosticIncidentReconciliationResult
): Promise<number> {
  const incidents = await env.DATABASE.prepare(
    `SELECT id FROM diagnostic_incidents WHERE delete_after <= ? ORDER BY delete_after ASC LIMIT ?`
  )
    .bind(now, limit)
    .all<{ id: string }>();
  for (const incident of incidents.results) {
    const artifacts = await env.DATABASE.prepare(
      'SELECT object_key FROM diagnostic_artifacts WHERE incident_id = ?'
    )
      .bind(incident.id)
      .all<{ object_key: string }>();
    for (const artifact of artifacts.results) await env.R2.delete(artifact.object_key);
    await env.DATABASE.batch([
      env.DATABASE.prepare('DELETE FROM diagnostic_artifacts WHERE incident_id = ?').bind(
        incident.id
      ),
      env.DATABASE.prepare('DELETE FROM diagnostic_incidents WHERE id = ?').bind(incident.id),
    ]);
    result.deleted++;
  }
  return incidents.results.length;
}

async function repairIncidentMetadataRows(
  env: Env,
  rows: PersistedErrorRow[],
  result: DiagnosticIncidentReconciliationResult
): Promise<void> {
  for (const persistedError of rows) {
    if (!persistedError.node_id || !ULID_PATTERN.test(persistedError.id)) continue;
    const existing = await env.DATABASE.prepare('SELECT id FROM diagnostic_incidents WHERE id = ?')
      .bind(persistedError.id)
      .first<{ id: string }>();
    if (existing) continue;
    await ensurePendingIncidents(env, [
      {
        incidentId: persistedError.id,
        platformErrorId: persistedError.id,
        nodeId: persistedError.node_id,
        workspaceId: persistedError.workspace_id,
      },
    ]);
    result.incidentMetadataRepaired++;
  }
}

async function reconcileIncidentMetadata(
  env: Env,
  limit: number,
  result: DiagnosticIncidentReconciliationResult
): Promise<number> {
  if (!env.OBSERVABILITY_DATABASE || limit <= 0) return 0;
  const latestLimit = Math.max(1, Math.floor(limit / 2));
  const sweepLimit = limit - latestLimit;
  const latest = await env.OBSERVABILITY_DATABASE.prepare(
    `SELECT id, node_id, workspace_id, created_at FROM platform_errors
     WHERE source = 'vm-agent' AND level = 'error'
     ORDER BY created_at DESC, id DESC LIMIT ?`
  )
    .bind(latestLimit)
    .all<PersistedErrorRow>();
  await repairIncidentMetadataRows(env, latest.results, result);

  if (sweepLimit <= 0) return latest.results.length;
  const cursor = await env.DATABASE.prepare(
    `SELECT cursor_created_at, cursor_id FROM diagnostic_reconciliation_state WHERE job_key = ?`
  )
    .bind(INCIDENT_METADATA_SWEEP)
    .first<{ cursor_created_at: number | null; cursor_id: string | null }>();
  const sweep = cursor?.cursor_created_at
    ? await env.OBSERVABILITY_DATABASE.prepare(
        `SELECT id, node_id, workspace_id, created_at FROM platform_errors
         WHERE source = 'vm-agent' AND level = 'error'
           AND (created_at > ? OR (created_at = ? AND id > ?))
         ORDER BY created_at ASC, id ASC LIMIT ?`
      )
        .bind(
          cursor.cursor_created_at,
          cursor.cursor_created_at,
          cursor.cursor_id ?? '',
          sweepLimit
        )
        .all<PersistedErrorRow>()
    : await env.OBSERVABILITY_DATABASE.prepare(
        `SELECT id, node_id, workspace_id, created_at FROM platform_errors
         WHERE source = 'vm-agent' AND level = 'error'
         ORDER BY created_at ASC, id ASC LIMIT ?`
      )
        .bind(sweepLimit)
        .all<PersistedErrorRow>();
  await repairIncidentMetadataRows(env, sweep.results, result);
  const last = sweep.results.at(-1);
  if (last) {
    await env.DATABASE.prepare(
      `INSERT INTO diagnostic_reconciliation_state
       (job_key, cursor_created_at, cursor_id, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(job_key) DO UPDATE SET cursor_created_at = excluded.cursor_created_at,
         cursor_id = excluded.cursor_id, updated_at = CURRENT_TIMESTAMP`
    )
      .bind(INCIDENT_METADATA_SWEEP, last.created_at, last.id)
      .run();
  } else if (cursor) {
    await env.DATABASE.prepare('DELETE FROM diagnostic_reconciliation_state WHERE job_key = ?')
      .bind(INCIDENT_METADATA_SWEEP)
      .run();
  }
  return latest.results.length + sweep.results.length;
}

function phaseLimit(total: number, phase: number): number {
  const base = Math.floor(total / RECONCILIATION_PHASE_COUNT);
  return base + (phase < total % RECONCILIATION_PHASE_COUNT ? 1 : 0);
}

export async function reconcileDiagnosticIncidents(
  env: Env
): Promise<DiagnosticIncidentReconciliationResult> {
  const config = resolveDiagnosticIncidentConfig(env);
  const result: DiagnosticIncidentReconciliationResult = {
    checked: 0,
    repaired: 0,
    failed: 0,
    expired: 0,
    deleted: 0,
    incidentMetadataRepaired: 0,
  };
  const now = new Date();
  try {
    const staleBefore = new Date(
      now.getTime() - config.pendingTimeoutMinutes * 60_000
    ).toISOString();
    await reconcilePending(env, phaseLimit(config.reconcileBatchSize, 0), staleBefore, result);
    await expireArtifacts(env, phaseLimit(config.reconcileBatchSize, 1), now.toISOString(), result);
    await deleteExpiredMetadata(
      env,
      phaseLimit(config.reconcileBatchSize, 2),
      now.toISOString(),
      result
    );
    await reconcileIncidentMetadata(env, phaseLimit(config.reconcileBatchSize, 3), result);
    await reconcileAvailable(
      env,
      phaseLimit(config.reconcileBatchSize, 4),
      now.toISOString(),
      result
    );
  } catch (cause) {
    log.error('diagnostic_incident.reconciliation_failed', {
      error: cause instanceof Error ? cause.message : String(cause),
      ...result,
    });
    throw cause;
  }
  return result;
}
