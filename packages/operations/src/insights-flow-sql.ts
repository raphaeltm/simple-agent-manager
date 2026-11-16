/**
 * The D1 statements behind `projectFlow` (`insights-flow.ts`). Each builder returns SQL and its
 * positional binds. Every statement is scoped by `project_id = ?` on every table it reads, and
 * every join carries the project id too, so a row from another project can never reach a count
 * (rule 11; tested against a real SQL engine with a foreign-project fixture).
 *
 * Timestamps: `tasks` and `pull_requests` hold ISO-8601 text, `asks` holds epoch milliseconds.
 * Ranges are bound as ISO strings (and as milliseconds for asks).
 */
import { ideaTaskPredicateSql } from './idea-identity';
import { IDEA_COLUMNS, IDEA_FILED_BY_PERSON_SQL } from './idea-list-reads';
import { IDEA_OPEN_STATUSES } from './idea-transitions';
import { stopReasonCaseSql } from './insights-flow-stop-reasons';

export interface FlowStatement {
  sql: string;
  binds: unknown[];
}

export interface FlowWindow {
  projectId: string;
  /** ISO start of the range, and of the range before it. */
  since: string;
  prevSince: string;
  sinceMs: number;
  prevSinceMs: number;
  nowMs: number;
  bucket: 'day' | 'week';
}

const TERMINAL = `('completed', 'failed', 'cancelled')`;

/**
 * Task-mode runs that ended since `?` or are still going and started since `?`, with the best
 * state among their pull requests. Binds: project ×4, since ×2, project ×2 (see `runsCte`).
 *
 * `prs` holds the project's pull requests once (materialized) so each run's lookup by URL is a
 * join, not a scan per run.
 */
function runsCte(): string {
  return `WITH prs AS MATERIALIZED (
    SELECT url, state, checks_state FROM pull_requests WHERE project_id = ?
  ),
  run_rows AS MATERIALIZED (
    SELECT t.id, t.status, t.terminal_reason, t.output_pr_url,
           lower(coalesce(t.error_message, '')) AS err,
           (t.provider_limit_wait_json IS NOT NULL OR t.credential_blocked_reason IS NOT NULL) AS limit_flag,
           CASE WHEN t.status IN ${TERMINAL} THEN 0 ELSE 1 END AS running,
           CASE WHEN t.status IN ${TERMINAL} THEN substr(coalesce(t.completed_at, t.updated_at), 1, 10) END AS ended_day
      FROM tasks t
     WHERE t.project_id = ? AND t.is_idea = 0 AND t.task_mode = 'task'
       AND ((t.status IN ${TERMINAL} AND coalesce(t.completed_at, t.updated_at) >= ?)
            OR (t.status NOT IN ${TERMINAL} AND t.created_at >= ?))
  ),
  run_prs AS (
    SELECT r.id AS task_id, p.state, p.checks_state FROM run_rows r JOIN prs p ON p.url = r.output_pr_url
    UNION
    SELECT r.id, p.state, p.checks_state
      FROM run_rows r
      JOIN task_pull_request_associations a
        ON a.task_id = r.id AND a.project_id = ? AND a.disposition = 'owned'
      JOIN prs p ON p.url = a.pr_url
  ),
  pr_summary AS (
    SELECT task_id,
           max(CASE state WHEN 'merged' THEN 3 WHEN 'open' THEN 2 WHEN 'closed' THEN 1 ELSE 0 END) AS pr_rank,
           max(state <> 'merged' AND checks_state = 'failure') AS ci_failing
      FROM run_prs GROUP BY task_id
  ),
  runs AS (
    SELECT r.*, coalesce(s.pr_rank, 0) AS pr_rank, coalesce(s.ci_failing, 0) AS ci_failing,
           CASE WHEN r.running = 1 THEN (
             EXISTS (SELECT 1 FROM session_summaries ss
                      WHERE ss.project_id = ? AND ss.task_id = r.id AND ss.attention_json IS NOT NULL)
             OR EXISTS (SELECT 1 FROM asks q
                         WHERE q.project_id = ? AND q.source_task_id = r.id AND q.status = 'open')
           ) ELSE 0 END AS waiting_on_person
      FROM run_rows r LEFT JOIN pr_summary s ON s.task_id = r.id
  )`;
}

