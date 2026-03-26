import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertCircle,
  CheckCircle2,
  MessageSquare,
  GitPullRequest,
  Activity,
  HelpCircle,
  ChevronDown,
  ChevronRight,
  Check,
  X,
} from 'lucide-react';
import type { NotificationResponse, NotificationType } from '@simple-agent-manager/shared';
import { NOTIFICATION_TYPES } from '@simple-agent-manager/shared';
import { Spinner } from '@simple-agent-manager/ui';
import {
  listNotifications,
  markNotificationRead,
  dismissNotification,
} from '../lib/api';
import { useProjectContext } from './ProjectContext';

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

const TYPE_FILTER_OPTIONS: { value: NotificationType | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  ...NOTIFICATION_TYPES.map((t) => ({ value: t, label: NOTIFICATION_TYPE_CONFIG[t].label })),
];

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function getFullMessage(notification: NotificationResponse): string | null {
  const fullMessage = notification.metadata?.fullMessage as string | undefined;
  return fullMessage || notification.body;
}

export function ProjectNotifications() {
  const { projectId } = useProjectContext();
  const navigate = useNavigate();

  const [notifications, setNotifications] = useState<NotificationResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<NotificationType | 'all'>('all');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const notificationsRef = useRef(notifications);
  notificationsRef.current = notifications;

  const loadNotifications = useCallback(async (loadMore = false, filterType?: NotificationType | 'all') => {
    try {
      setLoading(true);
      const activeFilter = filterType ?? typeFilter;
      const result = await listNotifications({
        projectId,
        limit: 50,
        cursor: loadMore ? nextCursor ?? undefined : undefined,
        type: activeFilter === 'all' ? undefined : activeFilter,
      });
      if (loadMore) {
        setNotifications((prev) => [...prev, ...result.notifications]);
      } else {
        setNotifications(result.notifications);
      }
      setNextCursor(result.nextCursor);
      setHasMore(result.nextCursor !== null);
    } catch {
      // Best-effort
    } finally {
      setLoading(false);
    }
  }, [projectId, typeFilter, nextCursor]);

  useEffect(() => { void loadNotifications(); }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleTypeFilterChange = (newFilter: NotificationType | 'all') => {
    setTypeFilter(newFilter);
    setNextCursor(null);
    void loadNotifications(false, newFilter);
  };

  const handleMarkRead = async (id: string) => {
    await markNotificationRead(id);
    setNotifications((prev) =>
      prev.map((n) => n.id === id ? { ...n, readAt: new Date().toISOString() } : n)
    );
  };

  const handleDismiss = async (id: string) => {
    await dismissNotification(id);
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  };

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleNotificationClick = (notification: NotificationResponse) => {
    if (notification.actionUrl) {
      navigate(notification.actionUrl);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-fg-primary">Notifications</h1>
      </div>

      {/* Type filter chips */}
      <div className="flex flex-wrap gap-2">
        {TYPE_FILTER_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => handleTypeFilterChange(opt.value)}
            className={`px-3 py-1 text-xs rounded-full border cursor-pointer transition-colors ${
              typeFilter === opt.value
                ? 'bg-accent text-white border-accent'
                : 'bg-surface border-border-default text-fg-secondary hover:bg-surface-hover'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Notification list */}
      <section className="border border-border-default rounded-md bg-surface overflow-hidden">
        {loading && notifications.length === 0 ? (
          <div className="flex items-center justify-center py-12 gap-2">
            <Spinner size="md" />
            <span className="text-sm text-fg-muted">Loading notifications...</span>
          </div>
        ) : notifications.length === 0 ? (
          <div className="text-center py-12 text-fg-muted text-sm">
            No notifications yet.
          </div>
        ) : (
          <>
            {notifications.map((notification) => {
              const config = NOTIFICATION_TYPE_CONFIG[notification.type];
              const Icon = config.icon;
              const isUnread = !notification.readAt;
              const fullMessage = getFullMessage(notification);
              const isLong = fullMessage != null && fullMessage.length > 300;
              const isExpanded = expandedIds.has(notification.id);
              const displayMessage = isLong && !isExpanded
                ? fullMessage.slice(0, 300) + '\u2026'
                : fullMessage;

              return (
                <div
                  key={notification.id}
                  className={`group flex gap-3 px-4 py-3 border-b border-border-default transition-colors hover:bg-surface-hover ${
                    isUnread ? 'bg-inset' : ''
                  }`}
                >
                  {/* Type icon */}
                  <div className={`flex-shrink-0 mt-0.5 ${config.color}`}>
                    <Icon size={16} />
                  </div>

                  {/* Content */}
                  <div
                    className="flex-1 min-w-0 cursor-pointer"
                    onClick={() => handleNotificationClick(notification)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleNotificationClick(notification); }}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className={`text-sm leading-tight ${isUnread ? 'font-medium text-fg-primary' : 'text-fg-secondary'}`}>
                        {notification.title}
                      </p>
                      {isUnread && (
                        <span className="flex-shrink-0 w-2 h-2 rounded-full bg-accent mt-1.5" />
                      )}
                    </div>
                    {displayMessage && (
                      <p className="text-xs text-fg-muted mt-1 whitespace-pre-wrap break-words">
                        {displayMessage}
                      </p>
                    )}
                    {isLong && (
                      <button
                        onClick={(e) => { e.stopPropagation(); toggleExpand(notification.id); }}
                        className="text-xs text-accent mt-1 bg-transparent border-none cursor-pointer hover:underline p-0"
                      >
                        {isExpanded ? (
                          <span className="flex items-center gap-1"><ChevronDown size={12} /> Show less</span>
                        ) : (
                          <span className="flex items-center gap-1"><ChevronRight size={12} /> Show more</span>
                        )}
                      </button>
                    )}
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-[10px] text-fg-muted">{timeAgo(notification.createdAt)}</span>
                      <span className="text-[10px] text-fg-muted">&middot;</span>
                      <span className="text-[10px] text-fg-muted">{config.label}</span>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex-shrink-0 flex flex-col gap-1 opacity-0 group-hover:opacity-100">
                    {isUnread && (
                      <button
                        onClick={() => void handleMarkRead(notification.id)}
                        className="p-0.5 bg-transparent border-none text-fg-muted cursor-pointer hover:text-fg-primary"
                        aria-label="Mark as read"
                        title="Mark as read"
                      >
                        <Check size={12} />
                      </button>
                    )}
                    <button
                      onClick={() => void handleDismiss(notification.id)}
                      className="p-0.5 bg-transparent border-none text-fg-muted cursor-pointer hover:text-danger-fg"
                      aria-label="Dismiss"
                      title="Dismiss"
                    >
                      <X size={12} />
                    </button>
                  </div>
                </div>
              );
            })}

            {/* Load more */}
            {hasMore && (
              <div className="flex justify-center py-3">
                <button
                  onClick={() => void loadNotifications(true)}
                  disabled={loading}
                  className="text-sm text-accent bg-transparent border-none cursor-pointer hover:underline disabled:opacity-50"
                >
                  {loading ? 'Loading...' : 'Load more'}
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
