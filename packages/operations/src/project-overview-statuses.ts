/**
 * Task statuses whose chat can be running: placed but not started, and started. An allowlist
 * (`.claude/rules/79`): a status added later is not running until someone decides it is.
 * `sleeping` is deliberately absent: a sleeping chat is not running. Its own module so the
 * Overview read and the brief read can share it without importing each other.
 */
export const OVERVIEW_STARTING_TASK_STATUSES = ['queued', 'delegated'] as const;
export const OVERVIEW_RUNNING_TASK_STATUSES = [
  ...OVERVIEW_STARTING_TASK_STATUSES,
  'in_progress',
] as const;

const sqlList = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');

/**
 * Chats paused on a person in one project: an open blocking question in `asks` (inbox slice G) or
 * a pending secret request, both unexpired. `projectSql` is the project's id as SQL (a `?`
 * placeholder or a column). Binds `now` twice, after any binds `projectSql` itself needs, in the
 * order: project, now, project, now.
 */
export function overviewPausedSessionsSql(projectSql: string): string {
  return `SELECT source_session_id AS session_id
      FROM asks
     WHERE project_id = ${projectSql} AND kind = 'question' AND status = 'open' AND blocking = 1
       AND source_session_id IS NOT NULL
       AND (expires_at IS NULL OR expires_at > ?)
    UNION
    SELECT requesting_chat_session_id AS session_id
      FROM runtime_secret_requests
     WHERE project_id = ${projectSql} AND status = 'pending' AND expires_at > ?
       AND requesting_chat_session_id IS NOT NULL`;
}

/**
 * A chat is running (Running now's own rule, over `ss` = session_summaries and `t` = its task):
 * awake, its task in a running status, and either still being placed, paused on a person
 * (`pausedSessionsSql` selects those chats' ids), or mid-turn (`agent_completed_at IS NULL`,
 * not awaiting a follow-up). The Overview read and the brief's re-check share it, so a chat the
 * page no longer lists can never be called running by the brief.
 */
export function overviewChatRunningSql(pausedSessionsSql: string): string {
  return `(ss.status = 'active'
     AND t.status IN (${sqlList(OVERVIEW_RUNNING_TASK_STATUSES)})
     AND (
       t.status IN (${sqlList(OVERVIEW_STARTING_TASK_STATUSES)})
       OR ss.attention_json IS NOT NULL
       OR ss.id IN (${pausedSessionsSql})
       OR (ss.agent_completed_at IS NULL
           AND (t.execution_step IS NULL OR t.execution_step <> 'awaiting_followup'))
     ))`;
}
