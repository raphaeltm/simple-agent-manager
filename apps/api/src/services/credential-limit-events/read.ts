/**
 * Read models over `credential_limit_windows`.
 *
 * The producer keys rows by (project, credential reference, window). These
 * readers collapse them into one summary per credential for the project route,
 * the user Settings route and the MCP `get_credential_limits` tool.
 *
 * Scoping is enforced in SQL and tested against a real SQLite engine
 * (`.claude/rules/28`, `.claude/rules/11`): a member sees their own rows plus
 * project- and platform-sourced rows, never another member's personal credential.
 * Malformed rows are skipped, not fatal (`.claude/rules/50`).
 */
import {
  credentialIdFromReference,
  type CredentialLimitCredentialSource,
  type CredentialLimitCredentialSummary,
  type CredentialLimitLevel,
  type CredentialLimitsResponse,
  type CredentialLimitStatus,
  credentialLimitWindowAsOf,
  credentialLimitWindowSortMinutes,
  type CredentialLimitWindowSummary,
  DEFAULT_CREDENTIAL_LIMIT_READ_MAX_ROWS,
  worstCredentialLimitLevel,
} from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { chunk, D1_MAX_BOUND_PARAMETERS } from '../../lib/d1-limits';
import { log } from '../../lib/logger';
import { parsePositiveInt } from '../../lib/route-helpers';
import { composableCredentialReference } from '../default-capacity-pool-helpers';
import {
  CREDENTIAL_REFERENCE_DIGEST_KEY_BYTES,
  credentialLimitReferenceKey,
  encoder,
  isCredentialLimitReferenceDigest,
} from './values';

type WindowReadRow = {
  project_id: string;
  credential_reference: string;
  window_type: string;
  credential_source: string;
  provider: string;
  provider_mode: string;
  agent_type: string | null;
  source: string;
  status: string;
  last_event_level: string;
  utilization_percent: number | null;
  limit_amount: number | null;
  remaining_amount: number | null;
  window_minutes: number | null;
  resets_at: number | null;
  observed_at: number;
  updated_at: number;
};

const WINDOW_COLUMNS = `project_id, credential_reference, window_type, credential_source, provider,
  provider_mode, agent_type, source, status, last_event_level, utilization_percent, limit_amount,
  remaining_amount, window_minutes, resets_at, observed_at, updated_at`;

const SHARED_CREDENTIAL_SOURCES = "'project', 'platform'";

const LEVELS: ReadonlySet<string> = new Set<CredentialLimitLevel>([
  'ok',
  'warning',
  'critical',
  'rejected',
]);
const STATUSES: ReadonlySet<string> = new Set<CredentialLimitStatus>([
  'allowed',
  'allowed_warning',
  'rejected',
  'unknown',
]);
const SOURCES: ReadonlySet<string> = new Set<CredentialLimitCredentialSource>([
  'user',
  'project',
  'platform',
]);

/**
 * Hard ceiling on the configurable read cap: a misconfigured
 * CREDENTIAL_LIMIT_READ_MAX_ROWS must not turn a UI poll into an unbounded read.
 */
const CREDENTIAL_LIMIT_READ_MAX_ROWS_CEILING = 2000;

