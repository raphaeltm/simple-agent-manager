import { ApiClientError } from '../../lib/api/client';
import type { Action } from './ActionCard';

/**
 * Plain-language names for the operations SAM may record. The server projection
 * strips every read receipt to `{}` (see `operator/projection.ts`), so reads are
 * summarized as one quiet line; only effects get a full card.
 */
const READ_LABELS: Record<string, string> = {
  sam_inbox_get: 'your inbox',
  sam_projects_list: 'projects',
  sam_project_get: 'a project',
  sam_chats_list: 'chats',
  sam_chats_search: 'chat search',
  sam_chat_read: 'a chat',
  sam_tasks_list: 'tasks',
  sam_task_get: 'a task',
  sam_ideas_search: 'ideas',
  sam_idea_get: 'an idea',
  sam_profiles_list: 'agent profiles',
};

const ACTION_TITLES: Record<string, string> = {
  sam_inbox_get: 'Check your inbox',
  sam_projects_list: 'List projects',
  sam_project_get: 'Look up a project',
  sam_chats_list: 'List chats',
  sam_chats_search: 'Search chats',
  sam_chat_read: 'Read a chat',
  sam_tasks_list: 'List tasks',
  sam_task_get: 'Look up a task',
  sam_ideas_search: 'Search ideas',
  sam_idea_get: 'Look up an idea',
  sam_profiles_list: 'List agent profiles',
  sam_chat_start: 'Start project work',
  sam_chat_send: 'Reply in a project chat',
  sam_idea_create: 'Create an idea',
  sam_idea_update: 'Update an idea',
  sam_work_stop: 'Stop work',
  sam_agent_answer: 'Answer an agent',
};

interface Confirmation {
  consequence: string;
  confirm: string;
  decline: string;
  danger: boolean;
}

const CONFIRMATIONS: Record<string, Confirmation> = {
  sam_work_stop: {
    consequence: 'This cancels the running work and shuts down its workspace.',
    confirm: 'Confirm stop',
    decline: 'Keep running',
    danger: true,
  },
  sam_agent_answer: {
    consequence: 'This sends your answer to the agent waiting in that chat.',
    confirm: 'Send answer',
    decline: 'Don’t send',
    danger: false,
  },
};

const DEFAULT_CONFIRMATION: Confirmation = {
  consequence: 'SAM needs your OK before doing this.',
  confirm: 'Confirm',
  decline: 'Decline',
  danger: false,
};

function humanize(operation: string): string {
  const words = operation.replace(/^sam_/, '').replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Only a read that completed joins the quiet summary; any other state keeps its own card. */
export function isReadReceipt(action: Action): boolean {
  if (action.state !== 'completed' || action.available === false) return false;
  return (
    action.operation in READ_LABELS || (action.input_json === '{}' && action.result_json === null)
  );
}

/** "your inbox, projects and tasks" — de-duplicated, in first-use order. */
export function describeReads(actions: Action[]): string {
  const labels = [
    ...new Set(
      actions.map((action) => READ_LABELS[action.operation] ?? humanize(action.operation))
    ),
  ];
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

export function effectTitle(operation: string): string {
  return ACTION_TITLES[operation] ?? humanize(operation);
}

export function confirmationCopy(operation: string): Confirmation {
  return CONFIRMATIONS[operation] ?? DEFAULT_CONFIRMATION;
}

/**
 * What an agent answer would send, in words, so it is visible before approval.
 * Form values never pass through SAM (the server refuses them), so a recorded
 * answer is a decline, a chosen option, or an attention answer.
 */
export function proposedAnswer(action: Action): string | null {
  if (action.operation !== 'sam_agent_answer') return null;
  const input = parseObject(action.input_json);
  if (input?.decline === true) return 'Decline the agent\u2019s request';
  const option = text(input?.optionId);
  if (option) return `Choose \u201c${option}\u201d`;
  const answer = text(input?.answer);
  if (answer) return `Answer \u201c${answer}\u201d`;
  return null;
}

function parseObject(json: string | null): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(json ?? 'null');
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export interface ActionTarget {
  projectId: string;
  /** In-app path to review the target before confirming, or to open it afterwards. */
  path: string;
  kind: 'chat' | 'task' | 'idea' | 'project';
}

/** The project resource an effect points at, from its recorded input. */
export function actionTarget(action: Action): ActionTarget | null {
  const input = parseObject(action.input_json);
  const projectId = text(input?.projectId);
  if (!projectId) return null;
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const sessionId = text(input?.sessionId);
  if (sessionId)
    return { projectId, kind: 'chat', path: `${base}/chat/${encodeURIComponent(sessionId)}` };
  const taskId = text(input?.taskId);
  if (taskId)
    return { projectId, kind: 'task', path: `${base}/tasks/${encodeURIComponent(taskId)}` };
  const ideaId = text(input?.ideaId);
  if (ideaId)
    return { projectId, kind: 'idea', path: `${base}/ideas/${encodeURIComponent(ideaId)}` };
  return { projectId, kind: 'project', path: base };
}

export interface ResultLink {
  href: string;
  /** Same-origin links navigate in-app; anything else opens a new tab. */
  internal: boolean;
  label: string;
}

/** A safe link recorded in the action result (https, or http on this origin). */
export function resultLink(json: string | null): ResultLink | null {
  const link = text(parseObject(json)?.link);
  if (!link) return null;
  try {
    const url = new URL(link, window.location.origin);
    const internal = url.origin === window.location.origin;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && internal)) return null;
    return {
      href: internal ? `${url.pathname}${url.search}${url.hash}` : url.href,
      internal,
      label: linkLabel(url.pathname),
    };
  } catch {
    return null;
  }
}

export function linkLabel(path: string): string {
  if (path.includes('/chat/')) return 'Open chat';
  if (path.includes('/tasks/')) return 'Open task';
  if (path.includes('/ideas/')) return 'Open idea';
  return 'Open project';
}

export function resultMessage(json: string | null): string | null {
  return text(parseObject(json)?.message);
}

/** Pretty JSON for the "Exact request" disclosure; raw text if it is not JSON. */
export function prettyJson(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

/**
 * Server rejections carry a message worth showing. A failed `fetch` throws a
 * browser-specific TypeError ("Failed to fetch", "Load failed"), so say what it means.
 */
export function requestErrorText(cause: unknown, fallback: string): string {
  if (cause instanceof ApiClientError) return cause.message;
  if (cause instanceof TypeError) return 'Couldn’t reach SAM. Check your connection and try again.';
  return cause instanceof Error ? cause.message : fallback;
}
