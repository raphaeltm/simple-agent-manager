/**
 * No new workspace placements in the last stretch of a node's absolute lifetime (policy
 * a3780107, 2026-11-03). Past `NODE_ABSOLUTE_MAX_LIFETIME_MS` every session on the node sleeps,
 * and after the leeway a running turn is stopped (`session-sleep-requirement.ts`), so work
 * placed near the ceiling would be cut off almost at once.
 *
 * The condition is "the lifetime sweep will reap this node soon". The signal is the node's age
 * against the same ceiling, over the same population as `sweepMaxLifetimeNodes`
 * (`scheduled/node-cleanup/node-phases.ts`), so the two cannot diverge: a node the sweep never
 * reaps (user-owned, or not auto-provisioned by a task) is never cut off.
 *
 * Enforced in the final atomic reservation (`workspace-admission-sql.ts`) and, as a hint, in the
 * task runner's candidate queries (`task-runner/node-selection.ts`), per rule 69.
 */
import {
  type PlacementAdmissionPolicy,
  resolveWorkspaceAdmissionPolicy,
} from '@simple-agent-manager/scheduler-core';
import {
  DEFAULT_NODE_ABSOLUTE_MAX_LIFETIME_MS,
  DEFAULT_NODE_LIFETIME_ADMISSION_CUTOFF_PERCENT,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import { resolveAdminSetting } from './admin-settings-resolution';

/**
 * The node age at which new placements stop, or null when the cutoff is disabled (0 percent).
 * `resolveAdminSetting` answers its code default during a settings outage, so the cutoff holds.
 */
export async function resolveLifetimeAdmissionCutoffAgeMs(env: Env): Promise<number | null> {
  const lifetimeMs = parsePositiveInt(
    env.NODE_ABSOLUTE_MAX_LIFETIME_MS,
    DEFAULT_NODE_ABSOLUTE_MAX_LIFETIME_MS
  );
  const setting = Number(
    await resolveAdminSetting(env, 'operations.nodeLifetimeAdmissionCutoffPercent')
  );
  const percent =
    Number.isInteger(setting) && setting >= 0 && setting < 100
      ? setting
      : DEFAULT_NODE_LIFETIME_ADMISSION_CUTOFF_PERCENT;
  if (percent === 0) return null;
  return Math.floor((lifetimeMs * (100 - percent)) / 100);
}

/** The admission policy of a new placement, with its lifetime cutoff resolved. */
export async function resolvePlacementAdmissionPolicy(
  env: Env,
  scaling?: Parameters<typeof resolveWorkspaceAdmissionPolicy>[1]
): Promise<PlacementAdmissionPolicy> {
  return {
    ...resolveWorkspaceAdmissionPolicy(env, scaling),
    lifetimeAdmissionCutoffAgeMs: await resolveLifetimeAdmissionCutoffAgeMs(env),
  };
}

/** The node row aliased `alias` is past the cutoff: the lifetime sweep's population and age test. */
function pastCutoffCondition(alias: string): string {
  return `(
             ${alias}.node_class != 'user-owned'
             AND EXISTS (
               SELECT 1 FROM tasks lifetime_task
               WHERE lifetime_task.auto_provisioned_node_id = ${alias}.id
             )
             AND ${alias}.created_at < ?
           )`;
}

function cutoffThreshold(cutoffAgeMs: number, now: Date): string {
  return new Date(now.getTime() - cutoffAgeMs).toISOString();
}

/**
 * `AND NOT (<node is past the cutoff>)` for a query over `nodes` aliased `alias`, or nothing
 * when the cutoff is disabled. The age test is the lifetime sweep's own `created_at < ?`.
 */
export function lifetimeAdmissionCutoffSql(
  alias: string,
  cutoffAgeMs: number | null | undefined,
  now: Date
): { sql: string; binds: string[] } {
  if (cutoffAgeMs == null) return { sql: '', binds: [] };
  return {
    sql: `AND NOT ${pastCutoffCondition(alias)}`,
    binds: [cutoffThreshold(cutoffAgeMs, now)],
  };
}

/**
 * A select-list column `pastLifetimeAdmissionCutoff` (1 or 0), for selection that must record
 * why it passed a node over (`.claude/rules/74`) rather than silently filter it out.
 */
export function pastLifetimeAdmissionCutoffColumnSql(
  alias: string,
  cutoffAgeMs: number | null | undefined,
  now: Date
): { sql: string; binds: string[] } {
  if (cutoffAgeMs == null) return { sql: '0 AS pastLifetimeAdmissionCutoff', binds: [] };
  return {
    sql: `CASE WHEN ${pastCutoffCondition(alias)} THEN 1 ELSE 0 END AS pastLifetimeAdmissionCutoff`,
    binds: [cutoffThreshold(cutoffAgeMs, now)],
  };
}

/** The placement-diagnostics reason for a node passed over by the cutoff. */
export const LIFETIME_ADMISSION_CUTOFF_REASON =
  'Host is in the last part of its lifetime and takes no new workspaces';

/**
 * Whether the cutoff is why a final reservation refused `nodeId`. Read only after a refusal, so a
 * person who chose that node is told the reason (`.claude/rules/74`) instead of a generic one.
 */
export async function isNodePastLifetimeAdmissionCutoff(
  database: D1Database,
  nodeId: string,
  cutoffAgeMs: number | null,
  now = new Date()
): Promise<boolean> {
  if (cutoffAgeMs === null) return false;
  const column = pastLifetimeAdmissionCutoffColumnSql('n', cutoffAgeMs, now);
  const row = await database
    .prepare(`SELECT ${column.sql} FROM nodes n WHERE n.id = ?`)
    .bind(...column.binds, nodeId)
    .first<{ pastLifetimeAdmissionCutoff: number }>();
  return row?.pastLifetimeAdmissionCutoff === 1;
}
