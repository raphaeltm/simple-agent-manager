import type { Env } from '../env';
import type { IncidentConfig } from './diagnostic-incident-config';

export interface ArtifactLease {
  id: string;
  now: string;
  expiresAt: string;
}

export async function acquireArtifactLease(
  env: Env,
  artifactId: string,
  nodeId: string,
  config: IncidentConfig,
  staleBefore?: string
): Promise<ArtifactLease | null> {
  const nowDate = new Date();
  const lease: ArtifactLease = {
    id: crypto.randomUUID(),
    now: nowDate.toISOString(),
    expiresAt: new Date(nowDate.getTime() + config.pendingTimeoutMinutes * 60_000).toISOString(),
  };
  const result = await env.DATABASE.prepare(
    `UPDATE diagnostic_artifacts
     SET upload_lease_id = ?, upload_lease_expires_at = ?, updated_at = ?
     WHERE id = ? AND node_id = ? AND status = 'pending'
       AND (upload_lease_id IS NULL OR datetime(upload_lease_expires_at) <= datetime(?))
       AND (? IS NULL OR datetime(updated_at) < datetime(?))`
  )
    .bind(
      lease.id,
      lease.expiresAt,
      lease.now,
      artifactId,
      nodeId,
      lease.now,
      staleBefore ?? null,
      staleBefore ?? null
    )
    .run();
  return Number(result.meta?.changes ?? 0) > 0 ? lease : null;
}

export async function releaseArtifactLease(
  env: Env,
  artifactId: string,
  leaseId: string,
  updatedAt: string
): Promise<void> {
  await env.DATABASE.prepare(
    `UPDATE diagnostic_artifacts
     SET upload_lease_id = NULL, upload_lease_expires_at = NULL, updated_at = ?
     WHERE id = ? AND status = 'pending' AND upload_lease_id = ?`
  )
    .bind(updatedAt, artifactId, leaseId)
    .run();
}

function nativeChecksumHex(value: ArrayBuffer | undefined): string | null {
  if (!value) return null;
  return [...new Uint8Array(value)].map((part) => part.toString(16).padStart(2, '0')).join('');
}

export function storedObjectMatches(
  expectedBytes: number,
  expectedChecksum: string | null,
  object: R2Object | null
): boolean {
  return (
    object !== null &&
    object.size === expectedBytes &&
    nativeChecksumHex(object.checksums?.sha256) === expectedChecksum
  );
}
