import type { Env } from '../env';
import { log } from '../lib/logger';
import * as projectDataService from './project-data';
import { hasRestorableSleepingSessionSnapshot } from './session-snapshots';

export type WorkspaceLifecycleClosureStatus = 'completed' | 'stopped' | 'failed' | 'error';

interface WorkspaceLifecycleRow {
  id: string;
  project_id: string | null;
  chat_session_id: string | null;
}

export interface FinalizeWorkspaceLifecycleClosureInput {
  /**
   * Explicit workspaces to finalize. Use this when a hard-delete path is about
   * to remove the workspace rows and the node selector would no longer be
   * available afterwards.
   */
  workspaceIds?: readonly string[];
  /** Finalize every workspace currently attached to this node. */
  nodeId?: string | null;
  /** Optional tenant scope for defensive D1 updates. */
  userId?: string | null;
  /** Terminal agent-session status to write for non-terminal rows. */
  agentSessionStatus?: WorkspaceLifecycleClosureStatus;
  /** Optional error detail used only for failed/error closures. */
  errorMessage?: string | null;
  /** Stable timestamp for callers that already claimed a teardown instant. */
  nowIso?: string;
  /** Whether to stop/fail ProjectData chat sessions and drive session-summary sync. */
  stopProjectSessions?: boolean;
  /** Whether to delete ProjectData workspace activity rows. */
  cleanupWorkspaceActivity?: boolean;
  /** Whether to close open compute usage rows. */
  endComputeUsage?: boolean;
  /** Diagnostic reason for logs. */
  reason?: string;
}

export interface FinalizeWorkspaceLifecycleClosureResult {
  workspaces: number;
  agentSessionsClosed: number;
  computeUsageClosed: number;
  projectSessionsClosed: number;
  projectSessionErrors: number;
  workspaceActivityCleaned: number;
  workspaceActivityErrors: number;
}

const D1_BINDING_CHUNK_SIZE = 50;
const TERMINAL_AGENT_SESSION_STATUSES = ['completed', 'failed', 'stopped', 'error'] as const;

