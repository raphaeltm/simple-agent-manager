import type { Env } from '../env';
import { errors } from '../middleware/error';
import { resolveDiagnosticIncidentConfig } from './diagnostic-incident-config';
import { redactSensitiveData } from './observability';

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const textEncoder = new TextEncoder();
const DEFAULT_DIAGNOSTIC_DEPLOYMENT_ID = 'unknown-deployment';

export function assertDiagnosticIncidentULID(value: string, label: string): void {
  if (!ULID_PATTERN.test(value)) throw errors.badRequest(`${label} must be a ULID`);
}

function normalizeDiagnosticText(value: string): string {
  return String(redactSensitiveData(value))
    .toLowerCase()
    .replace(/\b[a-z0-9.!#$%&*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi, '[email]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]')
    .replace(/https?:\/\/\S+/g, '[url]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '[id]')
    .replace(/\b01[a-z0-9]{24}\b/gi, '[id]')
    .replace(/\b\d{3,}\b/g, '[n]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', textEncoder.encode(value));
  return [...new Uint8Array(bytes)].map((item) => item.toString(16).padStart(2, '0')).join('');
}

export async function diagnosticIncidentSignature(source: string, message: string): Promise<string> {
  return digest(`${normalizeDiagnosticText(source)}\n${normalizeDiagnosticText(message)}`);
}

export function diagnosticIncidentDeploymentId(env: Env): string {
  const raw = env.VERSION || env.ENVIRONMENT || DEFAULT_DIAGNOSTIC_DEPLOYMENT_ID;
  const sanitized = String(redactSensitiveData(raw)).replace(/\s+/g, '-').trim().slice(0, 128);
  return sanitized || DEFAULT_DIAGNOSTIC_DEPLOYMENT_ID;
}

export interface PendingIncidentInput {
  incidentId: string;
  platformErrorId: string;
  nodeId: string;
  workspaceId: string | null;
  signature?: string;
  deploymentId?: string;
  occurredAt?: number;
}

export interface PendingIncidentResult {
  platformErrorId: string;
  incidentId: string;
  canonicalIncidentId: string;
  duplicate: boolean;
  occurrenceRecorded: boolean;
}

export async function ensurePendingIncidents(
  env: Env,
  inputs: PendingIncidentInput[]
): Promise<PendingIncidentResult[]> {
  const config = resolveDiagnosticIncidentConfig(env);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.retentionDays * 86_400_000).toISOString();
  const deleteAfter = new Date(
    now.getTime() + (config.retentionDays + config.metadataRetentionDays) * 86_400_000
  ).toISOString();
  const results: PendingIncidentResult[] = [];
  for (const input of inputs) {
    assertDiagnosticIncidentULID(input.incidentId, 'incidentId');
    const occurrenceAt = new Date(input.occurredAt ?? now.getTime()).toISOString();
    const signature = input.signature?.trim() || null;
    const deploymentId = input.deploymentId?.trim() || null;
    await env.DATABASE.prepare(
      `INSERT OR IGNORE INTO diagnostic_incidents
       (id, platform_error_id, node_id, workspace_id, signature, deployment_id,
        status, occurrence_count, last_seen_at, expires_at, delete_after)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?, ?)`
    )
      .bind(
        input.incidentId,
        input.platformErrorId,
        input.nodeId,
        input.workspaceId,
        signature,
        deploymentId,
        occurrenceAt,
        expiresAt,
        deleteAfter
      )
      .run();
    const direct = await env.DATABASE.prepare(
      `SELECT id, node_id, platform_error_id, signature, deployment_id
       FROM diagnostic_incidents WHERE id = ?`
    )
      .bind(input.incidentId)
      .first<{
        id: string;
        node_id: string;
        platform_error_id: string;
        signature: string | null;
        deployment_id: string | null;
      }>();
    if (direct) {
      if (
        direct.node_id !== input.nodeId ||
        direct.platform_error_id !== input.platformErrorId ||
        (signature && direct.signature && direct.signature !== signature) ||
        (deploymentId && direct.deployment_id && direct.deployment_id !== deploymentId)
      ) {
        throw errors.conflict('Incident ID is already bound to another error or node');
      }
      if ((signature && !direct.signature) || (deploymentId && !direct.deployment_id)) {
        await env.DATABASE.prepare(
          `UPDATE diagnostic_incidents
           SET signature = COALESCE(signature, ?),
             deployment_id = COALESCE(deployment_id, ?),
             last_seen_at = COALESCE(last_seen_at, ?),
             updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        )
          .bind(signature, deploymentId, occurrenceAt, direct.id)
          .run();
      }
      results.push({
        platformErrorId: input.platformErrorId,
        incidentId: input.incidentId,
        canonicalIncidentId: direct.id,
        duplicate: false,
        occurrenceRecorded: false,
      });
      continue;
    }
    if (!signature || !deploymentId) {
      throw errors.conflict('Incident ID is already bound to another error or node');
    }
    const canonical = await env.DATABASE.prepare(
      `SELECT id FROM diagnostic_incidents
       WHERE signature = ? AND deployment_id = ?
       ORDER BY created_at ASC
       LIMIT 1`
    )
      .bind(signature, deploymentId)
      .first<{ id: string }>();
    if (!canonical) throw errors.internal('Diagnostic incident deduplication lost canonical row');

    const occurrence = await env.DATABASE.prepare(
      `INSERT OR IGNORE INTO diagnostic_incident_occurrences
       (platform_error_id, incident_id, node_id, workspace_id, occurred_at)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind(
        input.platformErrorId,
        canonical.id,
        input.nodeId,
        input.workspaceId,
        occurrenceAt
      )
      .run();
    const occurrenceRecorded = Number(occurrence.meta.changes ?? 0) === 1;
    if (occurrenceRecorded) {
      await env.DATABASE.prepare(
        `UPDATE diagnostic_incidents
         SET occurrence_count = occurrence_count + 1,
           last_seen_at = CASE
             WHEN last_seen_at IS NULL OR last_seen_at < ? THEN ?
             ELSE last_seen_at
           END,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
        .bind(occurrenceAt, occurrenceAt, canonical.id)
        .run();
    }
    results.push({
      platformErrorId: input.platformErrorId,
      incidentId: input.incidentId,
      canonicalIncidentId: canonical.id,
      duplicate: true,
      occurrenceRecorded,
    });
  }
  return results;
}

export async function getCanonicalIncidentIdForOccurrence(
  env: Env,
  platformErrorId: string
): Promise<{ incidentId: string; nodeId: string } | null> {
  const row = await env.DATABASE.prepare(
    'SELECT incident_id, node_id FROM diagnostic_incident_occurrences WHERE platform_error_id = ?'
  )
    .bind(platformErrorId)
    .first<{ incident_id: string; node_id: string }>();
  return row ? { incidentId: row.incident_id, nodeId: row.node_id } : null;
}
