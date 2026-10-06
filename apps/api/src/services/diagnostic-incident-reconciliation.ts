import type { Env } from '../env';
import { log } from '../lib/logger';
import { acquireArtifactLease, storedObjectMatches } from './diagnostic-artifact-lease';
import { resolveDiagnosticIncidentConfig } from './diagnostic-incident-config';
import { ensurePendingIncidents } from './diagnostic-incidents';

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const INCIDENT_METADATA_SWEEP = 'incident-metadata-observability';
const RECONCILIATION_PHASE_COUNT = 6;

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

async function markPendingAvailable(
  env: Env,
  row: ReconcileArtifactRow,
  leaseId: string,
  updatedAt: string
): Promise<boolean> {
  const results = await env.DATABASE.batch([
    env.DATABASE.prepare(
      `UPDATE diagnostic_artifacts SET status = 'available', actual_bytes = expected_bytes,
       failure_reason = NULL, upload_lease_id = NULL, upload_lease_expires_at = NULL,
       updated_at = ? WHERE id = ? AND status = 'pending' AND upload_lease_id = ?`
    ).bind(updatedAt, row.id, leaseId),
    env.DATABASE.prepare(
      `UPDATE diagnostic_incidents SET status = 'available', total_bytes = ?,
       failure_reason = NULL, updated_at = ? WHERE id = ?
         AND EXISTS (SELECT 1 FROM diagnostic_artifacts
                     WHERE id = ? AND incident_id = ? AND status = 'available')`
    ).bind(row.expected_bytes, updatedAt, row.incident_id, row.id, row.incident_id),
  ]);
  return Number(results[0]?.meta?.changes ?? 0) > 0;
}

async function markPendingFailed(
  env: Env,
  row: ReconcileArtifactRow,
  leaseId: string,
  reason: string,
  updatedAt: string
): Promise<boolean> {
  const results = await env.DATABASE.batch([
    env.DATABASE.prepare(
      `UPDATE diagnostic_artifacts SET status = 'failed', failure_reason = ?,
       upload_lease_id = NULL, upload_lease_expires_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'pending' AND upload_lease_id = ?`
    ).bind(reason, updatedAt, row.id, leaseId),
    env.DATABASE.prepare(
      `UPDATE diagnostic_incidents SET status = 'failed', failure_reason = ?,
       updated_at = ? WHERE id = ?
         AND EXISTS (SELECT 1 FROM diagnostic_artifacts
                     WHERE id = ? AND incident_id = ? AND status = 'failed')`
    ).bind(reason, updatedAt, row.incident_id, row.id, row.incident_id),
  ]);
  return Number(results[0]?.meta?.changes ?? 0) > 0;
}

async function markAvailableFailed(
  env: Env,
  row: ReconcileArtifactRow,
  reason: string,
  updatedAt: string
): Promise<boolean> {
  const results = await env.DATABASE.batch([
    env.DATABASE.prepare(
      `UPDATE diagnostic_artifacts SET status = 'failed', failure_reason = ?, updated_at = ?
       WHERE id = ? AND status = 'available'`
    ).bind(reason, updatedAt, row.id),
    env.DATABASE.prepare(
      `UPDATE diagnostic_incidents SET status = 'failed', failure_reason = ?, updated_at = ?
       WHERE id = ? AND EXISTS (SELECT 1 FROM diagnostic_artifacts
                                WHERE id = ? AND incident_id = ? AND status = 'failed')`
    ).bind(reason, updatedAt, row.incident_id, row.id, row.incident_id),
  ]);
  return Number(results[0]?.meta?.changes ?? 0) > 0;
}

async function reconcilePending(
  env: Env,
  limit: number,
  staleBefore: string,
  result: DiagnosticIncidentReconciliationResult
): Promise<number> {
  const config = resolveDiagnosticIncidentConfig(env);
  const checkedAt = new Date().toISOString();
  const rows = await env.DATABASE.prepare(
    `SELECT id, incident_id, node_id, status, object_key, checksum_sha256, expected_bytes
     FROM diagnostic_artifacts
     WHERE status = 'pending' AND datetime(updated_at) < datetime(?)
       AND (upload_lease_id IS NULL OR datetime(upload_lease_expires_at) <= datetime(?))
     ORDER BY datetime(updated_at) ASC, id ASC LIMIT ?`
  )
    .bind(staleBefore, checkedAt, limit)
    .all<ReconcileArtifactRow>();
  for (const row of rows.results) {
    const lease = await acquireArtifactLease(env, row.id, row.node_id, config, staleBefore);
    if (!lease) continue;
    result.checked++;
    const object = await env.R2.head(row.object_key);
    if (storedObjectMatches(row.expected_bytes, row.checksum_sha256, object)) {
      if (await markPendingAvailable(env, row, lease.id, lease.now)) result.repaired++;
    } else if (
      await markPendingFailed(
        env,
        row,
        lease.id,
        'Upload did not complete before the pending deadline',
        lease.now
      )
    ) {
      result.failed++;
    }
  }
  return rows.results.length;
}

