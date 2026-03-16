import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bell,
  Check,
  CheckCheck,
  X,
  AlertCircle,
  CheckCircle2,
  MessageSquare,
  GitPullRequest,
  Activity,
  HelpCircle,
  Loader2,
  ChevronDown,
  ChevronRight,
  Folder,
} from 'lucide-react';
import type { NotificationResponse, NotificationType } from '@simple-agent-manager/shared';
import { useNotifications } from '../hooks/useNotifications';

const NOTIFICATION_TYPE_CONFIG: Record<NotificationType, {
  icon: typeof CheckCircle2;
  color: string;
  label: string;
}> = {
  task_complete: { icon: CheckCircle2, color: 'text-success-fg', label: 'Task Complete' },
  needs_input: { icon: HelpCircle, color: 'text-warning-fg', label: 'Needs Input' },
  error: { icon: AlertCircle, color: 'text-danger-fg', label: 'Error' },
  progress: { icon: Activity, color: 'text-fg-muted', label: 'Progress' },
  session_ended: { icon: MessageSquare, color: 'text-accent', label: 'Session Ended' },
  pr_created: { icon: GitPullRequest, color: 'text-success-fg', label: 'PR Created' },
};

type FilterTab = 'all' | 'unread';

export function NotificationCenter() {
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<FilterTab>('all');
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
  } = useNotifications();

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

  const filteredNotifications = activeTab === 'unread'
    ? notifications.filter((n) => !n.readAt)
    : notifications;

  // Group notifications by project when multiple projects exist
  const { groups, shouldGroup } = useMemo(() => {
    const projectIds = new Set(filteredNotifications.map((n) => n.projectId ?? 'none'));
    if (projectIds.size <= 1) {
      return { groups: [], shouldGroup: false };
    }

    const groupMap = new Map<string, { projectId: string | null; projectName: string; notifications: NotificationResponse[] }>();
    for (const n of filteredNotifications) {
      const key = n.projectId ?? 'none';
      if (!groupMap.has(key)) {
        const projectName = (n.metadata as Record<string, unknown> | null)?.projectName as string | undefined
          ?? (n.projectId ? `Project` : 'General');
        groupMap.set(key, { projectId: n.projectId, projectName, notifications: [] });
      }
      groupMap.get(key)!.notifications.push(n);
    }
    return { groups: Array.from(groupMap.values()), shouldGroup: true };
  }, [filteredNotifications]);

  return (
    <div className="relative">
      {/* Bell Button */}
      <button
        ref={buttonRef}
        onClick={() => setIsOpen(!isOpen)}
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
        className="relative flex items-center justify-center w-9 h-9 bg-transparent border-none text-fg-muted cursor-pointer hover:text-fg-primary transition-colors"
      >
        <Bell size={18} />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-accent text-fg-on-accent text-[10px] font-bold leading-none">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {/* Notification Panel */}
      {isOpen && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 top-full mt-2 w-[calc(100vw-2rem)] sm:w-[380px] max-h-[520px] bg-surface border border-border-default rounded-lg shadow-lg flex flex-col z-50 overflow-hidden"
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
          <div className="flex border-b border-border-default">
            {(['all', 'unread'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`flex-1 px-3 py-2 text-xs font-medium border-none cursor-pointer transition-colors ${
                  activeTab === tab
                    ? 'text-accent bg-transparent border-b-2 border-b-accent'
                    : 'text-fg-muted bg-transparent hover:text-fg-primary'
                }`}
                style={activeTab === tab ? { borderBottomWidth: '2px', borderBottomStyle: 'solid' } : {}}
              >
                {tab === 'all' ? 'All' : `Unread${unreadCount > 0 ? ` (${unreadCount})` : ''}`}
              </button>
            ))}
          </div>

          {/* Notification List */}
          <div className="flex-1 overflow-y-auto">
            {loading && notifications.length === 0 ? (
              <div className="flex items-center justify-center py-8 text-fg-muted">
                <Loader2 size={18} className="animate-spin" />
              </div>
            ) : filteredNotifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-fg-muted text-sm">
                <Bell size={24} className="mb-2 opacity-40" />
                <span>{activeTab === 'unread' ? 'No unread notifications' : 'No notifications yet'}</span>
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
                  />
                ))}
                {hasMore && (
                  <button
                    onClick={() => loadMore()}
                    className="w-full py-2 text-xs text-fg-muted bg-transparent border-none cursor-pointer hover:text-fg-primary hover:bg-surface-hover transition-colors"
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
                  />
                ))}
                {hasMore && (
                  <button
                    onClick={() => loadMore()}
                    className="w-full py-2 text-xs text-fg-muted bg-transparent border-none cursor-pointer hover:text-fg-primary hover:bg-surface-hover transition-colors"
                  >
                    Load more
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function NotificationItem({
  notification,
  onClick,
  onDismiss,
  onMarkRead,
}: {
  notification: NotificationResponse;
  onClick: () => void;
  onDismiss: (e: React.MouseEvent) => void;
  onMarkRead: (e: React.MouseEvent) => void;
}) {
  const config = NOTIFICATION_TYPE_CONFIG[notification.type] || NOTIFICATION_TYPE_CONFIG.progress;
  const Icon = config.icon;
  const isUnread = !notification.readAt;

  const timeAgo = getTimeAgo(notification.createdAt);

  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      className={`group flex gap-3 px-4 py-3 cursor-pointer border-b border-border-default transition-colors hover:bg-surface-hover ${
        isUnread ? 'bg-inset' : ''
      }`}
    >
      {/* Type icon */}
      <div className={`flex-shrink-0 mt-0.5 ${config.color}`}>
        <Icon size={16} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <p className={`text-sm leading-tight ${isUnread ? 'font-medium text-fg-primary' : 'text-fg-secondary'}`}>
            {notification.title}
          </p>
          {/* Unread indicator */}
          {isUnread && (
            <span className="flex-shrink-0 w-2 h-2 rounded-full bg-accent mt-1.5" />
          )}
        </div>
        {notification.body && (
          <p className="text-xs text-fg-muted mt-0.5 line-clamp-2">
            {notification.body}
          </p>
        )}
        <div className="flex items-center gap-2 mt-1">
          <span className="text-[10px] text-fg-muted">{timeAgo}</span>
          <span className="text-[10px] text-fg-muted">·</span>
          <span className="text-[10px] text-fg-muted">{config.label}</span>
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
}: {
  projectName: string;
  notifications: NotificationResponse[];
  onNotificationClick: (notification: NotificationResponse) => void;
  onDismiss: (id: string) => Promise<void>;
  onMarkRead: (id: string) => Promise<void>;
}) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const unreadInGroup = notifications.filter((n) => !n.readAt).length;

  return (
    <div>
      <button
        onClick={() => setIsCollapsed(!isCollapsed)}
        className="w-full flex items-center gap-2 px-4 py-2 bg-inset border-none cursor-pointer border-b border-border-default hover:bg-surface-hover transition-colors"
      >
        {isCollapsed ? <ChevronRight size={12} className="text-fg-muted" /> : <ChevronDown size={12} className="text-fg-muted" />}
        <Folder size={12} className="text-fg-muted" />
        <span className="text-xs font-medium text-fg-secondary flex-1 text-left">{projectName}</span>
        <span className="text-[10px] text-fg-muted">
          {notifications.length}
          {unreadInGroup > 0 && (
            <span className="ml-1 inline-flex items-center justify-center min-w-[14px] h-[14px] px-0.5 rounded-full bg-accent text-fg-on-accent text-[9px] font-bold leading-none">
              {unreadInGroup}
            </span>
          )}
        </span>
      </button>
      {!isCollapsed && notifications.map((notification) => (
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
        />
      ))}
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
