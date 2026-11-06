/**
 * Builders for SAM notices: the human-readable description the chat UI shows for a message
 * SAM injected into a conversation. Each builder takes only data the caller already has and
 * returns a bounded notice; none of them changes the text the agent receives.
 */
import {
  buildSamNotice,
  OPERATIONS_ACTION_LABELS,
  OPERATIONS_ACTION_TARGET_TYPES,
  type OperationsAction,
  PROJECT_EVENT_CHANNEL_SOURCE,
  type ProjectEventRecord,
  type SamNotice,
  type SamNoticeRef,
  type SamNoticeSeverity,
} from '@simple-agent-manager/shared';

import { log } from '../lib/logger';

const PROJECT_LIFECYCLE_SOURCE = 'sam.lifecycle';

/**
 * A notice is display data. Building one must never stop the message it describes from being
 * delivered, so callers on delivery paths wrap the builder in this.
 */
export function safeNotice(
  build: () => SamNotice | null,
  context: Record<string, unknown>
): SamNotice | null {
  try {
    return build();
  } catch (error) {
    log.error('sam_notice.build_failed', {
      ...context,
      error: error instanceof Error ? error.message : String(error),
      action: 'delivered_without_notice',
    });
    return null;
  }
}

/** Plain-English task status for cards. */
export function taskStatusLabel(status: string): string {
  switch (status) {
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    case 'in_progress':
      return 'Running';
    case 'sleeping':
      return 'Asleep';
    case 'missing':
      return 'Not found';
    default:
      return humanize(status);
  }
}