const STOP_REASON_SQL = stopReasonCaseSql({
  running: 'running',
  waitingOnPerson: 'waiting_on_person',
  status: 'status',
  terminalReason: 'terminal_reason',
  err: 'err',
  limitFlag: 'limit_flag',
  prRank: 'pr_rank',
  ciFailing: 'ci_failing',
});

/**
 * One statement, two kinds of row: `bucket` rows (one per day or week, with the outcome counts
 * of runs that ended in it) and `reason` rows (stop reason counts). Outcome precedence: merged,
 * closed without merge, failed, stopped, pull request still open, no pull request.
 */
export function runsStatement(w: FlowWindow): FlowStatement {
  const bucketExpr = w.bucket === 'day' ? 'ended_day' : `date(ended_day, '-6 days', 'weekday 1')`;
  return {
    sql: `${runsCte()}
    SELECT 'bucket' AS kind, ${bucketExpr} AS key,
           sum(pr_rank = 3) AS merged,
           sum(pr_rank = 1) AS closed,
           sum(pr_rank NOT IN (1, 3) AND status = 'failed') AS failed,
           sum(pr_rank NOT IN (1, 3) AND status = 'cancelled') AS stopped,
           sum(pr_rank = 2 AND status = 'completed') AS pr_open,
           sum(pr_rank = 0 AND status = 'completed') AS no_pr
      FROM runs WHERE running = 0 GROUP BY key
    UNION ALL
    SELECT 'reason', reason, count(*), 0, 0, 0, 0, 0
      FROM (SELECT ${STOP_REASON_SQL} AS reason FROM runs)
     WHERE reason IS NOT NULL GROUP BY reason`,
    binds: [w.projectId, w.projectId, w.since, w.since, w.projectId, w.projectId, w.projectId],
  };
}

/** Pull requests merged in the range and in the range before it. */
export function mergedStatement(w: FlowWindow): FlowStatement {
  return {
    sql: `SELECT sum(merged_at >= ?) AS current, sum(merged_at < ?) AS previous
            FROM pull_requests
           WHERE project_id = ? AND state = 'merged' AND merged_at >= ?`,
    binds: [w.since, w.since, w.projectId, w.prevSince],
  };
}

/**
 * The first-try rule, shared by Flow and the run receipt so the two cannot disagree. Tallies are
 * over the checks of a pull request's opening commit (`pull_request_heads.from_open = 1`), joined
 * as `c`:
 * - failed: any check reported a failure on it (`state = 'failure'` now, or `first_failed_at`
 *   set, which also catches a failure a rerun turned green);
 * - passed: no failure, at least one success, and nothing still pending, or the pull request has
 *   moved on (closed, merged, or pushed again), so a check suite that never completes cannot
 *   hold the verdict open forever;
 * - otherwise pending: checks still running, or none reported (a repository without CI).
 */
export const FIRST_TRY_FAILED_SQL =
  "coalesce(sum(c.state = 'failure' OR c.first_failed_at IS NOT NULL), 0)";
export const FIRST_TRY_PASSED_SQL = "coalesce(sum(c.state = 'success'), 0)";
export const FIRST_TRY_PENDING_SQL = "coalesce(sum(c.state = 'pending'), 0)";

/** `'failed' | 'passed' | 'pending'` from the tallies above and a "moved on" flag. */
export function firstTryVerdictSql(t: {
  failed: string;
  passed: string;
  pending: string;
  movedOn: string;
}): string {
  return `CASE WHEN ${t.failed} > 0 THEN 'failed'
               WHEN ${t.passed} > 0 AND (${t.pending} = 0 OR ${t.movedOn}) THEN 'passed'
               ELSE 'pending' END`;
}

/**
 * CI first try, per period. A pull request counts when SAM recorded the commit it opened with
 * (`pull_request_heads.from_open = 1`) in the period, and its verdict follows
 * `firstTryVerdictSql`; a pending verdict is left out of the rate.
 */