async function reconcileIncidentsWithoutArtifacts(
  env: Env,
  limit: number,
  staleBefore: string,
  now: string,
  result: DiagnosticIncidentReconciliationResult
): Promise<number> {
  const expiring = await env.DATABASE.prepare(
    `SELECT id FROM diagnostic_incidents
     WHERE status <> 'expired' AND datetime(expires_at) <= datetime(?)
       AND NOT EXISTS (SELECT 1 FROM diagnostic_artifacts
                       WHERE incident_id = diagnostic_incidents.id)
     ORDER BY expires_at ASC, id ASC LIMIT ?`
  )
    .bind(now, limit)
    .all<{ id: string }>();
  for (const row of expiring.results) {
    const update = await env.DATABASE.prepare(
      `UPDATE diagnostic_incidents SET status = 'expired', total_bytes = 0,
       preview_json = NULL, failure_reason = NULL, updated_at = ?
       WHERE id = ? AND status <> 'expired' AND datetime(expires_at) <= datetime(?)
         AND NOT EXISTS (SELECT 1 FROM diagnostic_artifacts
                         WHERE incident_id = diagnostic_incidents.id)`
    )
      .bind(now, row.id, now)
      .run();
    if (Number(update.meta?.changes ?? 0) > 0) result.expired++;
  }
  const remaining = Math.max(0, limit - expiring.results.length);
  if (remaining === 0) return expiring.results.length;
  const pending = await env.DATABASE.prepare(
    `SELECT id FROM diagnostic_incidents
     WHERE status = 'pending' AND artifact_count = 0 AND datetime(updated_at) < datetime(?)
       AND NOT EXISTS (SELECT 1 FROM diagnostic_artifacts
                       WHERE incident_id = diagnostic_incidents.id)
     ORDER BY updated_at ASC, id ASC LIMIT ?`
  )
    .bind(staleBefore, remaining)
    .all<{ id: string }>();
  const updatedAt = new Date().toISOString();
  for (const row of pending.results) {
    const update = await env.DATABASE.prepare(
      `UPDATE diagnostic_incidents SET status = 'failed',
       failure_reason = 'Artifact registration did not complete before the pending deadline',
       updated_at = ? WHERE id = ? AND status = 'pending' AND artifact_count = 0
         AND NOT EXISTS (SELECT 1 FROM diagnostic_artifacts
                         WHERE incident_id = diagnostic_incidents.id)`
    )
      .bind(updatedAt, row.id)
      .run();
    if (Number(update.meta?.changes ?? 0) > 0) result.failed++;
  }
  return expiring.results.length + pending.results.length;
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
     WHERE status = 'available' ORDER BY datetime(updated_at) ASC, id ASC LIMIT ?`
  )
    .bind(limit)
    .all<ReconcileArtifactRow>();
  for (const row of rows.results) {
    result.checked++;
    const object = await env.R2.head(row.object_key);
    if (!storedObjectMatches(row.expected_bytes, row.checksum_sha256, object)) {
      if (await markAvailableFailed(env, row, 'Private artifact object is missing', checkedAt)) {
        result.failed++;
      }
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
     WHERE status <> 'expired' AND expires_at <= ?
     ORDER BY expires_at ASC LIMIT ?`
  )
    .bind(now, limit)
    .all<ReconcileArtifactRow>();
  for (const row of rows.results) {
    const results = await env.DATABASE.batch([
      env.DATABASE.prepare(
        `UPDATE diagnostic_artifacts SET status = 'expired', actual_bytes = NULL,
         failure_reason = NULL, upload_lease_id = NULL, upload_lease_expires_at = NULL,
         updated_at = ? WHERE id = ? AND status = ?
           AND (? <> 'pending' OR upload_lease_id IS NULL
                OR datetime(upload_lease_expires_at) <= datetime(?))`
      ).bind(now, row.id, row.status, row.status, now),
      env.DATABASE.prepare(
        `UPDATE diagnostic_incidents SET status = 'expired', total_bytes = 0,
         preview_json = NULL, failure_reason = NULL, updated_at = ? WHERE id = ?
           AND EXISTS (SELECT 1 FROM diagnostic_artifacts
                       WHERE id = ? AND incident_id = ? AND status = 'expired')`
      ).bind(now, row.incident_id, row.id, row.incident_id),
    ]);
    if (Number(results[0]?.meta?.changes ?? 0) === 0) continue;
    await env.R2.delete(row.object_key);
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
    `SELECT id FROM diagnostic_incidents
     WHERE status = 'expired' AND datetime(delete_after) <= datetime(?)
     ORDER BY delete_after ASC LIMIT ?`
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
    await reconcileIncidentsWithoutArtifacts(
      env,
      phaseLimit(config.reconcileBatchSize, 1),
      staleBefore,
      now.toISOString(),
      result
    );
    await expireArtifacts(env, phaseLimit(config.reconcileBatchSize, 2), now.toISOString(), result);
    await deleteExpiredMetadata(
      env,
      phaseLimit(config.reconcileBatchSize, 3),
      now.toISOString(),
      result
    );
    await reconcileIncidentMetadata(env, phaseLimit(config.reconcileBatchSize, 4), result);
    await reconcileAvailable(
      env,
      phaseLimit(config.reconcileBatchSize, 5),
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
