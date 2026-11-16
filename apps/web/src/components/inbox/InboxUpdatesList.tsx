import type { NotificationResponse } from '@simple-agent-manager/shared';
import { Spinner } from '@simple-agent-manager/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, X } from 'lucide-react';
import { useMemo } from 'react';
import { useNavigate } from 'react-router';

import { useQueryScope } from '../../hooks/useQueryScope';
import { dismissNotification, markNotificationRead } from '../../lib/api';
import { notificationQueryKeys, notificationsListQueryOptions } from '../../lib/query-options';
import { maybeJsonRecord } from '../../lib/runtime-validation';
import {
  isUpdateNotification,
  notificationTypeConfig,
} from '../notifications/notification-type-config';
import { formatAge } from './inbox-model';

/** Page size of the Updates list (the same first page the notification socket keeps fresh). */
const UPDATES_PAGE_SIZE = 50;

function projectLabel(notification: NotificationResponse): string | null {
  const name = maybeJsonRecord(notification.metadata)?.projectName;
  return typeof name === 'string' && name ? name : null;
}

/** Unread FYI notifications, for the Updates chip count. */
export function useInboxUpdates(projectId: string | null) {
  const scope = useQueryScope();
  const params = useMemo(
    () => (projectId ? { limit: UPDATES_PAGE_SIZE, projectId } : { limit: UPDATES_PAGE_SIZE }),
    [projectId]
  );
  const query = useQuery({
    ...notificationsListQueryOptions(scope, params),
    enabled: Boolean(scope),
  });
  const updates = useMemo(
    () =>
      (query.data?.notifications ?? []).filter(
        (notification) => isUpdateNotification(notification.type) && !notification.dismissedAt
      ),
    [query.data]
  );
  return {
    updates,
    unread: updates.filter((notification) => !notification.readAt).length,
    loaded: query.data !== undefined,
    error: query.error,
  };
}

/**
 * Updates: today's FYI notifications (finished tasks, PRs, mentions, failures), which are not
 * asks and so are not inbox items. Push notifications and preferences are unchanged.
 */
export function InboxUpdatesList({
  projectId,
  showProject,
  now,
}: {
  projectId: string | null;
  showProject: boolean;
  now: number;
}) {
  const navigate = useNavigate();
  const scope = useQueryScope();
  const queryClient = useQueryClient();
  const { updates, loaded, error } = useInboxUpdates(projectId);
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: notificationQueryKeys.all(scope) });

  if (!loaded) {
    return error ? (
      <p role="alert" className="m-0 px-4 py-6 text-sm text-danger-fg">
        Could not load updates: {error.message}
      </p>
    ) : (
      <div className="flex justify-center py-10" role="status" aria-label="Loading updates">
        <Spinner size="sm" />
      </div>
    );
  }
  if (updates.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-14 text-center" role="status">
        <span className="sam-well grid h-12 w-12 place-items-center rounded-full text-fg-muted">
          <Bell size={22} aria-hidden="true" />
        </span>
        <p className="m-0 text-[15px] font-semibold text-fg-primary">No updates</p>
        <p className="m-0 max-w-[280px] text-sm text-fg-muted">
          Finished tasks, pull requests and mentions show up here.
        </p>
      </div>
    );
  }
  return (
    <ul className="m-0 flex flex-col gap-0.5 p-2" aria-label="Updates">
      {updates.map((notification) => {
        const config = notificationTypeConfig(notification.type);
        const Icon = config.icon;
        const project = showProject ? projectLabel(notification) : null;
        const open = () => {
          if (!notification.readAt) void markNotificationRead(notification.id).then(refresh);
          // In-app paths only: `//host` would be protocol-relative.
          if (notification.actionUrl && /^\/(?![/\\])/.test(notification.actionUrl))
            navigate(notification.actionUrl);
        };
        return (
          <li key={notification.id} className="flex list-none items-start gap-1 rounded-xl">
            <button
              type="button"
              onClick={open}
              className="flex min-w-0 flex-1 cursor-pointer items-start gap-3 rounded-xl border-0 bg-transparent px-3 py-2.5 text-left hover:bg-[var(--sam-glass-v2-raised)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            >
              <span
                aria-hidden="true"
                className={`sam-well grid h-8 w-8 shrink-0 place-items-center rounded-full ${config.color}`}
              >
                <Icon size={15} />
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={`block text-sm break-words [overflow-wrap:anywhere] ${notification.readAt ? 'text-fg-secondary' : 'font-medium text-fg-primary'}`}
                >
                  {notification.title}
                </span>
                {notification.body && (
                  <span className="mt-0.5 line-clamp-2 block text-xs break-words text-fg-muted [overflow-wrap:anywhere]">
                    {notification.body}
                  </span>
                )}
                <span className="mt-0.5 flex min-w-0 flex-wrap gap-x-1 text-xs text-fg-muted">
                  <span>{config.label}</span>
                  {project && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="min-w-0 max-w-full truncate">{project}</span>
                    </>
                  )}
                  <span aria-hidden="true">·</span>
                  <span>{formatAge(notification.createdAt, now)}</span>
                </span>
              </span>
            </button>
            <button
              type="button"
              aria-label={`Dismiss ${notification.title}`}
              onClick={() => void dismissNotification(notification.id).then(refresh)}
              className="grid h-11 w-11 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-transparent text-fg-muted hover:text-fg-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            >
              <X size={15} aria-hidden="true" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