function humanize(value: string): string {
  const spaced = value.replace(/[._-]+/g, ' ').trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : value;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

// ── Subtasks ────────────────────────────────────────────────────────────────

export interface ChildTaskSnapshot {
  taskId: string;
  status: string;
  title: string | null;
}

/** wait_for_subtasks resolved: which children finished, failed or are still going. */
export function parentWakeNotice(
  children: readonly ChildTaskSnapshot[],
  reason: 'condition_met' | 'deadline_reached'
): SamNotice {
  const completed = children.filter((c) => c.status === 'completed').length;
  const failed = children.filter((c) => c.status === 'failed').length;
  const cancelled = children.filter((c) => c.status === 'cancelled').length;
  const unfinished = children.length - completed - failed - cancelled;
  const severity: SamNoticeSeverity =
    failed > 0 ? 'error' : completed === children.length ? 'success' : 'info';

  let headline: string;
  const only = children.length === 1 ? children[0] : undefined;
  if (only) {
    const verb =
      only.status === 'completed'
        ? 'Subtask finished'
        : only.status === 'failed'
          ? 'Subtask failed'
          : only.status === 'cancelled'
            ? 'Subtask cancelled'
            : 'Subtask update';
    headline = only.title ? `${verb}: ${only.title}` : verb;
  } else {
    const parts = [
      completed > 0 ? `${completed} finished` : null,
      failed > 0 ? `${failed} failed` : null,
      cancelled > 0 ? `${cancelled} cancelled` : null,
      unfinished > 0 ? `${unfinished} still going` : null,
    ].filter(Boolean);
    headline = `${plural(children.length, 'subtask', 'subtasks')}: ${parts.join(', ')}`;
  }

  return buildSamNotice({
    type: failed > 0 ? 'subtask.failed' : 'subtask.completed',
    headline,
    detail:
      reason === 'deadline_reached'
        ? 'The wait ran out of time before every subtask finished.'
        : null,
    severity,
    refs: children.map((child) => ({
      kind: 'task',
      id: child.taskId,
      label: child.title,
      status: taskStatusLabel(child.status),
    })),
  });
}

// ── Project events (subscriptions and agent message channels) ───────────────

function eventSeverity(event: ProjectEventRecord): SamNoticeSeverity {
  // `warning` severity (amber) is reserved for notices that wait on the human (SAM Glass:
  // amber means it's waiting on you), so an event's own warning level stays neutral.
  if (event.severity === 'error' || event.severity === 'critical') return 'error';
  if (event.source === PROJECT_LIFECYCLE_SOURCE && event.eventType === 'task.completed') {
    return 'success';
  }
  return 'info';
}

function sourceLabel(source: string): string {
  if (source === 'github') return 'GitHub';
  if (source.startsWith('sam.')) return 'SAM';
  return humanize(source);
}

function eventHeadline(event: ProjectEventRecord): string {
  // SAM-sourced titles are SAM-authored ("Task completed"); external titles are not, so
  // they become card labels instead of the headline.
  if (event.source.startsWith('sam.') && event.display.title) return event.display.title;
  return `${sourceLabel(event.source)}: ${humanize(event.eventType)}`;
}

const SUBJECT_REF_KINDS: Record<string, SamNoticeRef['kind']> = {
  task: 'task',
  pull_request: 'pull_request',
  session: 'session',
  chat_session: 'session',
  schedule: 'schedule',
  node: 'node',
  idea: 'idea',
};

function eventRef(event: ProjectEventRecord): SamNoticeRef {
  const kind = SUBJECT_REF_KINDS[event.subject.type];
  const label = event.display.summary ?? event.display.title ?? null;
  if (kind) {
    return { kind, id: event.subject.id, label, url: event.display.url ?? null };
  }
  return {
    kind: 'event',
    id: event.id,
    label: event.display.title ?? humanize(event.eventType),
    url: event.display.url ?? null,
  };
}

function channelMessageText(event: ProjectEventRecord): string | null {
  const message = event.metadata.message;
  return typeof message === 'string' ? message : null;
}

function channelActorTaskId(event: ProjectEventRecord): string | null {
  const actor = event.metadata.actor;
  if (!actor || typeof actor !== 'object' || Array.isArray(actor)) return null;
  const taskId = (actor as Record<string, unknown>).taskId;
  return typeof taskId === 'string' && taskId ? taskId : null;
}

/** A wake for one batch of project events. Events arrive in batch order. */
export function projectEventWakeNotice(events: readonly ProjectEventRecord[]): SamNotice | null {
  if (events.length === 0) return null;
  const channelEvents = events.filter((event) => event.source === PROJECT_EVENT_CHANNEL_SOURCE);

  if (channelEvents.length === events.length) {
    const senders = [
      ...new Set(channelEvents.map(channelActorTaskId).filter((id): id is string => !!id)),
    ];
    const first = channelMessageText(channelEvents[0]!);
    return buildSamNotice({
      type: 'agent.message',
      headline:
        channelEvents.length === 1
          ? 'Message from another agent'
          : `${channelEvents.length} messages from other agents`,
      detail:
        channelEvents.length > 1
          ? 'The first one is shown. The agent reads the rest from the channel.'
          : null,
      severity: 'info',
      quote: first ? { from: 'Another agent', text: first } : null,
      refs: senders.map((taskId) => ({ kind: 'task', id: taskId, label: null })),
    });
  }

  const severities = events.map(eventSeverity);
  const severity: SamNoticeSeverity = severities.includes('error')
    ? 'error'
    : severities.every((s) => s === 'success')
      ? 'success'
      : 'info';
  const only = events.length === 1 ? events[0] : undefined;
  return buildSamNotice({
    type: only ? `event.${only.eventType}` : 'event.batch',
    headline: only ? eventHeadline(only) : `${events.length} project updates`,
    severity,
    refs: events.map(eventRef),
  });
}

// ── Operations approvals ────────────────────────────────────────────────────

export function operationsDecisionNotice(approval: {
  id: string;
  action: OperationsAction;
  targetId: string;
  status: string;
  decisionNote?: string | null;
}): SamNotice {
  const approved = approval.status === 'approved';
  const actionLabel = OPERATIONS_ACTION_LABELS[approval.action] ?? humanize(approval.action);
  const targetType = OPERATIONS_ACTION_TARGET_TYPES[approval.action];
  const targetKind: SamNoticeRef['kind'] | null =
    targetType === 'node'
      ? 'node'
      : targetType === 'task'
        ? 'task'
        : targetType === 'chat_session'
          ? 'session'
          : null;
  return buildSamNotice({
    type: approved ? 'ops.approved' : 'ops.denied',
    headline: `${approved ? 'Approved' : 'Denied'}: ${actionLabel.toLowerCase()}`,
    detail: approved ? 'The agent can run this action once.' : 'The agent was told not to run it.',
    severity: approved ? 'success' : 'info',
    quote: approval.decisionNote ? { from: "Approver's note", text: approval.decisionNote } : null,
    refs: [
      {
        kind: 'approval',
        id: approval.id,
        label: actionLabel,
        status: approved ? 'Approved' : 'Denied',
      },
      ...(targetKind ? [{ kind: targetKind, id: approval.targetId, label: null }] : []),
    ],
  });
}

// ── Messages from other agents ──────────────────────────────────────────────

export function agentMailboxNotice(input: {
  senderTaskId: string | null;
  senderTaskTitle: string | null;
  message: string;
}): SamNotice {
  return buildSamNotice({
    type: 'agent.message',
    headline: 'Message from another agent',
    severity: 'info',
    quote: {
      from: input.senderTaskTitle ? `Agent on “${input.senderTaskTitle}”` : 'Another agent',
      text: input.message,
    },
    refs: input.senderTaskId
      ? [{ kind: 'task', id: input.senderTaskId, label: input.senderTaskTitle }]
      : [],
  });
}

export function parentAgentMessageNotice(input: {
  parentTaskId: string | null;
  parentTaskTitle: string | null;
  message: string;
}): SamNotice {
  return buildSamNotice({
    type: 'agent.parent_message',
    headline: 'Message from the agent that started this task',
    severity: 'info',
    quote: { from: 'Parent agent', text: input.message },
    refs: input.parentTaskId
      ? [{ kind: 'task', id: input.parentTaskId, label: input.parentTaskTitle }]
      : [],
  });
}

// ── Schedules, triggers, recovery and check-ins ─────────────────────────────

export function scheduledMessageNotice(input: {
  scheduleId: string;
  prompt: string;
  reason: string | null;
  createdByThisChat: boolean;
}): SamNotice {
  return buildSamNotice({
    type: 'schedule.due',
    headline: input.createdByThisChat
      ? 'Scheduled reminder the agent set for itself'
      : 'Scheduled message from another chat',
    detail: input.reason,
    severity: 'info',
    quote: { from: 'Scheduled message', text: input.prompt },
    refs: [{ kind: 'schedule', id: input.scheduleId, label: input.reason }],
  });
}

export function githubTriggerNotice(input: { triggerId: string; prompt: string }): SamNotice {
  return buildSamNotice({
    type: 'github.trigger',
    headline: 'A GitHub trigger sent this chat a message',
    severity: 'info',
    // The rendered template contains GitHub content, which is not SAM's.
    quote: { from: 'GitHub trigger', text: input.prompt },
    refs: [],
  });
}

export function restoredSessionNotice(): SamNotice {
  return buildSamNotice({
    type: 'session.resumed',
    headline: 'Chat woke up and picked up where it left off',
    severity: 'info',
    refs: [],
  });
}

export function stallCheckinNotice(idleDurationMs: number): SamNotice {
  const minutes = Math.max(1, Math.round(idleDurationMs / 60_000));
  return buildSamNotice({
    type: 'checkin.stalled',
    headline: 'SAM asked the agent for a progress update',
    detail: `No activity for ${plural(minutes, 'minute', 'minutes')}. If the agent doesn't reply soon, the task is marked failed.`,
    severity: 'info',
    refs: [],
  });
}
