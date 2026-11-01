import type { NotificationResponse } from '@simple-agent-manager/shared';
import { Check, ChevronDown, ChevronRight, Folder, X } from 'lucide-react';
import { useState } from 'react';

import { attentionRequest } from './attention-request';
import { AttentionAnswerControls } from './AttentionAnswerControls';
import { notificationTypeConfig } from './notification-type-config';

/**
 * One notification row, and a collapsible per-project group of rows, for the bell panel.
 * Split out of `NotificationCenter` (`.claude/rules/18-file-size-limits.md`).
 */
export function NotificationItem({
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
  const config = notificationTypeConfig(notification.type);
  const Icon = config.icon;
  const isUnread = !notification.readAt;
  const { markerId, options, readable } = attentionRequest(notification);

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
        {readable && (
          <button onClick={onClick} className="mt-2 text-xs text-accent hover:underline">
            Read question & context
          </button>
        )}
        {options.length > 0 && markerId && notification.projectId && notification.sessionId && (
          <div className="mt-2">
            <AttentionAnswerControls
              projectId={notification.projectId}
              sessionId={notification.sessionId}
              markerId={markerId}
              options={options}
              onResolved={onResolved}
            />
          </div>
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

export function NotificationGroup({
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
                void onDismiss(notification.id);
              }}
              onMarkRead={(e) => {
                e.stopPropagation();
                void onMarkRead(notification.id);
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
