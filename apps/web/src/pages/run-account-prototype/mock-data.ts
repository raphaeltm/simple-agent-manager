/**
 * PROTOTYPE ONLY. Mock data for /prototype/run-account. Never ship.
 * Stress cases: long connector names, long titles, weekly-only accounts, three windows,
 * an exhausted account, and rows carrying every right-hand badge at once.
 */
import type { AgentProfile } from '@simple-agent-manager/shared';

import type { ProfileUsage } from '../../components/project-chat/profile-picker/usage';
import type { ChatSessionResponse } from '../../lib/api';
import type { TaskInfo } from '../project-chat/useTaskGroups';

const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------
// Chat list rows
// ---------------------------------------------------------------------------

function session(
  id: string,
  topic: string,
  extra: Partial<ChatSessionResponse> & { task?: ChatSessionResponse['task'] }
): ChatSessionResponse {
  return {
    id,
    workspaceId: 'ws-1',
    taskId: extra.task?.id ?? null,
    topic,
    status: 'active',
    messageCount: 12,
    startedAt: NOW - 3 * HOUR,
    endedAt: null,
    createdAt: NOW - 3 * HOUR,
    lastMessageAt: NOW - 4 * MIN,
    isMine: true,
    isIdle: true,
    ...extra,
  };
}

export const ROWS: ChatSessionResponse[] = [
  session('s1', 'Fix flaky archive drain test', {
    task: { id: 't1', taskMode: 'task', status: 'in_progress', executionStep: 'running' },
    isIdle: false,
    lastMessageAt: NOW - 40_000,
  }),
  session('s2', 'Plan the Q1 pricing page', {
    task: {
      id: 't2',
      taskMode: 'conversation',
      triggeredBy: 'connector',
      connectorClientName: 'ChatGPT',
      status: 'in_progress',
    },
    lastMessageAt: NOW - 12 * MIN,
  }),
  session('s3', 'Ship the usage meter redesign across picker, nudge and settings', {
    task: {
      id: 't3',
      taskMode: 'task',
      triggeredBy: 'connector',
      connectorClientName: 'Claude',
      status: 'completed',
      outputPrUrl: 'https://github.com/example/repo/pull/2702',
    },
    lastMessageAt: NOW - 2 * HOUR,
  }),
  session('s4', 'Subtask: migrate the account picker', {
    task: { id: 't4', taskMode: 'task', triggeredBy: 'mcp', status: 'in_progress' },
    lastMessageAt: NOW - 25 * MIN,
  }),
  session('s5', 'Research a very long connector name that should never push the row', {
    task: {
      id: 't5',
      taskMode: 'conversation',
      triggeredBy: 'connector',
      connectorClientName: 'Claude Desktop (Acme Corp workspace connector)',
      status: 'in_progress',
    },
    lastMessageAt: NOW - 1 * DAY,
  }),
  session('s6', 'Review the dashboard copy', {
    isMine: false,
    createdByUserId: 'user-jonas',
    createdBy: {
      id: 'user-jonas',
      name: 'Jonas Albrecht',
      email: null,
      image: null,
      avatarUrl: null,
    },
    lastMessageAt: NOW - 3 * DAY,
  }),
];

function info(
  id: string,
  parentTaskId: string | null,
  triggeredBy: string,
  connectorClientName?: string
): TaskInfo {
  return {
    id,
    title: id,
    parentTaskId,
    status: 'in_progress',
    blocked: false,
    triggeredBy,
    connectorClientName,
    dispatchDepth: parentTaskId ? 1 : 0,
    taskMode: 'task',
  } as TaskInfo;
}

/** t3 dispatched t4 (so t3 is a parent and t4 a child); t2 dispatched t2a. */
export const TASK_INFO = new Map<string, TaskInfo>([
  ['t1', info('t1', null, 'user')],
  ['t2', info('t2', null, 'connector', 'ChatGPT')],
  ['t2a', info('t2a', 't2', 'mcp')],
  ['t3', info('t3', null, 'connector', 'Claude')],
  ['t4', info('t4', 't3', 'mcp')],
  ['t4a', info('t4a', 't4', 'mcp')],
  ['t5', info('t5', null, 'connector', 'Claude Desktop (Acme Corp workspace connector)')],
]);

// ---------------------------------------------------------------------------
// Accounts and their usage windows
// ---------------------------------------------------------------------------

export interface MockWindow {
  /** "5h", "Week", "Opus week": the same labels `credentialLimitWindowLabel` produces. */
  label: string;
  /** Short form for tight spots: "5h", "Wk", "Opus". */
  short: string;
  usedPercent: number;
  resetsAt: number;
}

export interface MockAccount {
  id: string;
  name: string;
  /** Which agents can run on it. */
  agentType: 'claude-code' | 'openai-codex';
  kind: string;
  windows: MockWindow[];
}