export function ciFirstTryStatement(w: FlowWindow): FlowStatement {
  return {
    sql: `WITH opening AS (
        SELECT repository, pr_number, head_sha, min(first_seen_at) AS opened_at
          FROM pull_request_heads
         WHERE project_id = ? AND from_open = 1 AND first_seen_at >= ?
         GROUP BY repository, pr_number
      ),
      verdicts AS (
        SELECT o.opened_at,
               ${FIRST_TRY_FAILED_SQL} AS failed,
               ${FIRST_TRY_PASSED_SQL} AS passed,
               ${FIRST_TRY_PENDING_SQL} AS pending,
               (p.state IS NOT NULL AND (p.state <> 'open' OR p.head_sha IS NOT o.head_sha)) AS moved_on
          FROM opening o
          LEFT JOIN pull_request_checks c
            ON c.project_id = ? AND c.repository = o.repository AND c.head_sha = o.head_sha
          LEFT JOIN pull_requests p
            ON p.project_id = ? AND p.repository = o.repository AND p.number = o.pr_number
         GROUP BY o.repository, o.pr_number
      ),
      decided AS (
        SELECT opened_at >= ? AS current, verdict = 'passed' AS ok
          FROM (SELECT opened_at,
                       ${firstTryVerdictSql({ failed: 'failed', passed: 'passed', pending: 'pending', movedOn: 'moved_on' })} AS verdict
                  FROM verdicts)
         WHERE verdict <> 'pending'
      )
      SELECT (SELECT count(*) FROM verdicts WHERE opened_at >= ?) AS recorded,
             coalesce(sum(current AND ok), 0) AS passed,
             coalesce(sum(current), 0) AS decided,
             coalesce(sum(NOT current AND ok), 0) AS prev_passed,
             coalesce(sum(NOT current), 0) AS prev_decided
        FROM decided`,
    binds: [w.projectId, w.prevSince, w.projectId, w.projectId, w.since, w.since],
  };
}

/**
 * Flaky checks: a check that failed and then passed on the same commit, with no code change in
 * between (`first_failed_at` set, latest state `success`). That is direct evidence the failure
 * was not caused by the change. Only named check runs are listed; suite-level rows carry no name.
 * `total` counts every flaky check, so the page can say how many it is not showing.
 */
export function flakyStatement(w: FlowWindow, limit: number): FlowStatement {
  return {
    sql: `SELECT check_key,
                 sum(first_failed_at IS NOT NULL AND state = 'success') AS flips,
                 count(*) AS commits,
                 count(*) OVER () AS total
            FROM pull_request_checks
           WHERE project_id = ? AND updated_at >= ? AND check_key LIKE 'check_run:%'
           GROUP BY check_key
          HAVING flips > 0
           ORDER BY flips DESC, commits DESC, check_key
           LIMIT ?`,
    binds: [w.projectId, w.since, limit],
  };
}

/**
 * Median time an ask waited for a person, per period, computed in SQL (no rows leave D1).
 * An answered, done, archived or expired ask waited until `resolved_at`; an open one has waited
 * until now. Periods are by when the ask was filed.
 */
export function asksStatement(w: FlowWindow): FlowStatement {
  return {
    sql: `WITH waits AS (
        SELECT created_at >= ? AS current,
               (CASE WHEN status = 'open' THEN ? ELSE resolved_at END) - created_at AS wait_ms
          FROM asks
         WHERE project_id = ? AND created_at >= ?
           AND (status = 'open' OR resolved_at IS NOT NULL)
      ),
      ranked AS (
        SELECT current, wait_ms,
               row_number() OVER (PARTITION BY current ORDER BY wait_ms) AS rn,
               count(*) OVER (PARTITION BY current) AS n
          FROM waits
      )
      SELECT current, max(n) AS n, avg(wait_ms) AS median_ms
        FROM ranked
       WHERE rn IN ((n + 1) / 2, (n + 2) / 2)
       GROUP BY current`,
    binds: [w.sinceMs, w.nowMs, w.projectId, w.prevSinceMs],
  };
}

const OPEN_IDEA_STATUSES = IDEA_OPEN_STATUSES.map((s) => `'${s}'`).join(', ');

