/**
 * The D1 statement behind `projectSetups` (`insights-setups.ts`): one row per run of the range,
 * newest first, capped, with everything the Agent setups tab aggregates. The run population is
 * Flow's (`runsCte`), so the tabs count the same runs.
 *
 * Scope (rule 11): every table read binds `project_id = ?`, and every join carries the project id,
 * so a row from another project can never reach a count. Profiles and skills may be user-level
 * (`project_id IS NULL`); those are joined only by id from this project's own runs, and their names
 * are returned only to their owner (`*_owner`), never for a teammate's personal row.
 *
 * Per-run reads are joined against the capped set only (`picked`), each through an index:
 * resource summaries by `idx_workspace_resource_summaries_project_task`, token usage by the
 * `agent_run_usage` unique key prefix `(project_id, chat_session_id, source)`.
 */
import type { FlowStatement, FlowWindow } from './insights-flow-sql';
import { runsCte, sameBranchFollowUpSql } from './insights-flow-sql';
import { runTokenTotalsSql } from './insights-run-usage';

export function setupRunsStatement(
  w: FlowWindow,
  options: { viewerId: string; cap: number; reworkWindowDays: number }
): FlowStatement {
  const p = w.projectId;
  const sql = `${runsCte({ setup: true })},
  run_pr AS (
    SELECT rp.task_id, p.repository, p.number, p.head_ref, p.state,
           julianday(p.created_at) AS created_jd, julianday(p.merged_at) AS merged_jd
      FROM run_prs rp JOIN prs p ON p.url = rp.url
  ),
  later AS MATERIALIZED (
    SELECT repository, number, head_ref, julianday(created_at) AS created_jd
      FROM pull_requests WHERE project_id = ? AND created_at >= ?
  ),
  pr_facts AS (
    SELECT m.task_id, min(m.created_jd) AS first_pr_jd,
           max(m.state = 'merged' AND m.merged_jd IS NOT NULL
               AND EXISTS (SELECT 1 FROM later b WHERE ${sameBranchFollowUpSql('m', 'b', '?')})) AS reworked
      FROM run_pr m GROUP BY m.task_id
  ),
  picked AS MATERIALIZED (
    SELECT r.*, julianday(r.created_at) AS created_jd, f.first_pr_jd,
           coalesce(f.reworked, 0) AS reworked
      FROM runs r LEFT JOIN pr_facts f ON f.task_id = r.id
     ORDER BY julianday(r.created_at) DESC, r.id DESC
     LIMIT ?
  ),
  mem AS (
    SELECT rs.task_id, count(*) AS mem_rows, max(rs.memory_peak_bytes) AS mem_peak,
           total(rs.oom_count) AS mem_oom
      FROM picked k
      JOIN workspace_resource_summaries rs ON rs.project_id = ? AND rs.task_id = k.id
     GROUP BY rs.task_id
  ),
  tok AS (${runTokenTotalsSql('picked', 'chat_session_id')})
  SELECT k.id, k.status, k.running, k.pr_rank, k.profile_id, k.skill_id, k.model, k.agent_type,
         k.agent_session_id, k.chat_session_id, k.created_jd,
         julianday(k.completed_at) AS completed_jd, k.first_pr_jd, k.reworked,
         k.workspace_reservation, k.task_reservation,
         m.mem_rows, m.mem_peak, m.mem_oom, t.tokens,
         ap.name AS profile_name,
         CASE WHEN ap.id IS NULL THEN NULL WHEN ap.project_id = ? THEN 'project'
              WHEN ap.user_id = ? THEN 'you' ELSE 'teammate' END AS profile_owner,
         sk.name AS skill_name,
         CASE WHEN sk.id IS NULL THEN NULL WHEN sk.project_id = ? THEN 'project'
              WHEN sk.user_id = ? THEN 'you' ELSE 'teammate' END AS skill_owner,
         CASE WHEN sk.project_id = ? THEN sk.default_profile_id END AS skill_default_profile_id,
         CASE WHEN sk.project_id = ? THEN sk.resource_requirements_json END AS skill_resources,
         (SELECT count(*) FROM run_rows) AS total_runs
    FROM picked k
    LEFT JOIN mem m ON m.task_id = k.id
    LEFT JOIN tok t ON t.id = k.id
    LEFT JOIN agent_profiles ap ON ap.id = k.profile_id AND (ap.project_id = ? OR ap.project_id IS NULL)
    LEFT JOIN skills sk ON sk.id = k.skill_id AND (sk.project_id = ? OR sk.project_id IS NULL)
   ORDER BY k.created_jd DESC, k.id DESC`;
  return {
    sql,
    binds: [
      // runsCte
      p,
      p,
      w.since,
      w.since,
      p,
      p,
      p,
      // later
      p,
      w.prevSince,
      // pr_facts rework window
      options.reworkWindowDays,
      // picked
      options.cap,
      // mem
      p,
      // tok
      p,
      // select list: profile owner, skill owner, skill default, skill resources
      p,
      options.viewerId,
      p,
      options.viewerId,
      p,
      p,
      // joins
      p,
      p,
    ],
  };
}