const win = (label: string, short: string, usedPercent: number, resetsIn: number): MockWindow => ({
  label,
  short,
  usedPercent,
  resetsAt: NOW + resetsIn,
});

export const ACCOUNTS: MockAccount[] = [
  {
    id: 'acc-work-max',
    name: 'Work Max',
    agentType: 'claude-code',
    kind: 'Claude Max',
    windows: [win('5h', '5h', 72, 52 * MIN), win('Week', 'Wk', 31, 4 * DAY)],
  },
  {
    id: 'acc-personal-pro',
    name: 'Personal Pro',
    agentType: 'claude-code',
    kind: 'Claude Pro',
    // Weekly only: the case that makes a single unlabeled ring ambiguous.
    windows: [win('Week', 'Wk', 94, 2 * DAY + 4 * HOUR)],
  },
  {
    id: 'acc-team-claude',
    name: 'Team seat (shared with the whole Acme engineering org)',
    agentType: 'claude-code',
    kind: 'Claude Team',
    windows: [
      win('5h', '5h', 12, 3 * HOUR),
      win('Week', 'Wk', 40, 5 * DAY),
      win('Opus week', 'Opus', 88, 5 * DAY),
    ],
  },
  {
    id: 'acc-chatgpt-pro',
    name: 'ChatGPT Pro',
    agentType: 'openai-codex',
    kind: 'ChatGPT Pro',
    windows: [win('Week', 'Wk', 40, 3 * DAY)],
  },
  {
    id: 'acc-chatgpt-team',
    name: 'ChatGPT Team',
    agentType: 'openai-codex',
    kind: 'ChatGPT Team',
    windows: [win('5h', '5h', 100, 72 * MIN), win('Week', 'Wk', 55, 6 * DAY)],
  },
];

export function accountById(id: string): MockAccount {
  const account = ACCOUNTS.find((candidate) => candidate.id === id);
  if (!account) throw new Error(`unknown mock account ${id}`);
  return account;
}

/** The window that stops the account first: the one with the least left. */
export function bindingWindow(account: MockAccount): MockWindow {
  return account.windows.reduce((worst, window) =>
    window.usedPercent > worst.usedPercent ? window : worst
  );
}

export function formatIn(at: number): string {
  const ms = Math.max(0, at - NOW);
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  const minutes = Math.round((ms % HOUR) / MIN);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

export function windowColor(usedPercent: number): string {
  if (usedPercent >= 100) return 'var(--sam-status-danger-fg)';
  if (usedPercent >= 90) return 'var(--sam-status-critical-fg)';
  if (usedPercent >= 75) return 'var(--sam-status-warning-fg)';
  return 'var(--sam-status-success-fg)';
}

/** The production `ProfileUsage` the real ring and nudge take, built from a mock account. */
export function toProfileUsage(account: MockAccount): ProfileUsage {
  const binding = bindingWindow(account);
  const left = Math.max(0, 100 - binding.usedPercent);
  const state = left <= 0 ? 'out' : binding.usedPercent >= 75 ? 'low' : 'ok';
  return {
    state,
    left,
    color: windowColor(binding.usedPercent),
    resetIn: formatIn(binding.resetsAt),
    accountLabel: account.name,
    accountKey: account.id,
  };
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

function profile(
  id: string,
  name: string,
  agentType: string,
  model: string,
  accountId: string,
  taskMode: 'conversation' | 'task' = 'conversation'
): AgentProfile & { accountId: string } {
  return {
    id,
    name,
    agentType,
    model,
    taskMode,
    accountId,
  } as unknown as AgentProfile & { accountId: string };
}

export const PROFILES = [
  profile('p-opus-personal', 'Opus Chat', 'claude-code', 'claude-opus-5-5', 'acc-personal-pro'),
  profile('p-opus-work', 'Opus Chat (Work)', 'claude-code', 'claude-opus-5-5', 'acc-work-max'),
  profile('p-opus-team', 'Opus Build', 'claude-code', 'claude-opus-5-5', 'acc-team-claude', 'task'),
  profile('p-codex', 'Codex Chat', 'openai-codex', 'gpt-5.5-codex', 'acc-chatgpt-pro'),
  profile(
    'p-codex-team',
    'Codex Build',
    'openai-codex',
    'gpt-5.5-codex',
    'acc-chatgpt-team',
    'task'
  ),
];

export type MockProfile = (typeof PROFILES)[number];

/** The profile the composer has selected in every scenario: Opus Chat on Personal Pro. */
export const OPUS_CHAT = (() => {
  const found = PROFILES.find((candidate) => candidate.id === 'p-opus-personal');
  if (!found) throw new Error('mock profile p-opus-personal missing');
  return found;
})();
