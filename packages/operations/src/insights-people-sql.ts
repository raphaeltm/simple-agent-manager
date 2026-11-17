/**
 * Statements behind Insights · People (`insights-people.ts`). Every statement binds the project in
 * its predicate (rule 11); every join carries its own project condition.
 *
 * Who an open item waits on: the assignee of a person's item, the member who took a team task,
 * or nobody (`waiter` NULL) for a team item no one has taken.
 *
 * What the viewer may see of an item mirrors the Inbox's own read rule
 * (`inbox-item-core.ts readStoreRow`): a person's item is readable by that person, a team item by
 * every member, a task also by its filer. The title of an item the viewer may not read is never
 * selected, so it cannot leave D1.
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

/** Open items per waiter, with the waiter's display name. */
export function waitingGroupsStatement(projectId: string, nowMs: number): FlowStatement {
  return {
    sql: `SELECT g.waiter, g.open, g.blocking, g.oldest, u.name AS name
      FROM (
        SELECT ${WAITER_SQL} AS waiter, COUNT(*) AS open, TOTAL(a.blocking) AS blocking,
          MIN(a.created_at) AS oldest
        FROM asks a
        WHERE ${OPEN_WHERE_SQL}
        GROUP BY waiter
      ) g
      LEFT JOIN users u ON u.id = g.waiter
      ORDER BY g.oldest, g.waiter`,
    binds: [projectId, nowMs],
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
  const readable = `(a.assignee_kind = 'team' OR a.assignee_user_id = ?
    OR (a.kind = 'task' AND ${TASK_FILER_SQL} = ?))`;
  return {
    sql: `SELECT id, kind, blocking, title, created_at, claimed, waiter, readable, can_reassign
      FROM (
        SELECT a.id, a.kind, a.blocking, a.created_at,
          CASE WHEN ${readable} THEN a.title END AS title,
          CASE WHEN ${readable} THEN 1 ELSE 0 END AS readable,
          CASE WHEN a.assignee_kind = 'team' AND a.claimed_by_user_id IS NOT NULL THEN 1 ELSE 0
            END AS claimed,
          CASE WHEN a.kind = 'task' AND pm.role IN (${roles}) AND ${TASK_WRITABLE_SQL}
            THEN 1 ELSE 0 END AS can_reassign,
          ${WAITER_SQL} AS waiter,
          ROW_NUMBER() OVER (PARTITION BY ${WAITER_SQL} ORDER BY a.created_at, a.id) AS rn
        FROM asks a
        LEFT JOIN project_members pm ON pm.project_id = a.project_id AND pm.user_id = ?
          AND pm.status = 'active'
        WHERE ${OPEN_WHERE_SQL}
      )
      WHERE rn <= ?
      ORDER BY created_at, id`,
    binds: [
      viewerId,
      viewerId,
      viewerId,
      viewerId,
      ...writerRoles,
      viewerId,
      viewerId,
      viewerId,
      viewerId,
      projectId,
      nowMs,
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
        TOTAL(CASE WHEN NOT EXISTS (${reassigned}) AND a.assignee_kind = 'user'
          AND a.resolved_by_user_id = a.assignee_user_id THEN 1 ELSE 0 END) AS first_person
      FROM asks a
      WHERE a.project_id = ? AND a.status IN ('answered', 'done') AND a.kind IN (${KINDS_SQL})
        AND a.resolved_at >= ? AND a.resolved_at < ?
        AND ${originalKind} = 'user'`,
    binds: [projectId, sinceMs, untilMs],
  };
}
