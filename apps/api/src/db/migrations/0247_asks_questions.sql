-- Inbox slice G (idea 01M7G03ZCQ6TM6CMEYDRKQ8ST9): a question an agent asks with
-- request_human_input is one `asks` row (kind 'question') instead of a ProjectData attention
-- marker. These columns carry what the marker carried for the question's reminders and expiry
-- (`apps/api/src/services/inbox/sweep.ts`):
--   source_workspace_id  the asking agent's workspace (the expiry outcome stops its task run)
--   category             the request_human_input category
--   notification_id      the notification sent for it (reminders resend its push; expiry
--                        checks its delivery receipt)
--   next_escalation_at   next reminder, NULL when none is left
--   escalation_count     reminders sent
--   max_expires_at       hard limit for extending an ask whose push was never delivered
--
-- Additive only: nullable columns, one integer column with a default, two partial indexes.
-- Existing rows (reviews, tasks, errors filed since slice A) keep NULL / 0 and are unaffected:
-- the reminder sweep selects only rows with next_escalation_at set.
ALTER TABLE asks ADD COLUMN source_workspace_id TEXT;
ALTER TABLE asks ADD COLUMN category TEXT;
ALTER TABLE asks ADD COLUMN notification_id TEXT;
ALTER TABLE asks ADD COLUMN next_escalation_at INTEGER;
ALTER TABLE asks ADD COLUMN escalation_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE asks ADD COLUMN max_expires_at INTEGER;

-- Due reminders.
CREATE INDEX idx_asks_open_escalation ON asks (next_escalation_at)
  WHERE status = 'open' AND next_escalation_at IS NOT NULL;
-- Open questions per project and chat: the chat list, the check-in hold and the stall guard
-- read only these rows (`packages/worker-core/src/question-asks.ts`).
CREATE INDEX idx_asks_open_question ON asks (project_id, source_session_id, created_at)
  WHERE kind = 'question' AND status = 'open';
