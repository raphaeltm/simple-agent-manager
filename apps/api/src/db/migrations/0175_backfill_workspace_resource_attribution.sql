-- Backfill resource summaries from server-owned session/task records. Every join is
-- constrained through the summary's project and workspace so a malformed cross-project
-- task reference cannot contribute attribution.
WITH attribution AS (
  SELECT summary.id,
         COALESCE(
           NULLIF(agent_session.agent_profile_id, ''),
           NULLIF(task.agent_profile_hint, ''),
           NULLIF(workspace.agent_profile_hint, '')
         ) AS agent_profile_id,
         COALESCE(
           NULLIF(agent_session.skill_id, ''),
           NULLIF(task.skill_id, '')
         ) AS skill_id,
         COALESCE(
           NULLIF(agent_session.agent_type, ''),
           NULLIF(profile.agent_type, ''),
           NULLIF(skill.agent_type, '')
         ) AS agent_type
    FROM workspace_resource_summaries summary
    JOIN workspaces workspace
      ON workspace.id = summary.workspace_id
     AND workspace.project_id = summary.project_id
    LEFT JOIN tasks task
      ON task.id = (
        SELECT candidate.id
          FROM tasks candidate
         WHERE candidate.project_id = summary.project_id
           AND candidate.workspace_id = summary.workspace_id
           AND (
             (summary.task_id IS NOT NULL AND candidate.id = summary.task_id)
             OR (
               summary.task_id IS NULL
               AND summary.session_id IS NOT NULL
               AND candidate.chat_session_id = summary.session_id
             )
           )
         ORDER BY CASE WHEN candidate.id = summary.task_id THEN 0 ELSE 1 END,
                  candidate.started_at DESC,
                  candidate.id DESC
         LIMIT 1
      )
    LEFT JOIN agent_sessions agent_session
      ON agent_session.id = (
        SELECT candidate.id
          FROM agent_sessions candidate
         WHERE candidate.workspace_id = summary.workspace_id
         ORDER BY CASE WHEN candidate.status = 'running' THEN 0 ELSE 1 END,
                  candidate.updated_at DESC,
                  candidate.created_at DESC,
                  candidate.id DESC
         LIMIT 1
      )
    LEFT JOIN agent_profiles profile
      ON profile.id = COALESCE(
        NULLIF(agent_session.agent_profile_id, ''),
        NULLIF(task.agent_profile_hint, ''),
        NULLIF(workspace.agent_profile_hint, '')
      )
    LEFT JOIN skills skill
      ON skill.id = COALESCE(
        NULLIF(agent_session.skill_id, ''),
        NULLIF(task.skill_id, '')
      )
   WHERE summary.agent_profile_id IS NULL
      OR TRIM(summary.agent_profile_id) = ''
      OR summary.skill_id IS NULL
      OR TRIM(summary.skill_id) = ''
      OR summary.agent_type IS NULL
      OR TRIM(summary.agent_type) = ''
)
UPDATE workspace_resource_summaries
   SET agent_profile_id = CASE
         WHEN agent_profile_id IS NULL OR TRIM(agent_profile_id) = ''
           THEN COALESCE(
             (SELECT attribution.agent_profile_id
                FROM attribution
               WHERE attribution.id = workspace_resource_summaries.id),
             agent_profile_id
           )
         ELSE agent_profile_id
       END,
       skill_id = CASE
         WHEN skill_id IS NULL OR TRIM(skill_id) = ''
           THEN COALESCE(
             (SELECT attribution.skill_id
                FROM attribution
               WHERE attribution.id = workspace_resource_summaries.id),
             skill_id
           )
         ELSE skill_id
       END,
       agent_type = CASE
         WHEN agent_type IS NULL OR TRIM(agent_type) = ''
           THEN COALESCE(
             (SELECT attribution.agent_type
                FROM attribution
               WHERE attribution.id = workspace_resource_summaries.id),
             agent_type
           )
         ELSE agent_type
       END
 WHERE (
   agent_profile_id IS NULL
   OR TRIM(agent_profile_id) = ''
   OR skill_id IS NULL
   OR TRIM(skill_id) = ''
   OR agent_type IS NULL
   OR TRIM(agent_type) = ''
 )
   AND id IN (
     SELECT attribution.id
       FROM attribution
      WHERE attribution.agent_profile_id IS NOT NULL
         OR attribution.skill_id IS NOT NULL
         OR attribution.agent_type IS NOT NULL
   );
