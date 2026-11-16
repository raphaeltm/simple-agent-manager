/**
 * SQL predicates the brief's facts (`project-brief-facts.ts`) and its read
 * (`project-brief-read.ts`) share, so what may be said and what may still be shown can never
 * drift apart. Imports nothing from this package: both modules depend on it.
 */
import { DEFAULT_TRIGGER_AUTO_PAUSE_AFTER_FAILURES } from '@simple-agent-manager/shared';

/**
 * An open ask every active member of its project may see, as SQL over alias `a` binding `now`
 * once. The inbox lists an ask to its assignee, or a team ask to everyone until someone claims it
 * (`inbox-list-core.ts`); so an ask is project-wide when it is an unclaimed team ask, or when its
 * one reader is the project's only active member. Shared with the brief's read
 * (`project-brief-read.ts`), which re-checks every ask a stored brief names: a member who joins
 * later must not see, through an old brief, an ask their own inbox would not show them.
 */
export const BRIEF_ASK_VISIBLE_SQL = `(a.status = 'open'
     AND (a.expires_at IS NULL OR a.expires_at > ?)
     AND ((a.assignee_kind = 'team' AND a.claimed_by_user_id IS NULL)
       OR NOT EXISTS (
         SELECT 1 FROM project_members pm
          WHERE pm.project_id = a.project_id AND pm.status = 'active'
            AND pm.user_id <> COALESCE(
              CASE WHEN a.assignee_kind = 'team' THEN a.claimed_by_user_id
                   ELSE a.assignee_user_id END, ''))))`;

/**
 * Shared accounts near or past a limit. A member's own credential is never a project fact. Used by
 * the facts and by the brief's read, which re-checks every account a stored brief names.
 */
export const BRIEF_ACCOUNT_LIVE_SQL = `(w.credential_source IN ('project', 'platform')
     AND w.last_event_level IN ('warning', 'critical', 'rejected')
     AND (w.resets_at IS NULL OR w.resets_at > ?))`;

/**
 * An automation (alias `t` = triggers) is failing: not disabled, and its newest finished runs are
 * all failures — the Automation page's own rule (`failureStreak` ≥
 * `DEFAULT_TRIGGER_AUTO_PAUSE_AFTER_FAILURES`, apps/web automation model). Each trigger walks its
 * newest runs backwards on `idx_trigger_executions_trigger_sequence` and stops after a few
 * finished ones. Used by the facts, and by the read so a recovered automation's claim is dropped.
 */
export const BRIEF_AUTOMATION_FAILING_SQL = `(t.status <> 'disabled'
     AND (SELECT COUNT(*) FROM (
            SELECT te.status FROM trigger_executions te
             WHERE te.trigger_id = t.id AND te.status IN ('completed', 'failed')
             ORDER BY te.sequence_number DESC, te.created_at DESC
             LIMIT ${DEFAULT_TRIGGER_AUTO_PAUSE_AFTER_FAILURES}) recent
           WHERE recent.status = 'failed') >= ${DEFAULT_TRIGGER_AUTO_PAUSE_AFTER_FAILURES})`;
