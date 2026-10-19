import {
  Activity,
  Box,
  Check,
  ListTodo,
  type LucideIcon,
  Pause,
  Play,
  Plus,
  Reply,
  RotateCw,
  UserMinus,
  UserPlus,
  X,
} from 'lucide-react';
import { useContext } from 'react';

import { useProjectMembers } from '../hooks/useProjectMembers';
import type { ActivityEventResponse } from '../lib/api';
import { maybeJsonRecord } from '../lib/runtime-validation';
import { formatRelativeTime } from '../lib/time-utils';
import { ProjectContext } from '../pages/ProjectContext';
import { useAuth } from './AuthProvider';

interface ActivityFeedProps {
  events: ActivityEventResponse[];
  hasMore: boolean;
  onLoadMore: () => void;
  loading?: boolean;
}

const SUCCESS = 'var(--sam-color-success, #2ea043)';
const MUTED = 'var(--sam-color-fg-muted, #8b949e)';
const DANGER = 'var(--sam-color-danger, #f85149)';
const WARNING = 'var(--sam-color-warning, #d29922)';
const INFO = 'var(--sam-color-info, #3b82f6)';

interface EventStyle {
  icon: LucideIcon;
  color: string;
}

/**
 * Icon and colour per event type — an explicit allowlist. The previous predicates were
 * negative-form ("any `session.*` that is not `session.started` is a stop"), so every new
 * session event rendered as a stopped session (`.claude/rules/79`). A type missing from this
 * table falls back to its family's neutral style below, never to another event's meaning.
 */
const EVENT_STYLES: Record<string, EventStyle> = {
  'workspace.created': { icon: Plus, color: SUCCESS },
  'workspace.stopped': { icon: Pause, color: MUTED },
  'workspace.restarted': { icon: RotateCw, color: WARNING },
  'session.started': { icon: Play, color: SUCCESS },
  'session.stopped': { icon: Pause, color: MUTED },
  'session.failed': { icon: X, color: DANGER },
  'session.idle_cleanup': { icon: Pause, color: MUTED },
  'session.access_granted': { icon: UserPlus, color: INFO },
  'session.access_revoked': { icon: UserMinus, color: MUTED },
  'session.shared_answer': { icon: Reply, color: INFO },
  'task.completed': { icon: Check, color: SUCCESS },
  'task.failed': { icon: X, color: DANGER },
  'task.cancelled': { icon: X, color: MUTED },
  'task.in_progress': { icon: Play, color: WARNING },
};

function getEventStyle(eventType: string): EventStyle {
  const style = EVENT_STYLES[eventType];
  if (style) return style;
  // e.g. `session.wake_failed`, `session.idle_cleanup_failed`.
  if (eventType.includes('failed') || eventType.includes('error')) {
    return { icon: X, color: DANGER };
  }
  if (eventType.startsWith('workspace.')) return { icon: Box, color: MUTED };
  if (eventType.startsWith('task.')) return { icon: ListTodo, color: MUTED };
  return { icon: Activity, color: MUTED };
}

/**
 * A user id as "you" (the viewer) or a teammate's name; null when the id is missing or not a
 * known member. `midSentence` lowercases "you" for use inside a description.
 */
type PersonLabel = (userId: string | null, midSentence?: boolean) => string | null;

