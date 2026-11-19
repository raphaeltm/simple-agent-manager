import type { NotificationType } from '@simple-agent-manager/shared';
import {
  Activity,
  AlertCircle,
  AtSign,
  CheckCircle2,
  GitPullRequest,
  HelpCircle,
  KeyRound,
  type LucideIcon,
  MessageSquare,
  MessageSquareQuote,
  ShieldCheck,
  Users,
} from 'lucide-react';

export interface NotificationTypeConfig {
  icon: LucideIcon;
  color: string;
  label: string;
}

/**
 * How each notification type looks in the inbox's Updates list. One table: exhaustive over `NOTIFICATION_TYPES`, so adding a type fails to compile
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
  operations_approval: { icon: ShieldCheck, color: 'text-warning-fg', label: 'Approval Needed' },
  secret_request: { icon: KeyRound, color: 'text-warning-fg', label: 'Secret Requested' },
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
 * Where each notification type lives now that the inbox replaced the bell (spec idea
 * 01M7G03ZCQ6TM6CMEYDRKQ8ST9). `inbox`: the ask it announces is an inbox item, so the inbox
 * shows the item and the notification would be a duplicate. `update`: an FYI, listed under the
 * inbox's Updates chip. Exhaustive, so a new type must choose.
 */
export const NOTIFICATION_INBOX_ROLE: Record<NotificationType, 'inbox' | 'update'> = {
  needs_input: 'inbox',
  operations_approval: 'inbox',
  secret_request: 'inbox',
  task_complete: 'update',
  error: 'update',
  progress: 'update',
  session_ended: 'update',
  pr_created: 'update',
  cron_failure: 'update',
  mention: 'update',
  comment: 'update',
  session_access: 'update',
};

/** True for notifications the Updates chip lists (unknown types included, as neutral updates). */
export function isUpdateNotification(type: string): boolean {
  return (NOTIFICATION_INBOX_ROLE as Partial<Record<string, 'inbox' | 'update'>>)[type] !== 'inbox';
}
