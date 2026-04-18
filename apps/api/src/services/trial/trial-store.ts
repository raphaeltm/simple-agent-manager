/**
 * Trial metadata store (KV-backed).
 *
 * Track A (`POST /api/trial/create`) writes trial records here; Track B
 * (`GET /api/trial/:trialId/events` and `POST /api/trial/claim`) reads them.
 *
 * Keys:
 *   trial:${trialId}               -> TrialRecord (JSON)
 *   trial-by-project:${projectId}  -> trialId  (string)
 *   trial-by-fingerprint:${fpUuid} -> trialId  (string; most-recent active trial)
 *
 * Per-key TTL is derived from `expiresAt` so stale records are evicted
 * automatically by Cloudflare KV.
 */

import type { Env } from '../../env';

/**
 * The canonical trial record. Only fields both tracks agree on live here — any
 * track-specific metadata (VM IP, workspace URL) should live on the workspace
 * row or the project row.
 */
export interface TrialRecord {
  trialId: string;
  projectId: string;
  /** Decoded fingerprint UUID (NOT the signed cookie value). */
  fingerprint: string;
  /** workspace id owned by the trial, if provisioned. Null before workspace_ready. */
  workspaceId: string | null;
  /** Public GitHub repo URL that triggered the trial. */
  repoUrl: string;
  /** epoch ms — when the trial was created (POST /api/trial/create). */
  createdAt: number;
  /** epoch ms — hard expiry; matches TRIAL_WORKSPACE_TTL_MS. */
  expiresAt: number;
  /** true once the user has claimed the project (OAuth callback -> POST /claim). */
  claimed: boolean;
}

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

export function trialKey(trialId: string): string {
  return `trial:${trialId}`;
}
export function trialByProjectKey(projectId: string): string {
  return `trial-by-project:${projectId}`;
}
export function trialByFingerprintKey(fingerprint: string): string {
  return `trial-by-fingerprint:${fingerprint}`;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function readTrial(
  env: Env,
  trialId: string
): Promise<TrialRecord | null> {
  const raw = await env.KV.get(trialKey(trialId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TrialRecord;
  } catch {
    return null;
  }
}

export async function readTrialByProject(
  env: Env,
  projectId: string
): Promise<TrialRecord | null> {
  const trialId = await env.KV.get(trialByProjectKey(projectId));
  if (!trialId) return null;
  return readTrial(env, trialId);
}

export async function readTrialByFingerprint(
  env: Env,
  fingerprint: string
): Promise<TrialRecord | null> {
  const trialId = await env.KV.get(trialByFingerprintKey(fingerprint));
  if (!trialId) return null;
  return readTrial(env, trialId);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Persist/overwrite a trial record, plus its two index keys. Expiration is
 * auto-set to `record.expiresAt` so KV purges stale records.
 */
export async function writeTrial(env: Env, record: TrialRecord): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const ttlSec = Math.max(60, Math.floor(record.expiresAt / 1000) - nowSec);
  const json = JSON.stringify(record);
  await Promise.all([
    env.KV.put(trialKey(record.trialId), json, { expirationTtl: ttlSec }),
    env.KV.put(trialByProjectKey(record.projectId), record.trialId, {
      expirationTtl: ttlSec,
    }),
    env.KV.put(trialByFingerprintKey(record.fingerprint), record.trialId, {
      expirationTtl: ttlSec,
    }),
  ]);
}

/** Mark a trial as claimed (idempotent). */
export async function markTrialClaimed(
  env: Env,
  trialId: string
): Promise<TrialRecord | null> {
  const record = await readTrial(env, trialId);
  if (!record) return null;
  if (record.claimed) return record;
  const updated: TrialRecord = { ...record, claimed: true };
  await writeTrial(env, updated);
  return updated;
}
