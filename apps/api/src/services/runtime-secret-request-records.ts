/**
 * Read side of agent secret requests: row → API shape, and the provenance a collected project
 * runtime value carries. Never touches secret values.
 */
import type {
  RuntimeEnvCollectedProvenance,
  RuntimeSecretRequest,
  RuntimeSecretRequestStatus,
} from '@simple-agent-manager/shared';
import { RUNTIME_SECRET_REQUEST_STATUSES } from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { sanitizeUserInput } from '../lib/sanitize-user-input';

/** Longest display name passed to an agent. A display bound, not a policy limit. */
const AGENT_DISPLAY_NAME_MAX_CHARS = 64;
/** Invisible code points `sanitizeUserInput` keeps: tag characters, soft hyphen, word joiners. */
const INVISIBLE_CHARS = /[\u{E0000}-\u{E007F}\u00AD\u180E\u2060-\u2064\u061C]/gu;

/**
 * A person's display name as agents see it (outcome notices, `list_runtime_env`). It is
 * user-controlled and reaches agent prompts, so control and invisible characters are removed,
 * whitespace collapsed to single spaces, and the length capped. Never falls back to an email.
 */
export function agentSafeDisplayName(name: string | null | undefined): string | null {
  const cleaned = sanitizeUserInput(name ?? '')
    .replace(INVISIBLE_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, AGENT_DISPLAY_NAME_MAX_CHARS);
  return cleaned || null;
}

export type Db = ReturnType<typeof drizzle<typeof schema>>;

export function isoOrNull(ms: number | null | undefined): string | null {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** A pending request past its deadline reads as expired even before the sweep marks it. */
export function effectiveRequestStatus(
  row: Pick<schema.RuntimeSecretRequestRow, 'status' | 'expiresAt'>,
  now = Date.now()
): RuntimeSecretRequestStatus {
  const status = (RUNTIME_SECRET_REQUEST_STATUSES as readonly string[]).includes(row.status)
    ? (row.status as RuntimeSecretRequestStatus)
    : 'expired';
  return status === 'pending' && row.expiresAt <= now ? 'expired' : status;
}

export function toRuntimeSecretRequest(
  row: schema.RuntimeSecretRequestRow,
  resolvedByName: string | null,
  now = Date.now()
): RuntimeSecretRequest {
  return {
    id: row.id,
    projectId: row.projectId,
    envKey: row.envKey,
    reason: row.reason,
    ttlSeconds: row.ttlSeconds ?? null,
    status: effectiveRequestStatus(row, now),
    requestingTaskId: row.requestingTaskId,
    requestingChatSessionId: row.requestingChatSessionId,
    expiresAt: new Date(row.expiresAt).toISOString(),
    createdAt: new Date(row.createdAt).toISOString(),
    resolvedAt: isoOrNull(row.resolvedAt),
    resolvedByName,
    secretExpiresAt: isoOrNull(row.secretExpiresAt),
    replacedExisting: Boolean(row.replacedExisting),
  };
}

/** One request in one project, with the resolver's display name; null when absent. */
export async function loadRuntimeSecretRequest(
  db: Db,
  projectId: string,
  requestId: string
): Promise<{ row: schema.RuntimeSecretRequestRow; resolvedByName: string | null } | null> {
  const rows = await db
    .select({ request: schema.runtimeSecretRequests, resolverName: schema.users.name })
    .from(schema.runtimeSecretRequests)
    .leftJoin(schema.users, eq(schema.users.id, schema.runtimeSecretRequests.resolvedBy))
    .where(
      and(
        eq(schema.runtimeSecretRequests.id, requestId),
        eq(schema.runtimeSecretRequests.projectId, projectId)
      )
    )
    .limit(1);
  const found = rows[0];
  // Defence in depth: the predicate already binds the project (`.claude/rules/11`).
  if (!found || found.request.projectId !== projectId) return null;
  return { row: found.request, resolvedByName: agentSafeDisplayName(found.resolverName) };
}

/** Provenance columns selected alongside a project runtime env row (LEFT JOINs, no bind list). */
export function collectedProvenanceColumns() {
  return {
    requestId: schema.runtimeSecretRequests.id,
    requestReason: schema.runtimeSecretRequests.reason,
    requestTaskId: schema.runtimeSecretRequests.requestingTaskId,
    requestChatSessionId: schema.runtimeSecretRequests.requestingChatSessionId,
    requestResolvedAt: schema.runtimeSecretRequests.resolvedAt,
    requestResolverName: schema.users.name,
  };
}

export interface CollectedProvenanceRow {
  requestId: string | null;
  requestReason: string | null;
  requestTaskId: string | null;
  requestChatSessionId: string | null;
  requestResolvedAt: number | null;
  requestResolverName: string | null;
}

export function toCollectedProvenance(
  row: CollectedProvenanceRow
): RuntimeEnvCollectedProvenance | null {
  if (!row.requestId) return null;
  return {
    requestId: row.requestId,
    reason: row.requestReason ?? '',
    requestingTaskId: row.requestTaskId ?? '',
    requestingChatSessionId: row.requestChatSessionId ?? '',
    suppliedByName: agentSafeDisplayName(row.requestResolverName),
    suppliedAt: isoOrNull(row.requestResolvedAt),
  };
}
