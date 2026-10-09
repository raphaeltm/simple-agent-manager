-- Bounded, data-only correction for two conversations that expired while #2280
-- was in review/deployment. Pre-expiry reads proved available sleeping snapshots;
-- post-expiry reads proved purge stopped each chat before the old sweep failed it.
-- Dry runs 2026-10-08: exactly two failed rows, no snapshots, deleted workspaces,
-- stopped transcripts with 6207 and 3585 messages. No R2 or transcript changes.
-- Preserve completion/update chronology, original transition IDs and failure events.
-- Exact observed identity/state/error/timestamps fence each one-row correction.
-- Unique audit IDs make repeat execution harmless, including a retry after a
-- correction succeeded but its audit append needs reconciliation.

UPDATE tasks
SET status = 'cancelled', terminal_reason = 'snapshot_expired', error_message = NULL
WHERE id = '01M3W1QQCPTM787VWRXQZAEGEE'
  AND project_id = '01M3VR21E3B2G18K084X2ZKCTA'
  AND chat_session_id = '34d5db22-b744-4cc5-aba9-b68a1c993545'
  AND workspace_id = '01M3W1QVE9H7MWNDBNVKGZFS0A'
  AND task_mode = 'conversation' AND status = 'failed' AND terminal_reason IS NULL
  AND updated_at = '2026-10-08T15:55:58.440Z'
  AND completed_at = '2026-10-08T15:55:58.440Z'
  AND terminal_transition_id = '01M4E3N038A5SJZVM8BWNPX92D'
  AND error_message = 'Task runtime is no longer live (workspace_deleted); task started 10098 minutes ago. Last step: running (agent active).'
  AND NOT EXISTS (SELECT 1 FROM session_snapshots s WHERE s.chat_session_id = tasks.chat_session_id)
  AND EXISTS (SELECT 1 FROM session_summaries ss
    WHERE ss.id = tasks.chat_session_id AND ss.project_id = tasks.project_id
      AND ss.status = 'stopped' AND ss.ended_at = 1791474704653 AND ss.message_count = 6207)
  AND EXISTS (SELECT 1 FROM workspaces w WHERE w.id = tasks.workspace_id AND w.status = 'deleted');

INSERT OR IGNORE INTO task_status_events
  (id, task_id, from_status, to_status, actor_type, reason, created_at)
SELECT 'snapshot-expiry-followup-01M3W1QQCPTM787VWRXQZAEGEE', id, 'failed', 'cancelled', 'system',
       'snapshot_expired (verified legacy retention correction; prior_error=Task runtime is no longer live (workspace_deleted); task started 10098 minutes ago. Last step: running (agent active).)',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM tasks
WHERE id = '01M3W1QQCPTM787VWRXQZAEGEE'
  AND project_id = '01M3VR21E3B2G18K084X2ZKCTA'
  AND chat_session_id = '34d5db22-b744-4cc5-aba9-b68a1c993545'
  AND workspace_id = '01M3W1QVE9H7MWNDBNVKGZFS0A'
  AND status = 'cancelled' AND terminal_reason = 'snapshot_expired' AND error_message IS NULL
  AND updated_at = '2026-10-08T15:55:58.440Z'
  AND completed_at = '2026-10-08T15:55:58.440Z'
  AND terminal_transition_id = '01M4E3N038A5SJZVM8BWNPX92D';

UPDATE tasks
SET status = 'cancelled', terminal_reason = 'snapshot_expired', error_message = NULL
WHERE id = '01M3VY3XJV909HKR9VZ5HEJX5W'
  AND project_id = '01M3VR21E3B2G18K084X2ZKCTA'
  AND chat_session_id = 'fcac50e1-c625-4ac5-b527-0d81d225087b'
  AND workspace_id = '01M3VY3Z1KBWGXM0768VSXX2KR'
  AND task_mode = 'task' AND status = 'failed' AND terminal_reason IS NULL
  AND updated_at = '2026-10-08T17:20:56.187Z'
  AND completed_at = '2026-10-08T17:20:56.187Z'
  AND terminal_transition_id = '01M4E8GJBV4ZWAWEFZW3DB3CAB'
  AND error_message = 'Task runtime is no longer live (workspace_deleted); task started 10215 minutes ago. Last step: awaiting_followup.'
  AND NOT EXISTS (SELECT 1 FROM session_snapshots s WHERE s.chat_session_id = tasks.chat_session_id)
  AND EXISTS (SELECT 1 FROM session_summaries ss
    WHERE ss.id = tasks.chat_session_id AND ss.project_id = tasks.project_id
      AND ss.status = 'stopped' AND ss.ended_at = 1791479979576 AND ss.message_count = 3585)
  AND EXISTS (SELECT 1 FROM workspaces w WHERE w.id = tasks.workspace_id AND w.status = 'deleted');

INSERT OR IGNORE INTO task_status_events
  (id, task_id, from_status, to_status, actor_type, reason, created_at)
SELECT 'snapshot-expiry-followup-01M3VY3XJV909HKR9VZ5HEJX5W', id, 'failed', 'cancelled', 'system',
       'snapshot_expired (verified legacy retention correction; prior_error=Task runtime is no longer live (workspace_deleted); task started 10215 minutes ago. Last step: awaiting_followup.)',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM tasks
WHERE id = '01M3VY3XJV909HKR9VZ5HEJX5W'
  AND project_id = '01M3VR21E3B2G18K084X2ZKCTA'
  AND chat_session_id = 'fcac50e1-c625-4ac5-b527-0d81d225087b'
  AND workspace_id = '01M3VY3Z1KBWGXM0768VSXX2KR'
  AND status = 'cancelled' AND terminal_reason = 'snapshot_expired' AND error_message IS NULL
  AND updated_at = '2026-10-08T17:20:56.187Z'
  AND completed_at = '2026-10-08T17:20:56.187Z'
  AND terminal_transition_id = '01M4E8GJBV4ZWAWEFZW3DB3CAB';

