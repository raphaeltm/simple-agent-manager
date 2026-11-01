import type { NotificationResponse } from '@simple-agent-manager/shared';
import { Alert, Button } from '@simple-agent-manager/ui';
import { Bell, CheckCheck, Loader2 } from 'lucide-react';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';

import { useNotifications } from '../hooks/useNotifications';
import { usePushSubscription } from '../hooks/usePushSubscription';
import { maybeJsonRecord } from '../lib/runtime-validation';
import { useAuth } from './AuthProvider';
import { attentionRequest } from './notifications/attention-request';
import { ATTENTION_TYPES } from './notifications/notification-type-config';
import { NotificationGroup, NotificationItem } from './notifications/NotificationItem';
import { NotificationQuestionDialog } from './notifications/question-dialog-loader';

function pushInvitationDismissedKey(userId: string): string {
  return `sam-push-invitation-dismissed-${userId}`;
}

type FilterTab = 'attention' | 'updates' | 'all';

export function NotificationCenter() {
  const [isOpen, setIsOpen] = useState(false);
  const [question, setQuestion] = useState<NotificationResponse | null>(null);
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
      if (attentionRequest(notification).readable) {
        setQuestion(notification);
        setIsOpen(false);
        return;
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

      {question && (
        <Suspense fallback={null}>
          <NotificationQuestionDialog
            key={question.id}
            notification={question}
            onClose={() => {
              setQuestion(null);
              buttonRef.current?.focus();
            }}
            onResolved={() => void refresh()}
          />
        </Suspense>
      )}
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
