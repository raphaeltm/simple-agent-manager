/**
 * Statements behind Insights · People (`insights-people.ts`). Every statement binds the project in
 * its predicate (rule 11); every join carries its own project condition.
 *
 * Who an open item waits on: the assignee of a person's item, the member who took a team task,
 * or nobody (`waiter` NULL) for a team item no one has taken.
 *
 * What the viewer may see of an item mirrors the Inbox's own read rule
 * (`inbox-item-core.ts readStoreRow`): a person's item is readable by that person, a team item by
 * every member, a task also by its filer. Of an item the viewer may not read, only its age and
 * waiter are selected (no title, kind or flags), so the rest cannot leave D1.
 */
import { INSIGHTS_PEOPLE_ASK_KINDS } from '@simple-agent-manager/shared';

import { TASK_FILER_SQL, TASK_WRITABLE_SQL } from './inbox-task-rows';
import type { FlowStatement } from './insights-flow-sql';

const KINDS_SQL = INSIGHTS_PEOPLE_ASK_KINDS.map((kind) => `'${kind}'`).join(', ');

const WAITER_SQL = `CASE WHEN a.assignee_kind = 'user' THEN a.assignee_user_id
  WHEN a.assignee_kind = 'team' THEN a.claimed_by_user_id END`;

/** Open, unexpired items of the people-facing kinds (bind: projectId, nowMs). */
const OPEN_WHERE_SQL = `a.project_id = ? AND a.status = 'open' AND a.kind IN (${KINDS_SQL})
  AND (a.expires_at IS NULL OR a.expires_at > ?)`;

/**
 * Open items per waiter, with the waiter's display name. A name is shown only for an active
 * member of this project; anyone else (a departed member) reads as a former member.
 */
export function waitingGroupsStatement(projectId: string, nowMs: number): FlowStatement {
  return {
    sql: `SELECT g.waiter, g.open, g.blocking, g.oldest,
        CASE WHEN pm.user_id IS NOT NULL THEN u.name END AS name,
        CASE WHEN pm.user_id IS NOT NULL THEN 1 ELSE 0 END AS member
      FROM (
        SELECT ${WAITER_SQL} AS waiter, COUNT(*) AS open, TOTAL(a.blocking) AS blocking,
          MIN(a.created_at) AS oldest
        FROM asks a
        WHERE ${OPEN_WHERE_SQL}
        GROUP BY waiter
      ) g
      LEFT JOIN project_members pm ON pm.project_id = ? AND pm.user_id = g.waiter
        AND pm.status = 'active'
      LEFT JOIN users u ON u.id = pm.user_id
      ORDER BY g.oldest, g.waiter`,
    binds: [projectId, nowMs, projectId],
  };
}

/**
 * The oldest `listed` open items per waiter. `readable` and `can_reassign` are decided here,
 * against the viewer, with the same predicates the Inbox uses; `writerRoles` are the project roles
 * holding `task:write`.
 */
