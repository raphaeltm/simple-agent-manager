/**
 * Trust boundary for Operations-project debugger tools (idea 01M6GGY1QPGG4D40HG0PVGQS3R,
 * policy a35180d5).
 *
 * The Operations project is the project configured as the platform feedback project
 * (`feedback.projectId`, falling back to `PLATFORM_FEEDBACK_PROJECT_ID`). Its agents can be
 * given installation-wide read access, and later approved actions, on nodes, workspaces
 * and sessions that belong to every user. Every debugger tool therefore calls
 * `requireOperationsAccess` on every call, and that gate re-derives each condition from
 * D1 rather than trusting anything cached on the MCP token:
 *
 *   (a) the `operations.debuggerTools` dial allows the capability (`read` needs any mode
 *       except `off`; `act` needs `read_ask` or `read_auto_safe`);
 *   (b) the token's project is the Operations project;
 *   (c) the token is task-scoped;
 *   (d) the human who owns that task is an active superadmin right now.
 *
 * Without (d), any member of the Operations project could read every node in the
 * installation. Listing filters in `tools/list` are a convenience, not a boundary.
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import { ulid } from '../lib/ulid';
import { resolveAdminSetting } from './admin-settings';
import { OPERATIONS_TOOLS_MODES } from './admin-settings-operator-definitions';
import { configuredFeedbackProjectId } from './platform-feedback-incident-config';

export type OperationsToolsMode = (typeof OPERATIONS_TOOLS_MODES)[number];

export type OperationsCapability = 'read' | 'act';

/** Each denial names the single condition that failed (rule 74). */
export type OperationsAccessDenialReason =
  | 'not_operations_project'
  | 'mode_off'
  | 'mode_read_only'
  | 'not_task_scoped'
  | 'task_not_found'
  | 'task_owner_mismatch'
  | 'not_superadmin';

export interface OperationsAccessContext {
  mode: OperationsToolsMode;
  projectId: string;
  taskId: string;
  userId: string;
}

/** The subset of MCP token fields the gate reads. */
export interface OperationsTokenData {
  projectId: string;
  taskId: string;
  userId: string;
  workspaceId?: string;
}

const DENIAL_MESSAGES: Record<OperationsAccessDenialReason, string> = {
  not_operations_project: 'Operations tools are available only inside the Operations project',
  mode_off:
    'Operations tools are turned off on this installation (admin setting operations.debuggerTools)',
  mode_read_only:
    'Operations actions are not enabled: operations.debuggerTools is set to read-only (read)',
  not_task_scoped: 'Operations tools require a task-scoped MCP token',
  task_not_found: 'The task behind this MCP token was not found in the Operations project',
  task_owner_mismatch: 'This MCP token does not belong to the human who owns its task',
  not_superadmin: 'Operations tools require the task owner to be an active superadmin',
};

export class OperationsAccessError extends Error {
  constructor(
    readonly reason: OperationsAccessDenialReason,
    readonly capability: OperationsCapability
  ) {
    super(DENIAL_MESSAGES[reason]);
    this.name = 'OperationsAccessError';
  }
}

function isOperationsToolsMode(value: unknown): value is OperationsToolsMode {
  return typeof value === 'string' && (OPERATIONS_TOOLS_MODES as readonly string[]).includes(value);
}

/** The installation dial. Any unreadable or unexpected value is `off` (fail closed). */
export async function resolveOperationsToolsMode(env: Env): Promise<OperationsToolsMode> {
  try {
    const value = await resolveAdminSetting(env, 'operations.debuggerTools');
    return isOperationsToolsMode(value) ? value : 'off';
  } catch (err) {
    log.error('operations.mode_unavailable', { error: String(err), action: 'fail_closed_off' });
    return 'off';
  }
}

/** True only when a project is configured as the Operations project and it is this one. */
export async function isOperationsProject(env: Env, projectId: string): Promise<boolean> {
  if (!projectId) return false;
  const operationsProjectId = await configuredFeedbackProjectId(env);
  return Boolean(operationsProjectId) && operationsProjectId === projectId;
}

function modeDenial(
  mode: OperationsToolsMode,
  capability: OperationsCapability
): OperationsAccessDenialReason | null {
  if (mode === 'off') return 'mode_off';
  if (capability === 'act' && mode === 'read') return 'mode_read_only';
  return null;
}

/** Condition (d), read from D1 on every call: a cached role must never grant access. */
async function taskOwnerDenial(
  env: Env,
  tokenData: OperationsTokenData
): Promise<OperationsAccessDenialReason | null> {
  const row = await env.DATABASE.prepare(
    `SELECT t.user_id AS ownerUserId, u.role AS role, u.status AS status
     FROM tasks t
     LEFT JOIN users u ON u.id = t.user_id
     WHERE t.id = ? AND t.project_id = ?
     LIMIT 1`
  )
    .bind(tokenData.taskId, tokenData.projectId)
    .first<{ ownerUserId: string | null; role: string | null; status: string | null }>();
  if (!row) return 'task_not_found';
  if (row.ownerUserId !== tokenData.userId) return 'task_owner_mismatch';
  if (row.role !== 'superadmin' || row.status !== 'active') return 'not_superadmin';
  return null;
}

function logDenial(
  tokenData: OperationsTokenData,
  capability: OperationsCapability,
  reason: OperationsAccessDenialReason
): void {
  log.warn('operations.access_denied', {
    reason,
    capability,
    projectId: tokenData.projectId,
    taskId: tokenData.taskId,
    userId: tokenData.userId,
    workspaceId: tokenData.workspaceId,
    action: 'rejected',
  });
}

