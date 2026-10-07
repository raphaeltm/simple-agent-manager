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
  credentialLimitWindowSortMinutes,
  type CredentialLimitWindowSummary,
  DEFAULT_CREDENTIAL_LIMIT_READ_MAX_ROWS,
  worstCredentialLimitLevel,
} from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { parsePositiveInt } from '../../lib/route-helpers';

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
  collapseAcrossProjects: boolean
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
    summary.windows.push(parsed.window);
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
 */
export async function listProjectCredentialLimits(
  env: Env,
  input: { projectId: string; userId: string; credentialReference?: string | null }
): Promise<CredentialLimitsResponse> {
  const referenceFilter = input.credentialReference ? 'AND credential_reference = ?' : '';
  const bindings: unknown[] = [input.projectId, input.userId];
  if (input.credentialReference) bindings.push(input.credentialReference);
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

  return { credentials: summarize(result.results ?? [], false), generatedAt: Date.now() };
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

  return { credentials: summarize(result.results ?? [], true), generatedAt: Date.now() };
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