export function waitingItemsStatement(
  projectId: string,
  nowMs: number,
  viewerId: string,
  writerRoles: readonly string[],
  listed: number
): FlowStatement {
  const roles = writerRoles.length > 0 ? writerRoles.map(() => '?').join(', ') : 'NULL';
  // `ranked` is a thin window over every open ask (id, waiter, order). Only the `listed` rows per
  // waiter are joined back and evaluated, and the viewer's role is read once. The outer select
  // returns only the age and waiter of an item the viewer may not read.
  return {
    sql: `WITH ranked AS (
        SELECT a.id, ${WAITER_SQL} AS waiter,
          ROW_NUMBER() OVER (PARTITION BY ${WAITER_SQL} ORDER BY a.created_at, a.id) AS rn
        FROM asks a
        WHERE ${OPEN_WHERE_SQL}
      ),
      viewer AS (
        SELECT (SELECT pm.role FROM project_members pm WHERE pm.project_id = ? AND pm.user_id = ?
          AND pm.status = 'active') AS role
      ),
      picked AS (
        SELECT a.id, a.created_at, r.waiter, a.kind AS raw_kind, a.blocking AS raw_blocking,
          a.title AS raw_title,
          CASE WHEN a.assignee_kind = 'team' AND a.claimed_by_user_id IS NOT NULL THEN 1 ELSE 0
            END AS raw_claimed,
          CASE WHEN a.assignee_kind = 'team' OR a.assignee_user_id = ?
              OR (a.kind = 'task' AND ${TASK_FILER_SQL} = ?) THEN 1 ELSE 0 END AS readable,
          CASE WHEN a.kind = 'task' AND (SELECT role FROM viewer) IN (${roles})
              AND ${TASK_WRITABLE_SQL} THEN 1 ELSE 0 END AS can_reassign
        FROM ranked r
        JOIN asks a ON a.id = r.id AND a.project_id = ?
        WHERE r.rn <= ?
      )
      SELECT id, created_at, waiter, readable, can_reassign,
        CASE WHEN readable = 1 THEN raw_kind END AS kind,
        CASE WHEN readable = 1 THEN raw_blocking END AS blocking,
        CASE WHEN readable = 1 THEN raw_title END AS title,
        CASE WHEN readable = 1 THEN raw_claimed END AS claimed
      FROM picked
      ORDER BY created_at, id`,
    binds: [
      projectId,
      nowMs,
      projectId,
      viewerId,
      viewerId,
      viewerId,
      ...writerRoles,
      viewerId,
      viewerId,
      viewerId,
      projectId,
      listed,
    ],
  };
}

/** Review request cycles requested in the range, newest first, `cap + 1` to disclose a cut. */
export function reviewCyclesStatement(
  projectId: string,
  since: string,
  until: string,
  cap: number
): FlowStatement {
  return {
    sql: `SELECT requested_at, first_review_at
      FROM pull_request_review_requests
      WHERE project_id = ? AND requested_at >= ? AND requested_at < ? AND removed_at IS NULL
      ORDER BY requested_at DESC
      LIMIT ?`,
    binds: [projectId, since, until, cap + 1],
  };
}

/** When this project's first review request was recorded (history before it is unknown). */
export function reviewRecordedSinceStatement(projectId: string): FlowStatement {
  return {
    sql: `SELECT MIN(requested_at) AS first FROM pull_request_review_requests WHERE project_id = ?`,
    binds: [projectId],
  };
}

/**
 * Closed asks (answered or done) in the range whose first assignee was one person, and how many
 * that person answered with no handoff. Both writers that change an ask's assignee
 * (`reassignTask`, `moveDepartedMemberTasks`) record an `ask_activity` row of kind `reassigned`
 * carrying `fromKind`, so the first `reassigned` row names the original assignee's kind.
 */
export function firstPersonStatement(
  projectId: string,
  sinceMs: number,
  untilMs: number
): FlowStatement {
  const reassigned = `SELECT 1 FROM ask_activity r WHERE r.ask_id = a.id
    AND r.project_id = a.project_id AND r.kind = 'reassigned'`;
  const originalKind = `COALESCE((SELECT json_extract(r.detail_json, '$.fromKind')
      FROM ask_activity r WHERE r.ask_id = a.id AND r.project_id = a.project_id
        AND r.kind = 'reassigned' AND json_valid(r.detail_json)
      ORDER BY r.created_at, r.id LIMIT 1), a.assignee_kind)`;
  return {
    sql: `SELECT COUNT(*) AS closed,
        TOTAL(CASE WHEN a.assignee_kind = 'user' AND a.resolved_by_user_id = a.assignee_user_id
          AND NOT EXISTS (${reassigned}) THEN 1 ELSE 0 END) AS first_person
      FROM asks a
      WHERE a.project_id = ? AND a.status IN ('answered', 'done') AND a.kind IN (${KINDS_SQL})
        AND a.resolved_at >= ? AND a.resolved_at < ?
        AND ${originalKind} = 'user'`,
    binds: [projectId, sinceMs, untilMs],
  };
}