/**
 * Throws `OperationsAccessError` unless conditions (a)–(d) all hold for this call. The MCP
 * dispatcher maps the error to a JSON-RPC `INVALID_PARAMS` response.
 */
export async function requireOperationsAccess(
  env: Env,
  tokenData: OperationsTokenData,
  { capability }: { capability: OperationsCapability }
): Promise<OperationsAccessContext> {
  const deny = (reason: OperationsAccessDenialReason): never => {
    logDenial(tokenData, capability, reason);
    throw new OperationsAccessError(reason, capability);
  };
  if (!(await isOperationsProject(env, tokenData.projectId))) deny('not_operations_project');
  const mode = await resolveOperationsToolsMode(env);
  const modeReason = modeDenial(mode, capability);
  if (modeReason) deny(modeReason);
  if (!tokenData.taskId) deny('not_task_scoped');
  const ownerReason = await taskOwnerDenial(env, tokenData);
  if (ownerReason) deny(ownerReason);
  return {
    mode,
    projectId: tokenData.projectId,
    taskId: tokenData.taskId,
    userId: tokenData.userId,
  };
}

export interface OperationsAccessStatus {
  operationsProject: boolean;
  /** Omitted outside the Operations project so other projects cannot read the dial. */
  mode?: OperationsToolsMode;
  capabilities: Record<OperationsCapability, boolean>;
  denials: Partial<
    Record<OperationsCapability, { reason: OperationsAccessDenialReason; message: string }>
  >;
}

/** Same conditions as `requireOperationsAccess`, evaluated for both capabilities without throwing. */
export async function getOperationsAccessStatus(
  env: Env,
  tokenData: OperationsTokenData
): Promise<OperationsAccessStatus> {
  const denied = (reason: OperationsAccessDenialReason) => ({
    reason,
    message: DENIAL_MESSAGES[reason],
  });
  if (!(await isOperationsProject(env, tokenData.projectId))) {
    const denial = denied('not_operations_project');
    return {
      operationsProject: false,
      capabilities: { read: false, act: false },
      denials: { read: denial, act: denial },
    };
  }
  const mode = await resolveOperationsToolsMode(env);
  const identityReason = tokenData.taskId
    ? await taskOwnerDenial(env, tokenData)
    : 'not_task_scoped';
  const status: OperationsAccessStatus = {
    operationsProject: true,
    mode,
    capabilities: { read: false, act: false },
    denials: {},
  };
  for (const capability of ['read', 'act'] as const) {
    const reason = modeDenial(mode, capability) ?? identityReason;
    if (reason) status.denials[capability] = denied(reason);
    else status.capabilities[capability] = true;
  }
  return status;
}

// ─── Audit ───────────────────────────────────────────────────────────────────

/** Storage bound for one audit row's `detail`; callers should record sizes and IDs, not payloads. */
export const OPERATIONS_AUDIT_DETAIL_MAX_CHARS = 4_000;

export interface OperationsAuditEntry {
  actorUserId: string;
  taskId: string;
  tool: string;
  targetType: string;
  targetId?: string | null;
  outcome: 'allowed' | 'denied' | 'succeeded' | 'failed' | (string & {});
  detail?: Record<string, unknown> | string | null;
  approvalId?: string | null;
}

function serializeDetail(detail: OperationsAuditEntry['detail']): string | null {
  if (detail === undefined || detail === null) return null;
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
  return text.length > OPERATIONS_AUDIT_DETAIL_MAX_CHARS
    ? text.slice(0, OPERATIONS_AUDIT_DETAIL_MAX_CHARS)
    : text;
}

/**
 * Writes one audit row. Never throws: a failed audit write must not break a read tool,
 * so it is logged at error level with every identifier instead. Returns whether it wrote.
 */
export async function recordOperationsAudit(
  env: Env,
  entry: OperationsAuditEntry
): Promise<boolean> {
  try {
    await env.DATABASE.prepare(
      `INSERT INTO operations_audit_log
         (id, actor_user_id, task_id, tool, target_type, target_id, outcome, detail, approval_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        ulid(),
        entry.actorUserId,
        entry.taskId,
        entry.tool,
        entry.targetType,
        entry.targetId ?? null,
        entry.outcome,
        serializeDetail(entry.detail),
        entry.approvalId ?? null
      )
      .run();
    return true;
  } catch (err) {
    log.error('operations.audit_write_failed', {
      actorUserId: entry.actorUserId,
      taskId: entry.taskId,
      tool: entry.tool,
      targetType: entry.targetType,
      targetId: entry.targetId ?? null,
      outcome: entry.outcome,
      approvalId: entry.approvalId ?? null,
      error: String(err),
    });
    return false;
  }
}

/** Deletes audit rows older than `operations.auditRetentionDays`. Runs from the daily cron. */
export async function purgeExpiredOperationsAudit(
  env: Env,
  now: Date = new Date()
): Promise<{ retentionDays: number; deleted: number }> {
  const retentionDays = Number(await resolveAdminSetting(env, 'operations.auditRetentionDays'));
  if (!Number.isInteger(retentionDays) || retentionDays < 1) return { retentionDays, deleted: 0 };
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const result = await env.DATABASE.prepare('DELETE FROM operations_audit_log WHERE created_at < ?')
    .bind(cutoff)
    .run();
  return { retentionDays, deleted: result.meta?.changes ?? 0 };
}
