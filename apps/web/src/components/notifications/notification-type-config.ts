import type { NotificationType } from '@simple-agent-manager/shared';
import {
  Activity,
  AlertCircle,
  AtSign,
  CheckCircle2,
  GitPullRequest,
  HelpCircle,
  type LucideIcon,
  MessageSquare,
  MessageSquareQuote,
  Users,
} from 'lucide-react';

export interface NotificationTypeConfig {
  icon: LucideIcon;
  color: string;
  label: string;
}

/**
 * How each notification type looks in the bell panel and on the project Notifications page.
 * One table for both: exhaustive over `NOTIFICATION_TYPES`, so adding a type fails to compile
 * until it has a row here.
 */
export const NOTIFICATION_TYPE_CONFIG: Record<NotificationType, NotificationTypeConfig> = {
  task_complete: { icon: CheckCircle2, color: 'text-success-fg', label: 'Task Complete' },
  needs_input: { icon: HelpCircle, color: 'text-warning-fg', label: 'Needs Input' },
  error: { icon: AlertCircle, color: 'text-danger-fg', label: 'Error' },
  progress: { icon: Activity, color: 'text-fg-muted', label: 'Progress' },
  session_ended: { icon: MessageSquare, color: 'text-accent', label: 'Session Ended' },
  pr_created: { icon: GitPullRequest, color: 'text-success-fg', label: 'PR Created' },
  cron_failure: { icon: AlertCircle, color: 'text-danger-fg', label: 'Operational Failure' },
  mention: { icon: AtSign, color: 'text-accent', label: 'Mention' },
  comment: { icon: MessageSquareQuote, color: 'text-info-fg', label: 'Comment' },
  session_access: { icon: Users, color: 'text-info-fg', label: 'Shared Session' },
};

/**
 * Lookup that survives a type this build does not know yet (a newer server can send one
 * before the client updates): it renders as a neutral update instead of crashing the list.
 */
export function notificationTypeConfig(type: string): NotificationTypeConfig {
  return (
    (NOTIFICATION_TYPE_CONFIG as Partial<Record<string, NotificationTypeConfig>>)[type] ??
    NOTIFICATION_TYPE_CONFIG.progress
  );
}

/**
 * Notification types that represent actionable items needing human attention.
 * These are the only types counted in the bell badge.
 * Low-value updates (task_complete, progress, session_ended, pr_created, comment,
 * session_access) are accessible in the Updates tab but do not inflate the badge count.
 * A mention is addressed to you by a person, so it needs you.
 */
export const ATTENTION_TYPES: ReadonlySet<string> = new Set<NotificationType>([
  'needs_input',
  'error',
  'cron_failure',
  'mention',
]);
