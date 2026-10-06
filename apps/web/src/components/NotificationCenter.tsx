import type { NotificationResponse, NotificationType } from '@simple-agent-manager/shared';
import { Alert, Button } from '@simple-agent-manager/ui';
import {
  Activity,
  AlertCircle,
  Bell,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Folder,
  GitPullRequest,
  HelpCircle,
  Loader2,
  MessageSquare,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';

import { useNotifications } from '../hooks/useNotifications';
import { usePushSubscription } from '../hooks/usePushSubscription';
import { resolveAttentionAnswer } from '../lib/api';
import { maybeJsonRecord } from '../lib/runtime-validation';
import { useAuth } from './AuthProvider';

function pushInvitationDismissedKey(userId: string): string {
  return `sam-push-invitation-dismissed-${userId}`;
}

const NOTIFICATION_TYPE_CONFIG: Record<
  NotificationType,
  {
    icon: typeof CheckCircle2;
    color: string;
    label: string;
  }
> = {
  task_complete: { icon: CheckCircle2, color: 'text-success-fg', label: 'Task Complete' },
  needs_input: { icon: HelpCircle, color: 'text-warning-fg', label: 'Needs Input' },
  error: { icon: AlertCircle, color: 'text-danger-fg', label: 'Error' },
  progress: { icon: Activity, color: 'text-fg-muted', label: 'Progress' },
  session_ended: { icon: MessageSquare, color: 'text-accent', label: 'Session Ended' },
  pr_created: { icon: GitPullRequest, color: 'text-success-fg', label: 'PR Created' },
  cron_failure: { icon: AlertCircle, color: 'text-danger-fg', label: 'Operational Failure' },
};

type FilterTab = 'attention' | 'updates' | 'all';

/**
 * Notification types that represent actionable items needing human attention.
 * These are the only types counted in the bell badge.
 * Low-value updates (task_complete, progress, session_ended, pr_created) are
 * accessible in the Updates tab but do not inflate the badge count.
 */
export const ATTENTION_TYPES: ReadonlySet<string> = new Set([
  'needs_input',
  'error',
  'cron_failure',
]);

export function NotificationCenter() {
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<FilterTab>('attention');
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({});
  const { user } = useAuth();
  const dismissalKey = pushInvitationDismissedKey(user?.id ?? 'anonymous');
  const [pushInvitationDismissed, setPushInvitationDismissed] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();

  const {
    notifications,
    unreadCount,
    loading,
    markRead,
    markAllRead,
    dismiss,
    loadMore,
    hasMore,
    refresh,
  } = useNotifications();
  const push = usePushSubscription();

  useEffect(() => {
    setPushInvitationDismissed(localStorage.getItem(dismissalKey) === 'true');
  }, [dismissalKey]);

  // Position the panel relative to the bell button
  useEffect(() => {
    if (!isOpen || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const isMobile = window.innerWidth < 640;
    if (isMobile) {
      setPanelStyle({ top: rect.bottom + 8 });
    } else {
      setPanelStyle({ top: rect.bottom + 8, left: rect.left });
    }
  }, [isOpen]);

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        panelRef.current &&
        !panelRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    // Close on escape
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen]);

  const handleNotificationClick = useCallback(
    (notification: NotificationResponse) => {
      if (!notification.readAt) {
        markRead(notification.id);
      }
      if (notification.actionUrl && notification.actionUrl.startsWith('/')) {
        navigate(notification.actionUrl);
        setIsOpen(false);
      }
    },
    [markRead, navigate]
  );

  const filteredNotifications = useMemo(() => {
    if (activeTab === 'attention') return notifications.filter((n) => ATTENTION_TYPES.has(n.type));
    if (activeTab === 'updates') return notifications.filter((n) => !ATTENTION_TYPES.has(n.type));
    return notifications;
  }, [notifications, activeTab]);

  const attentionUnreadCount = useMemo(
    () => notifications.filter((n) => ATTENTION_TYPES.has(n.type) && !n.readAt).length,
    [notifications]
  );

  const updatesUnreadCount = useMemo(
    () => notifications.filter((n) => !ATTENTION_TYPES.has(n.type) && !n.readAt).length,
    [notifications]
  );

  const shouldInvitePush =
    notifications.some(
      (notification) => notification.type === 'needs_input' && !notification.dismissedAt
    ) &&
    push.supported &&
    !push.isLoading &&
    !push.isSubscribed &&
    push.permission !== 'denied' &&
    !pushInvitationDismissed;

  const dismissPushInvitation = () => {
    localStorage.setItem(dismissalKey, 'true');
    setPushInvitationDismissed(true);
  };

  // Group notifications by project when multiple projects exist
  const { groups, shouldGroup } = useMemo(() => {
    const projectIds = new Set(filteredNotifications.map((n) => n.projectId ?? 'none'));
    if (projectIds.size <= 1) {
      return { groups: [], shouldGroup: false };
    }

    const groupMap = new Map<
      string,
      { projectId: string | null; projectName: string; notifications: NotificationResponse[] }
    >();
    for (const n of filteredNotifications) {
      const key = n.projectId ?? 'none';
      let group = groupMap.get(key);
      if (!group) {
        const metadataProjectName = maybeJsonRecord(n.metadata)?.projectName;
        const projectName =
          typeof metadataProjectName === 'string'
            ? metadataProjectName
            : n.projectId
              ? `Project ${n.projectId.slice(0, 8)}`
              : 'General';
        group = { projectId: n.projectId, projectName, notifications: [] };
        groupMap.set(key, group);
      }
      group.notifications.push(n);
    }
    return { groups: Array.from(groupMap.values()), shouldGroup: true };
  }, [filteredNotifications]);

  const notificationButtonLabel = [
    'Notifications',
    attentionUnreadCount > 0 ? ` (${attentionUnreadCount} need attention)` : '',
    unreadCount > 0 ? `, ${unreadCount} total unread` : '',
  ].join('');

  return (
    <div className="relative">
      {/* Bell Button */}
      <button
        ref={buttonRef}
        onClick={() => setIsOpen(!isOpen)}
        aria-label={notificationButtonLabel}
        className="relative flex items-center justify-center w-9 h-9 bg-transparent border-none text-fg-muted cursor-pointer hover:text-fg-primary transition-colors"
      >
        <Bell size={18} />
        {attentionUnreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-accent text-fg-on-accent text-[10px] font-bold leading-none">
            {attentionUnreadCount > 99 ? '99+' : attentionUnreadCount}
          </span>
        )}
      </button>

      {/* Notification Panel — portaled to body to escape sidebar stacking context */}
      {isOpen &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Notifications"
            style={panelStyle}
            className="glass-panel-container glass-composited fixed inset-x-4 sm:inset-x-auto sm:w-[380px] max-h-[calc(100vh-5rem)] sm:max-h-[520px] glass-surface rounded-lg shadow-lg flex flex-col z-[100] overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border-default">
              <h3 className="text-sm font-semibold text-fg-primary">Notifications</h3>
              <div className="flex items-center gap-2">
                {unreadCount > 0 && (
                  <button
                    onClick={() => markAllRead()}
                    className="flex items-center gap-1 px-2 py-1 text-xs text-fg-muted bg-transparent border-none cursor-pointer hover:text-fg-primary transition-colors"
                    aria-label="Mark all as read"
                  >
                    <CheckCheck size={14} />
                    <span>Mark all read</span>
                  </button>
                )}
              </div>
            </div>

            {/* Filter Tabs */}
            <div
              role="tablist"
              aria-label="Notification filters"
              tabIndex={-1}
              className="flex border-b border-border-default"
              onKeyDown={(e) => {
                const tabIds: FilterTab[] = ['attention', 'updates', 'all'];
                const idx = tabIds.indexOf(activeTab);
                if (e.key === 'ArrowRight') {
                  e.preventDefault();
                  setActiveTab(tabIds[(idx + 1) % tabIds.length] ?? activeTab);
                } else if (e.key === 'ArrowLeft') {
                  e.preventDefault();
                  setActiveTab(tabIds[(idx - 1 + tabIds.length) % tabIds.length] ?? activeTab);
                }
              }}
            >
              {[
                { id: 'attention' as const, label: 'Attention', badge: attentionUnreadCount },
                { id: 'updates' as const, label: 'Updates', badge: updatesUnreadCount },
                { id: 'all' as const, label: 'All', badge: 0 },
              ].map(({ id, label, badge }) => (
                <button
                  key={id}
                  role="tab"
                  id={`notif-tab-${id}`}
                  aria-selected={activeTab === id}
                  aria-controls={`notif-panel-${id}`}
                  tabIndex={activeTab === id ? 0 : -1}
                  onClick={() => setActiveTab(id)}
                  className={`flex-1 px-3 min-h-[44px] text-xs font-medium border-none cursor-pointer transition-colors flex items-center justify-center gap-1 ${
                    activeTab === id
                      ? 'text-accent bg-transparent border-b-2 border-b-accent'
                      : 'text-fg-muted bg-transparent hover:text-fg-primary'
                  }`}
                >
                  {label}
                  {badge > 0 && (
                    <span className="inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full bg-accent text-fg-on-accent text-[9px] font-bold leading-none">
                      {badge > 99 ? '99+' : badge}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {shouldInvitePush && (
              <div className="border-b border-border-default p-3">
                <Alert variant="info">
                  <div className="space-y-2">
                    <p className="text-xs">
                      Get agent questions on this device even when SAM is closed.
                    </p>
                    {push.error && (
                      <p role="alert" className="text-xs">
                        {push.error}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" loading={push.isBusy} onClick={() => void push.enable()}>
                        Enable push
                      </Button>
                      <Button size="sm" variant="ghost" onClick={dismissPushInvitation}>
                        Not now
                      </Button>
                    </div>
                  </div>
                </Alert>
              </div>
            )}

            {/* Notification List */}
            <div
              role="tabpanel"
              id={`notif-panel-${activeTab}`}
              aria-labelledby={`notif-tab-${activeTab}`}
              className="flex-1 overflow-y-auto"
            >
              {loading && notifications.length === 0 ? (
                <div className="flex items-center justify-center py-8 text-fg-muted">
                  <Loader2 size={18} className="animate-spin" />
                </div>
              ) : filteredNotifications.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-fg-muted text-sm gap-1">
                  <Bell size={24} className="mb-2 opacity-40" />
                  <span>
                    {activeTab === 'attention'
                      ? 'Nothing needs your attention'
                      : activeTab === 'updates'
                        ? 'No updates'
                        : 'No notifications yet'}
                  </span>
                  {activeTab === 'attention' && (
                    <span className="text-xs opacity-70">
                      Items needing your input or action appear here
                    </span>
                  )}
                </div>
              ) : shouldGroup ? (
                <>
                  {groups.map((group) => (
                    <NotificationGroup
                      key={group.projectId ?? 'none'}
                      projectName={group.projectName}
                      notifications={group.notifications}
                      onNotificationClick={handleNotificationClick}
                      onDismiss={dismiss}
                      onMarkRead={markRead}
                      onResolved={() => void refresh()}
                      onViewInProject={(pid) => {
                        navigate(`/projects/${pid}/notifications`);
                        setIsOpen(false);
                      }}
                    />
                  ))}
                  {hasMore && (
                    <button
                      onClick={() => loadMore()}
                      className="w-full py-2 text-xs text-fg-muted bg-transparent border-none cursor-pointer hover:text-fg-primary hover:bg-[var(--sam-chrome-accent-hover-subtle)] transition-colors"
                    >
                      Load more
                    </button>
                  )}
                </>
              ) : (
                <>
                  {filteredNotifications.map((notification) => (
                    <NotificationItem
                      key={notification.id}
                      notification={notification}
                      onClick={() => handleNotificationClick(notification)}
                      onDismiss={(e) => {
                        e.stopPropagation();
                        dismiss(notification.id);
                      }}
                      onMarkRead={(e) => {
                        e.stopPropagation();
                        markRead(notification.id);
                      }}
                      onViewInProject={
                        notification.projectId
                          ? () => {
                              navigate(`/projects/${notification.projectId}/notifications`);
                              setIsOpen(false);
                            }
                          : undefined
                      }
                      onResolved={() => void refresh()}
                    />
                  ))}
                  {hasMore && (
                    <button
                      onClick={() => loadMore()}
                      className="w-full py-2 text-xs text-fg-muted bg-transparent border-none cursor-pointer hover:text-fg-primary hover:bg-[var(--sam-chrome-accent-hover-subtle)] transition-colors"
                    >
                      Load more
                    </button>
                  )}
                </>
              )}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}

function NotificationItem({
  notification,
  onClick,
  onDismiss,
  onMarkRead,
  onViewInProject,
  onResolved,
}: {
  notification: NotificationResponse;
  onClick: () => void;
  onDismiss: (e: React.MouseEvent) => void;
  onMarkRead: (e: React.MouseEvent) => void;
  onViewInProject?: () => void;
  onResolved: () => void;
}) {
  const config = NOTIFICATION_TYPE_CONFIG[notification.type] || NOTIFICATION_TYPE_CONFIG.progress;
  const Icon = config.icon;
  const isUnread = !notification.readAt;
  const [answering, setAnswering] = useState<string | null>(null);
  const [answered, setAnswered] = useState<string | null>(null);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const metadata = maybeJsonRecord(notification.metadata);
  const answerOptions = Array.isArray(metadata?.options)
    ? metadata.options.filter((option): option is string => typeof option === 'string')
    : [];
  const attentionMarkerId =
    typeof metadata?.attentionMarkerId === 'string' ? metadata.attentionMarkerId : null;

  const handleAnswer = async (event: React.MouseEvent, answer: string) => {
    event.stopPropagation();
    if (!notification.projectId || !notification.sessionId || !attentionMarkerId) return;
    setAnswering(answer);
    setAnswerError(null);
    try {
      const result = await resolveAttentionAnswer(
        notification.projectId,
        notification.sessionId,
        attentionMarkerId,
        answer
      );
      setAnswered(result.resolved ? answer : `${answer} (sending)`);
      onResolved();
    } catch (cause) {
      setAnswerError(cause instanceof Error ? cause.message : 'Could not send this answer');
    } finally {
      setAnswering(null);
    }
  };

  const timeAgo = getTimeAgo(notification.createdAt);

  return (
    <div
      className={`group flex gap-3 px-4 py-3 border-b border-border-default border-l-2 transition-colors hover:bg-[var(--sam-chrome-accent-hover-subtle)] ${
        isUnread ? 'border-l-accent bg-[var(--sam-chrome-accent-soft)]' : 'border-l-transparent'
      }`}
    >
      {/* Type icon */}
      <div className={`flex-shrink-0 mt-0.5 ${config.color}`}>
        <Icon size={16} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <button
          type="button"
          onClick={onClick}
          className="block w-full cursor-pointer border-none bg-transparent p-0 text-left"
        >
          <span className="flex items-start justify-between gap-2">
            <span
              className={`text-sm leading-tight ${isUnread ? 'font-medium text-fg-primary' : 'text-fg-secondary'}`}
            >
              {notification.title}
            </span>
            {/* Unread indicator */}
            {isUnread && (
              <span
                className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full bg-accent"
                aria-hidden="true"
              />
            )}
          </span>
          {notification.body && (
            <span className="mt-0.5 block line-clamp-2 text-xs text-fg-muted">
              {notification.body}
            </span>
          )}
        </button>
        {answerOptions.length > 0 && !answered && (
          <div className="mt-2 flex flex-wrap gap-2" aria-label="Answer options">
            {answerOptions.map((option) => (
              <button
                key={option}
                type="button"
                disabled={answering !== null || !attentionMarkerId}
                onClick={(event) => void handleAnswer(event, option)}
                className="min-h-11 min-w-11 max-w-full break-words rounded-md border border-border-default bg-surface px-3 py-2 text-xs font-medium text-fg-primary hover:border-accent disabled:cursor-not-allowed disabled:opacity-60"
              >
                {answering === option ? 'Sending...' : option}
              </button>
            ))}
          </div>
        )}
        {answered && (
          <p role="status" className="mt-2 text-xs text-success-fg">
            Answered: {answered}
          </p>
        )}
        {answerError && (
          <p role="alert" className="mt-2 text-xs text-danger-fg">
            {answerError}
          </p>
        )}
        <div className="flex items-center gap-2 mt-1">
          <span className="text-[10px] text-fg-muted">{timeAgo}</span>
          <span className="text-[10px] text-fg-muted">&middot;</span>
          <span className="text-[10px] text-fg-muted">{config.label}</span>
          {onViewInProject && (
            <>
              <span className="text-[10px] text-fg-muted">&middot;</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onViewInProject();
                }}
                className="text-[10px] text-accent bg-transparent border-none cursor-pointer hover:underline p-0"
              >
                View in project
              </button>
            </>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex-shrink-0 flex flex-col gap-1 opacity-0 group-hover:opacity-100">
        {isUnread && (
          <button
            onClick={onMarkRead}
            className="p-0.5 bg-transparent border-none text-fg-muted cursor-pointer hover:text-fg-primary"
            aria-label="Mark as read"
            title="Mark as read"
          >
            <Check size={12} />
          </button>
        )}
        <button
          onClick={onDismiss}
          className="p-0.5 bg-transparent border-none text-fg-muted cursor-pointer hover:text-danger-fg"
          aria-label="Dismiss"
          title="Dismiss"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
}

function NotificationGroup({
  projectName,
  notifications,
  onNotificationClick,
  onDismiss,
  onMarkRead,
  onViewInProject,
  onResolved,
}: {
  projectName: string;
  notifications: NotificationResponse[];
  onNotificationClick: (notification: NotificationResponse) => void;
  onDismiss: (id: string) => Promise<void>;
  onMarkRead: (id: string) => Promise<void>;
  onViewInProject?: (projectId: string) => void;
  onResolved: () => void;
}) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const unreadInGroup = notifications.filter((n) => !n.readAt).length;

  return (
    <div>
      <button
        onClick={() => setIsCollapsed(!isCollapsed)}
        aria-expanded={!isCollapsed}
        aria-label={`${projectName} — ${notifications.length} notifications${unreadInGroup > 0 ? `, ${unreadInGroup} unread` : ''}`}
        className="w-full flex items-center gap-2 px-4 py-2.5 min-h-[44px] bg-transparent border-none cursor-pointer border-b border-border-default hover:bg-[var(--sam-chrome-accent-hover-subtle)] transition-colors"
      >
        {isCollapsed ? (
          <ChevronRight size={14} className="text-fg-muted" />
        ) : (
          <ChevronDown size={14} className="text-fg-muted" />
        )}
        <Folder size={14} className="text-fg-muted" />
        <span className="text-xs font-medium text-fg-secondary flex-1 text-left">
          {projectName}
        </span>
        <span className="text-[10px] text-fg-muted">
          {notifications.length}
          {unreadInGroup > 0 && (
            <span className="ml-1 inline-flex items-center justify-center min-w-[14px] h-[14px] px-0.5 rounded-full bg-accent text-fg-on-accent text-[9px] font-bold leading-none">
              {unreadInGroup}
            </span>
          )}
        </span>
      </button>
      {!isCollapsed &&
        notifications.map((notification) => {
          const projectId = notification.projectId;
          return (
            <NotificationItem
              key={notification.id}
              notification={notification}
              onClick={() => onNotificationClick(notification)}
              onDismiss={(e) => {
                e.stopPropagation();
                onDismiss(notification.id);
              }}
              onMarkRead={(e) => {
                e.stopPropagation();
                onMarkRead(notification.id);
              }}
              onViewInProject={
                projectId && onViewInProject ? () => onViewInProject(projectId) : undefined
              }
              onResolved={onResolved}
            />
          );
        })}
    </div>
  );
}

function getTimeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  return new Date(dateStr).toLocaleDateString();
}