function formatEventDescription(event: ActivityEventResponse, personLabel: PersonLabel): string {
  const payload = maybeJsonRecord(event.payload);

  switch (event.eventType) {
    case 'workspace.created': {
      const name = payload?.name as string | undefined;
      return name ? `Workspace "${name}" created` : 'Workspace created';
    }
    case 'workspace.stopped':
      return 'Workspace stopped';
    case 'workspace.restarted':
      return 'Workspace restarted';
    case 'session.started': {
      const topic = payload?.topic as string | undefined;
      return topic ? `Chat session started: ${topic}` : 'Chat session started';
    }
    case 'session.stopped': {
      const msgCount = payload?.message_count as number | undefined;
      return msgCount ? `Chat session stopped (${msgCount} messages)` : 'Chat session stopped';
    }
    case 'session.failed': {
      const errMsg = payload?.error as string | undefined;
      return errMsg ? `Chat session failed: ${errMsg}` : 'Chat session failed';
    }
    case 'session.access_granted': {
      const grantee = personLabel(stringField(payload?.granteeUserId), true);
      return grantee ? `Shared this session with ${grantee}` : 'Shared this session';
    }
    case 'session.access_revoked': {
      // `departedUserId` when the system revoked access because someone left the project.
      const targetId = stringField(payload?.granteeUserId) ?? stringField(payload?.departedUserId);
      if (targetId && targetId === event.actorId) return 'Left a shared session';
      const target = personLabel(targetId, true);
      return target ? `Removed shared access for ${target}` : 'Removed shared access';
    }
    case 'session.shared_answer':
      return 'Answered the agent (shared access)';
    default:
      if (event.eventType.startsWith('task.')) {
        const title = payload?.title as string | undefined;
        const toStatus = payload?.toStatus as string | undefined;
        if (title && toStatus) {
          return `Task "${title}" ${toStatus.replace('_', ' ')}`;
        }
        return `Task ${event.eventType.replace('task.', '').replace('_', ' ')}`;
      }
      return event.eventType.replace(/\./g, ' ').replace(/_/g, ' ');
  }
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function formatActorLabel(event: ActivityEventResponse, personLabel: PersonLabel): string {
  const payload = maybeJsonRecord(event.payload);
  if (event.actorType === 'system') return 'System';
  if (event.actorType === 'workspace_callback') return 'Agent';
  // In a shared project the actor is often a teammate, so "You" only when it really is you.
  // An event without an actor id predates actor attribution and was always the viewer's own.
  const who =
    event.actorType === 'user'
      ? event.actorId
        ? (personLabel(event.actorId) ?? 'A teammate')
        : 'You'
      : event.actorType;
  if (payload?.via === 'connector') {
    return `${who} via ${typeof payload.clientName === 'string' ? payload.clientName : 'Connector'}`;
  }
  return who;
}

export function ActivityFeed({ events, hasMore, onLoadMore, loading }: ActivityFeedProps) {
  const { user } = useAuth();
  const viewerId = user?.id ?? null;
  // Optional: the feed renders inside a project page, where member names label the actors.
  const projectId = useContext(ProjectContext)?.projectId ?? null;
  const { allMembers } = useProjectMembers(projectId);
  const personLabel: PersonLabel = (userId, midSentence = false) => {
    if (!userId) return null;
    if (userId === viewerId) return midSentence ? 'you' : 'You';
    const member = allMembers.find((candidate) => candidate.userId === userId);
    return member?.name || member?.email?.split('@')[0] || null;
  };

  if (events.length === 0 && !loading) {
    return <div className="text-fg-muted text-sm p-4 text-center">No activity yet.</div>;
  }

  return (
    <div>
      <ul className="m-0 p-0 list-none">
        {events.map((event) => {
          const { icon: Icon, color } = getEventStyle(event.eventType);
          return (
            <li key={event.id} className="flex gap-3 py-3 px-4 border-b border-border-default">
              {/* Icon */}
              <div
                className="w-7 h-7 rounded-full text-fg-on-accent flex items-center justify-center shrink-0 mt-0.5"
                style={{ backgroundColor: color }}
                data-event-icon={event.eventType}
              >
                <Icon size={14} aria-hidden="true" />
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="text-sm text-fg-primary leading-snug">
                  {formatEventDescription(event, personLabel)}
                </div>
                <div className="flex gap-2 text-xs text-fg-muted mt-0.5">
                  <span>{formatActorLabel(event, personLabel)}</span>
                  <span className="opacity-50">-</span>
                  <span>{formatRelativeTime(event.createdAt)}</span>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {hasMore && (
        <div className="py-3 px-4 text-center">
          <button
            onClick={onLoadMore}
            disabled={loading}
            className="py-2 px-4 text-xs text-fg-primary bg-inset border border-border-default rounded-md cursor-pointer disabled:cursor-default disabled:opacity-60"
          >
            {loading ? 'Loading...' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}
