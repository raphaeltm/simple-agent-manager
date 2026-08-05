import type { Env } from '../env';
import { log } from '../lib/logger';
import { resolveDiagnosticIncidentConfig } from './diagnostic-incident-config';
import { ensurePendingIncidents } from './diagnostic-incidents';

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

interface ReconcileArtifactRow {
  id: string;
  incident_id: string;
  node_id: string;
  status: 'pending' | 'available' | 'failed' | 'expired';
  object_key: string;
  checksum_sha256: string | null;
  expected_bytes: number;
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
    if (
      object &&
      object.size === row.expected_bytes &&
      object.customMetadata?.checksumSha256 === row.checksum_sha256
    ) {
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
  result: DiagnosticIncidentReconciliationResult
): Promise<number> {
  const rows = await env.DATABASE.prepare(
    `SELECT id, incident_id, node_id, status, object_key, checksum_sha256, expected_bytes
     FROM diagnostic_artifacts WHERE status = 'available' ORDER BY updated_at ASC LIMIT ?`
  )
    .bind(limit)
    .all<ReconcileArtifactRow>();
  for (const row of rows.results) {
    result.checked++;
    const object = await env.R2.head(row.object_key);
    if (!object || object.size !== row.expected_bytes) {
      await markFailed(env, row, 'Private artifact object is missing');
      result.failed++;
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

async function reconcileIncidentMetadata(
  env: Env,
  limit: number,
  result: DiagnosticIncidentReconciliationResult
): Promise<void> {
  if (!env.OBSERVABILITY_DATABASE) return;
  const persistedErrors = await env.OBSERVABILITY_DATABASE.prepare(
    `SELECT id, node_id, workspace_id FROM platform_errors
     WHERE source = 'vm-agent' AND level = 'error' ORDER BY created_at DESC LIMIT ?`
  )
    .bind(limit)
    .all<{
      id: string;
      node_id: string | null;
      workspace_id: string | null;
    }>();
  for (const persistedError of persistedErrors.results) {
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
  let remaining = config.reconcileBatchSize;
  const now = new Date();
  try {
    const staleBefore = new Date(
      now.getTime() - config.pendingTimeoutMinutes * 60_000
    ).toISOString();
    remaining -= await reconcilePending(env, remaining, staleBefore, result);
    if (remaining > 0)
      remaining -= await expireArtifacts(env, remaining, now.toISOString(), result);
    if (remaining > 0) remaining -= await reconcileAvailable(env, remaining, result);
    if (remaining > 0) await deleteExpiredMetadata(env, remaining, now.toISOString(), result);
    await reconcileIncidentMetadata(env, config.reconcileBatchSize, result);
  } catch (cause) {
    log.error('diagnostic_incident.reconciliation_failed', {
      error: cause instanceof Error ? cause.message : String(cause),
      ...result,
    });
    throw cause;
  }
  return result;
}