/**
 * Open ideas a person filed in the range, oldest first: what has waited longest. Bounded to the
 * range so a years-old backlog does not fill the list; `total` says how many there are. Ideas an
 * automation or incident filed are left out, as the Ideas list folds them away (`filedByAgent`).
 */
export function waitingIdeasStatement(w: FlowWindow, limit: number): FlowStatement {
  return {
    sql: `SELECT ${IDEA_COLUMNS}, count(*) OVER () AS total FROM tasks
           WHERE project_id = ? AND ${ideaTaskPredicateSql()} AND status IN (${OPEN_IDEA_STATUSES})
             AND ${IDEA_FILED_BY_PERSON_SQL} AND created_at >= ?
           ORDER BY created_at ASC, id ASC
           LIMIT ?`,
    binds: [w.projectId, w.since, limit],
  };
}

/**
 * Ideas examined for "idea to merged": every listed idea updated since the previous range began,
 * newest update first, capped. An idea is updated when it is completed, edited or annotated, so
 * an idea whose work merged in the range is almost always among them. One extra row tells the
 * caller the cap cut the list short.
 */
export function ideaSampleStatement(w: FlowWindow, cap: number): FlowStatement {
  return {
    sql: `SELECT ${IDEA_COLUMNS} FROM tasks
           WHERE project_id = ? AND ${ideaTaskPredicateSql()}
             AND status IN (${OPEN_IDEA_STATUSES}, 'completed')
             AND updated_at >= ?
           ORDER BY updated_at DESC, id DESC
           LIMIT ?`,
    binds: [w.projectId, w.prevSince, cap + 1],
  };
}

/**
 * Rework: a merged pull request followed, within `windowDays` of its merge, by another pull
 * request in the same project and repository that is either
 * - on the same head branch (the branch was reused for a follow-up), or
 * - linked to the same idea (`ideaLinks`: `[ideaId, pullRequestUrl]` pairs from the idea
 *   evidence of the sampled ideas).
 * The follow-up's own state does not matter: opening it is the rework. A merge too recent for
 * its window to have closed counts only follow-ups seen so far. Periods are by merge time.
 */
export function reworkStatement(
  w: FlowWindow,
  windowDays: number,
  ideaLinks: ReadonlyArray<readonly [string, string]>
): FlowStatement {
  return {
    sql: `WITH merged AS MATERIALIZED (
        SELECT repository, number, url, head_ref, merged_at,
               julianday(merged_at) AS merged_jd
          FROM pull_requests
         WHERE project_id = ? AND state = 'merged' AND merged_at >= ?
      ),
      later AS MATERIALIZED (
        SELECT repository, number, url, head_ref, julianday(created_at) AS created_jd
          FROM pull_requests
         WHERE project_id = ? AND created_at >= ?
      ),
      links AS (
        SELECT json_extract(value, '$[0]') AS idea_id, json_extract(value, '$[1]') AS url
          FROM json_each(?)
      ),
      reworked AS (
        SELECT m.url FROM merged m JOIN later b
          ON b.repository = m.repository AND b.number <> m.number
         AND m.head_ref IS NOT NULL AND b.head_ref = m.head_ref
         AND b.created_jd > m.merged_jd AND b.created_jd <= m.merged_jd + ?
        UNION
        SELECT m.url FROM merged m
          JOIN links la ON la.url = m.url
          JOIN links lb ON lb.idea_id = la.idea_id AND lb.url <> la.url
          JOIN later b ON b.url = lb.url
         AND b.created_jd > m.merged_jd AND b.created_jd <= m.merged_jd + ?
      )
      SELECT coalesce(sum(merged_at >= ?), 0) AS merged,
             coalesce(sum(merged_at >= ? AND url IN (SELECT url FROM reworked)), 0) AS reworked,
             coalesce(sum(merged_at < ?), 0) AS prev_merged,
             coalesce(sum(merged_at < ? AND url IN (SELECT url FROM reworked)), 0) AS prev_reworked
        FROM merged`,
    binds: [
      w.projectId,
      w.prevSince,
      w.projectId,
      w.prevSince,
      JSON.stringify(ideaLinks),
      windowDays,
      windowDays,
      w.since,
      w.since,
      w.since,
      w.since,
    ],
  };
}