function readMaxRows(env: Env): number {
  return Math.min(
    parsePositiveInt(env.CREDENTIAL_LIMIT_READ_MAX_ROWS, DEFAULT_CREDENTIAL_LIMIT_READ_MAX_ROWS),
    CREDENTIAL_LIMIT_READ_MAX_ROWS_CEILING
  );
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

type ParsedRow = {
  credentialReference: string;
  credentialSource: CredentialLimitCredentialSource;
  provider: string;
  providerMode: string;
  agentType: string | null;
  window: CredentialLimitWindowSummary;
};

/** Map one D1 row; returns null (and logs once) when the row is unusable. */
function parseRow(row: WindowReadRow): ParsedRow | null {
  const credentialReference = nonEmptyString(row.credential_reference);
  const windowType = nonEmptyString(row.window_type);
  const provider = nonEmptyString(row.provider);
  const observedAt = finiteOrNull(row.observed_at);
  const credentialSource = SOURCES.has(row.credential_source)
    ? (row.credential_source as CredentialLimitCredentialSource)
    : null;
  if (
    !credentialReference ||
    !windowType ||
    !provider ||
    observedAt === null ||
    !credentialSource
  ) {
    log.warn('credential_limit.read_row_skipped', {
      projectId: row.project_id,
      credentialReference: row.credential_reference,
      windowType: row.window_type,
    });
    return null;
  }
  return {
    credentialReference,
    credentialSource,
    provider,
    providerMode: nonEmptyString(row.provider_mode) ?? 'unknown',
    agentType: nonEmptyString(row.agent_type),
    window: {
      windowType,
      provider,
      source: nonEmptyString(row.source) ?? 'unknown',
      status: STATUSES.has(row.status) ? (row.status as CredentialLimitStatus) : 'unknown',
      level: LEVELS.has(row.last_event_level)
        ? (row.last_event_level as CredentialLimitLevel)
        : 'ok',
      utilizationPercent: finiteOrNull(row.utilization_percent),
      limitAmount: finiteOrNull(row.limit_amount),
      remainingAmount: finiteOrNull(row.remaining_amount),
      windowMinutes: finiteOrNull(row.window_minutes),
      resetsAt: finiteOrNull(row.resets_at),
      observedAt,
      updatedAt: finiteOrNull(row.updated_at) ?? observedAt,
    },
  };
}

/**
 * Group parsed rows per credential. When `collapseAcrossProjects` is set, the
 * newest sample per (credential, window) wins, which is what the user-level view
 * needs because the same credential has one row per project it was used in.
 */
function summarize(
  rows: WindowReadRow[],
  collapseAcrossProjects: boolean,
  now: number
): CredentialLimitCredentialSummary[] {
  const byCredential = new Map<string, CredentialLimitCredentialSummary>();
  const seenWindows = new Set<string>();

  for (const row of rows) {
    const parsed = parseRow(row);
    if (!parsed) continue;
    if (collapseAcrossProjects) {
      const key = `${parsed.credentialReference}\u0000${parsed.window.windowType}`;
      if (seenWindows.has(key)) continue;
      seenWindows.add(key);
    }
    let summary = byCredential.get(parsed.credentialReference);
    if (!summary) {
      summary = {
        credentialReference: parsed.credentialReference,
        credentialId: credentialIdFromReference(parsed.credentialReference),
        credentialName: null,
        credentialSource: parsed.credentialSource,
        provider: parsed.provider,
        providerMode: parsed.providerMode,
        agentType: parsed.agentType,
        level: 'ok',
        observedAt: parsed.window.observedAt,
        windows: [],
      };
      byCredential.set(parsed.credentialReference, summary);
    }
    // A window whose reset passed after its sample reads 0% until the next sample.
    summary.windows.push(credentialLimitWindowAsOf(parsed.window, now));
    summary.observedAt = Math.max(summary.observedAt, parsed.window.observedAt);
    if (!summary.agentType && parsed.agentType) summary.agentType = parsed.agentType;
  }

  const credentials = Array.from(byCredential.values());
  for (const summary of credentials) {
    // Shortest window first (5h before week before month) so chips and MCP
    // summaries read in the order a user burns through them; unknown spans last.
    summary.windows.sort(
      (a, b) =>
        (credentialLimitWindowSortMinutes(a.windowType, a.windowMinutes) ??
          Number.POSITIVE_INFINITY) -
          (credentialLimitWindowSortMinutes(b.windowType, b.windowMinutes) ??
            Number.POSITIVE_INFINITY) || a.windowType.localeCompare(b.windowType)
    );
    summary.level = worstCredentialLimitLevel(summary.windows.map((window) => window.level));
  }
  credentials.sort((a, b) => b.observedAt - a.observedAt);
  return credentials;
}

/**
 * Windows visible to `userId` inside `projectId`: the caller's own rows plus
 * project- and platform-sourced rows. Optionally narrowed to one credential.
 * Digest-keyed rows get their real reference back only for the caller's own
 * credentials, with or without the narrowing.
 */
export async function listProjectCredentialLimits(
  env: Env,
  input: { projectId: string; userId: string; credentialReference?: string | null }
): Promise<CredentialLimitsResponse> {
  const reference = input.credentialReference?.trim() || null;
  const referenceKey = reference ? await credentialLimitReferenceKey(reference) : null;
  const referenceFilter = referenceKey ? 'AND credential_reference = ?' : '';
  const bindings: unknown[] = [input.projectId, input.userId];
  if (referenceKey) bindings.push(referenceKey);
  bindings.push(readMaxRows(env));

  const result = await env.DATABASE.prepare(
    `SELECT ${WINDOW_COLUMNS}
       FROM credential_limit_windows
      WHERE project_id = ?
        AND (user_id = ? OR credential_source IN (${SHARED_CREDENTIAL_SOURCES}))
        ${referenceFilter}
      ORDER BY observed_at DESC, credential_reference ASC, window_type ASC
      LIMIT ?`
  )
    .bind(...bindings)
    .all<WindowReadRow>();

  const now = Date.now();
  const credentials = summarize(result.results ?? [], false, now);
  // The filtered read restores only the caller's own credentials too: the
  // session filter resolves any project member's session, and a backfilled id
  // embeds the legacy ciphertext, so another member's credential stays a digest.
  await restoreOwnCredentialReferences(env, credentials, input.userId);
  await attachOwnCredentialNames(env, credentials, input.userId);
  return { credentials, generatedAt: now };
}

/** The caller's personal credentials across every project, newest sample per window. */
export async function listUserCredentialLimits(
  env: Env,
  input: { userId: string }
): Promise<CredentialLimitsResponse> {
  const result = await env.DATABASE.prepare(
    `SELECT ${WINDOW_COLUMNS}
       FROM credential_limit_windows
      WHERE user_id = ?
        AND credential_source = 'user'
      ORDER BY observed_at DESC, credential_reference ASC, window_type ASC
      LIMIT ?`
  )
    .bind(input.userId, readMaxRows(env))
    .all<WindowReadRow>();

  const now = Date.now();
  const credentials = summarize(result.results ?? [], true, now);
  await restoreOwnCredentialReferences(env, credentials, input.userId);
  await attachOwnCredentialNames(env, credentials, input.userId);
  return { credentials, generatedAt: now };
}

/** One statement's bound parameters, less the user id and the row cap. */
const REFERENCE_CHUNK = D1_MAX_BOUND_PARAMETERS - 2;

/**
 * Windows recorded for these references of the caller's own credentials, in every project and
 * from every source, newest sample per window. The Connector's usage read already knows which of
 * the caller's references back each profile, so it reads exactly those rows: the
 * `idx_credential_limit_windows_credential_window_observed` index serves it, and other
 * credentials' rows can never crowd a rarely used account out of the row cap. `user_id = ?` keeps
 * another member's rows out even if a reference were shared.
 */
export async function listOwnCredentialLimitsByReferences(
  env: Env,
  input: { userId: string; references: readonly string[] }
): Promise<CredentialLimitsResponse> {
  const referenceByKey = new Map<string, string>();
  for (const reference of new Set(input.references)) {
    const key = await credentialLimitReferenceKey(reference);
    if (key) referenceByKey.set(key, reference);
  }
  const keys = [...referenceByKey.keys()];
  const maxRows = readMaxRows(env);
  const results = await Promise.all(
    chunk(keys, REFERENCE_CHUNK).map((batch) =>
      env.DATABASE.prepare(
        `SELECT ${WINDOW_COLUMNS}
           FROM credential_limit_windows
          WHERE user_id = ?
            AND credential_reference IN (${batch.map(() => '?').join(', ')})
          ORDER BY observed_at DESC, credential_reference ASC, window_type ASC
          LIMIT ?`
      )
        .bind(input.userId, ...batch, maxRows)
        .all<WindowReadRow>()
    )
  );
  const rows = results.flatMap((result) => result.results ?? []);
  rows.sort((a, b) => (b.observed_at ?? 0) - (a.observed_at ?? 0));
  const now = Date.now();
  const credentials = summarize(rows, true, now);
  restoreCredentialReferences(credentials, referenceByKey);
  return { credentials, generatedAt: now };
}

/**
 * Put the real reference and credential id back on summaries whose rows are
 * keyed by a digest (`credentialLimitReferenceKey`), so callers can match them
 * to credentials (Settings matches by `credentialId`).
 */
function restoreCredentialReferences(
  credentials: CredentialLimitCredentialSummary[],
  referencesByKey: ReadonlyMap<string, string>
): void {
  for (const credential of credentials) {
    const reference = referencesByKey.get(credential.credentialReference);
    if (!reference) continue;
    credential.credentialReference = reference;
    credential.credentialId = credentialIdFromReference(reference);
  }
}

/**
 * Longest credential id whose `cc_credentials:` reference is still its own key.
 * Only longer ids are stored by digest, so only they can need restoring.
 */
const LONGEST_SELF_KEYED_CREDENTIAL_ID_BYTES =
  CREDENTIAL_REFERENCE_DIGEST_KEY_BYTES -
  encoder.encode(composableCredentialReference('')).byteLength;

/**
 * Restore digest-keyed summaries for the caller's own composable credentials.
 * Costs one indexed D1 read, only when a digest key is present. It reads only
 * ids long enough to be stored by digest, so the row cap is not spent on short
 * ids (which sort first) and a user with many credentials still gets theirs
 * back. Another member's credential stays a digest with no id.
 */
async function restoreOwnCredentialReferences(
  env: Env,
  credentials: CredentialLimitCredentialSummary[],
  userId: string
): Promise<void> {
  if (
    !credentials.some((credential) =>
      isCredentialLimitReferenceDigest(credential.credentialReference)
    )
  ) {
    return;
  }
  const rows = await env.DATABASE.prepare(
    `SELECT id FROM cc_credentials
      WHERE owner_id = ? AND length(CAST(id AS BLOB)) > ?
      ORDER BY id LIMIT ?`
  )
    .bind(userId, LONGEST_SELF_KEYED_CREDENTIAL_ID_BYTES, readMaxRows(env))
    .all<{ id: unknown }>();
  const referencesByKey = new Map<string, string>();
  for (const row of rows.results ?? []) {
    if (typeof row.id !== 'string' || row.id === '') continue;
    const reference = composableCredentialReference(row.id);
    const key = await credentialLimitReferenceKey(reference);
    if (key && key !== reference) referencesByKey.set(key, reference);
  }
  restoreCredentialReferences(credentials, referencesByKey);
}

/** One statement's bound parameters, less the owner id. Beyond it, the least recent go unnamed. */
const MAX_NAMED_CREDENTIAL_IDS = D1_MAX_BOUND_PARAMETERS - 1;

/**
 * Attach the Settings name of each of the caller's own composable credentials,
 * so the usage panel can say which account it is. One indexed D1 read, skipped
 * when no summary has a credential id. Another member's credential keeps a null
 * name: the owner predicate is in SQL, so their naming never leaks.
 */
async function attachOwnCredentialNames(
  env: Env,
  credentials: CredentialLimitCredentialSummary[],
  userId: string
): Promise<void> {
  const ids = [
    ...new Set(
      credentials
        .map((credential) => credential.credentialId)
        .filter((id): id is string => Boolean(id))
    ),
  ].slice(0, MAX_NAMED_CREDENTIAL_IDS);
  if (ids.length === 0) return;
  const rows = await env.DATABASE.prepare(
    `SELECT id, name FROM cc_credentials
      WHERE owner_id = ? AND id IN (${ids.map(() => '?').join(', ')})`
  )
    .bind(userId, ...ids)
    .all<{ id: unknown; name: unknown }>();
  const namesById = new Map<string, string>();
  for (const row of rows.results ?? []) {
    const name = nonEmptyString(row.name);
    if (typeof row.id === 'string' && name) namesById.set(row.id, name.trim());
  }
  for (const credential of credentials) {
    if (credential.credentialId) {
      credential.credentialName = namesById.get(credential.credentialId) ?? null;
    }
  }
}

/**
 * Credential reference recorded for an agent session, bound to the project
 * through the session's workspace. Null when unknown or outside the project.
 */
export async function resolveAgentSessionCredentialReference(
  env: Env,
  input: { projectId: string; agentSessionId: string }
): Promise<string | null> {
  const row = await env.DATABASE.prepare(
    `SELECT s.agent_credential_reference AS credential_reference
       FROM agent_sessions s
       JOIN workspaces w ON w.id = s.workspace_id
      WHERE s.id = ?
        AND w.project_id = ?
      LIMIT 1`
  )
    .bind(input.agentSessionId, input.projectId)
    .first<{ credential_reference: string | null }>();
  return nonEmptyString(row?.credential_reference ?? null);
}