function uniqueNonEmpty(values: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function mutationChanges(result: D1Result<unknown>): number {
  return typeof result.meta?.changes === 'number' ? result.meta.changes : 0;
}

async function loadWorkspaceRows(
  env: Env,
  input: FinalizeWorkspaceLifecycleClosureInput
): Promise<WorkspaceLifecycleRow[]> {
  const rows = new Map<string, WorkspaceLifecycleRow>();
  const explicitWorkspaceIds = uniqueNonEmpty(input.workspaceIds ?? []);

  for (let i = 0; i < explicitWorkspaceIds.length; i += D1_BINDING_CHUNK_SIZE) {
    const chunk = explicitWorkspaceIds.slice(i, i + D1_BINDING_CHUNK_SIZE);
    const userScope = input.userId ? ' AND user_id = ?' : '';
    const result = await env.DATABASE.prepare(
      `SELECT id, project_id, chat_session_id
       FROM workspaces
       WHERE id IN (${placeholders(chunk.length)})${userScope}`
    )
      .bind(...chunk, ...(input.userId ? [input.userId] : []))
      .all<WorkspaceLifecycleRow>();

    for (const row of result.results) rows.set(row.id, row);
  }

  if (input.nodeId) {
    const userScope = input.userId ? ' AND user_id = ?' : '';
    const result = await env.DATABASE.prepare(
      `SELECT id, project_id, chat_session_id
       FROM workspaces
       WHERE node_id = ?${userScope}`
    )
      .bind(input.nodeId, ...(input.userId ? [input.userId] : []))
      .all<WorkspaceLifecycleRow>();

    for (const row of result.results) rows.set(row.id, row);
  }

  return [...rows.values()];
}

async function closeAgentSessions(
  env: Env,
  workspaceIds: readonly string[],
  input: FinalizeWorkspaceLifecycleClosureInput,
  nowIso: string
): Promise<number> {
  const status = input.agentSessionStatus ?? 'completed';
  let closed = 0;

  for (let i = 0; i < workspaceIds.length; i += D1_BINDING_CHUNK_SIZE) {
    const chunk = workspaceIds.slice(i, i + D1_BINDING_CHUNK_SIZE);
    const userScope = input.userId ? ' AND user_id = ?' : '';
    const result = await env.DATABASE.prepare(
      `UPDATE agent_sessions
       SET status = ?,
           stopped_at = COALESCE(stopped_at, ?),
           error_message = CASE WHEN ? IS NOT NULL THEN ? ELSE error_message END,
           updated_at = ?
       WHERE workspace_id IN (${placeholders(chunk.length)})
         ${userScope}
         AND status NOT IN (${placeholders(TERMINAL_AGENT_SESSION_STATUSES.length)})`
    )
      .bind(
        status,
        nowIso,
        input.errorMessage ?? null,
        input.errorMessage ?? null,
        nowIso,
        ...chunk,
        ...(input.userId ? [input.userId] : []),
        ...TERMINAL_AGENT_SESSION_STATUSES
      )
      .run();
    closed += mutationChanges(result);
  }

  return closed;
}

async function closeComputeUsage(
  env: Env,
  workspaceIds: readonly string[],
  input: FinalizeWorkspaceLifecycleClosureInput,
  nowIso: string
): Promise<number> {
  if (input.endComputeUsage === false) return 0;
  let closed = 0;

  for (let i = 0; i < workspaceIds.length; i += D1_BINDING_CHUNK_SIZE) {
    const chunk = workspaceIds.slice(i, i + D1_BINDING_CHUNK_SIZE);
    const userScope = input.userId ? ' AND user_id = ?' : '';
    const result = await env.DATABASE.prepare(
      `UPDATE compute_usage
       SET ended_at = ?
       WHERE workspace_id IN (${placeholders(chunk.length)})
         ${userScope}
         AND ended_at IS NULL`
    )
      .bind(nowIso, ...chunk, ...(input.userId ? [input.userId] : []))
      .run();
    closed += mutationChanges(result);
  }

  return closed;
}

async function finalizeProjectDataSession(
  env: Env,
  row: WorkspaceLifecycleRow,
  input: FinalizeWorkspaceLifecycleClosureInput,
  nowIso: string
): Promise<'closed' | 'skipped' | 'failed'> {
  if (input.stopProjectSessions === false) return 'skipped';
  if (!row.project_id || !row.chat_session_id) return 'skipped';

  if (input.agentSessionStatus !== 'failed' && input.agentSessionStatus !== 'error') {
    try {
      // Mirrors claimSessionSnapshotRecovery(): a sleeping, unexpired snapshot is the
      // authoritative wake record. Per rule 66, explicit archive/delete paths remove that
      // snapshot first, so preserving it here does not weaken genuine destructive intent.
      if (
        await hasRestorableSleepingSessionSnapshot(env.DATABASE, env, {
          projectId: row.project_id,
          workspaceId: row.id,
          chatSessionId: row.chat_session_id,
          now: new Date(nowIso),
        })
      ) {
        log.info('workspace_lifecycle_finalizer.project_session_preserved_for_snapshot', {
          workspaceId: row.id,
          projectId: row.project_id,
          sessionId: row.chat_session_id,
          reason: input.reason,
        });
        return 'skipped';
      }
    } catch (err) {
      log.warn('workspace_lifecycle_finalizer.project_session_resumability_lookup_failed', {
        workspaceId: row.id,
        projectId: row.project_id,
        sessionId: row.chat_session_id,
        reason: input.reason,
        error: err instanceof Error ? err.message : String(err),
      });
      return 'failed';
    }
  }

  try {
    if (input.agentSessionStatus === 'failed' || input.agentSessionStatus === 'error') {
      await projectDataService.failSession(
        env,
        row.project_id,
        row.chat_session_id,
        input.errorMessage ?? 'Workspace lifecycle ended'
      );
    } else {
      await projectDataService.stopSession(env, row.project_id, row.chat_session_id);
    }
    return 'closed';
  } catch (err) {
    log.warn('workspace_lifecycle_finalizer.project_session_failed', {
      workspaceId: row.id,
      projectId: row.project_id,
      sessionId: row.chat_session_id,
      reason: input.reason,
      error: err instanceof Error ? err.message : String(err),
    });
    return 'failed';
  }
}

async function cleanupWorkspaceActivity(
  env: Env,
  row: WorkspaceLifecycleRow,
  input: FinalizeWorkspaceLifecycleClosureInput
): Promise<'cleaned' | 'skipped' | 'failed'> {
  if (input.cleanupWorkspaceActivity === false) return 'skipped';
  if (!row.project_id) return 'skipped';

  try {
    await projectDataService.cleanupWorkspaceActivity(env, row.project_id, row.id);
    return 'cleaned';
  } catch (err) {
    log.warn('workspace_lifecycle_finalizer.activity_cleanup_failed', {
      workspaceId: row.id,
      projectId: row.project_id,
      reason: input.reason,
      error: err instanceof Error ? err.message : String(err),
    });
    return 'failed';
  }
}

/**
 * Canonical lifecycle closure fan-out for workspace/node deletion and terminal
 * runtime teardown writers.
 *
 * The function is intentionally idempotent:
 * - agent_sessions only transition out of non-terminal states;
 * - compute_usage only fills a missing `ended_at`;
 * - ProjectData session stop/fail operations are themselves guarded by status.
 *
 * Keep all workspace/node deletion writers routed through this helper so the
 * static writer-inventory test can mechanically catch new unguarded paths.
 */
export async function finalizeWorkspaceLifecycleClosure(
  env: Env,
  input: FinalizeWorkspaceLifecycleClosureInput
): Promise<FinalizeWorkspaceLifecycleClosureResult> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const rows = await loadWorkspaceRows(env, input);
  const workspaceIds = uniqueNonEmpty([
    ...(input.workspaceIds ?? []),
    ...rows.map((row) => row.id),
  ]);

  const result: FinalizeWorkspaceLifecycleClosureResult = {
    workspaces: workspaceIds.length,
    agentSessionsClosed: 0,
    computeUsageClosed: 0,
    projectSessionsClosed: 0,
    projectSessionErrors: 0,
    workspaceActivityCleaned: 0,
    workspaceActivityErrors: 0,
  };

  if (workspaceIds.length === 0) return result;

  result.agentSessionsClosed = await closeAgentSessions(env, workspaceIds, input, nowIso);
  result.computeUsageClosed = await closeComputeUsage(env, workspaceIds, input, nowIso);

  for (const row of rows) {
    const sessionResult = await finalizeProjectDataSession(env, row, input, nowIso);
    if (sessionResult === 'closed') result.projectSessionsClosed++;
    if (sessionResult === 'failed') result.projectSessionErrors++;

    const activityResult = await cleanupWorkspaceActivity(env, row, input);
    if (activityResult === 'cleaned') result.workspaceActivityCleaned++;
    if (activityResult === 'failed') result.workspaceActivityErrors++;
  }

  return result;
}
