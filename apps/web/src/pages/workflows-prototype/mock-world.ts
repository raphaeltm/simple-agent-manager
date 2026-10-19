/**
 * PROTOTYPE ONLY — synthetic world for the Workflows exploration.
 *
 * Reuses the fictional Northwind Labs "Payments API" project that the marketing
 * screenshot specs use (tests/playwright/marketing-shots-helpers.ts), so these
 * screens read as the same product. No real tenant data.
 */
import type { ChatSessionListItem } from '../../lib/api';
import type { TaskInfo } from '../project-chat/useTaskGroups';
import type { ProfileRef } from './model';

export const PROJECT = {
  id: 'proj-payments',
  name: 'Payments API',
  repository: 'northwind-labs/payments-api',
};

export const OWNER = { id: 'user-priya', name: 'Priya Natarajan', short: 'Priya' };

export const PROFILES: Record<string, ProfileRef> = {
  opus: { id: 'opus', name: 'Claude Code — Opus 5', agentType: 'claude-code', runtime: 'vm' },
  codex: { id: 'codex', name: 'Codex 5.5 High', agentType: 'openai-codex', runtime: 'vm' },
  gemini: {
    id: 'gemini',
    name: 'Gemini CLI Reviewer',
    agentType: 'google-gemini',
    runtime: 'instant',
  },
  brainstormer: {
    id: 'brainstormer',
    name: 'Brainstormer',
    agentType: 'claude-code',
    runtime: 'instant',
  },
  cto: { id: 'cto', name: 'Picky CTO', agentType: 'claude-code', runtime: 'instant' },
};

/** Fixed at module load so relative times read the same in every screenshot. */
const NOW = Date.now();
const min = (m: number) => NOW - m * 60_000;

interface SessionSeed {
  id: string;
  taskId: string;
  topic: string;
  ago: number;
  state: 'running' | 'idle' | 'done' | 'failed' | 'sleeping' | 'cancelled';
  mode: 'task' | 'conversation';
  messages?: number;
}

function toSession(seed: SessionSeed): ChatSessionListItem {
  const taskStatus =
    seed.state === 'running'
      ? 'in_progress'
      : seed.state === 'done'
        ? 'completed'
        : seed.state === 'failed'
          ? 'failed'
          : seed.state === 'cancelled'
            ? 'cancelled'
            : 'in_progress';
  return {
    id: seed.id,
    workspaceId: `ws-${seed.id}`,
    taskId: seed.taskId,
    topic: seed.topic,
    status:
      seed.state === 'sleeping' ? 'sleeping' : seed.state === 'running' ? 'active' : 'stopped',
    messageCount: seed.messages ?? 12,
    startedAt: min(seed.ago + 30),
    endedAt: null,
    createdAt: min(seed.ago + 30),
    lastMessageAt: min(seed.ago),
    isMine: true,
    isIdle: seed.state === 'idle',
    agentCompletedAt: seed.state === 'idle' ? min(seed.ago) : null,
    task: {
      id: seed.taskId,
      status: taskStatus,
      taskMode: seed.mode,
      errorMessage: seed.state === 'failed' ? 'Agent reported failure' : null,
      executionStep: seed.state === 'running' ? 'running' : null,
    },
  };
}

/** Step chats that belong to runs, keyed by session id → run backlink text. */
export const STEP_LINEAGE: Record<string, string> = {
  's-csv-fix': 'Step 5 of 7 · Fix: CSV export drops the last row',
  's-csv-tests': 'Step 4 of 7 · Fix: CSV export drops the last row',
  's-csv-review': 'Step 3 of 7 · Fix: CSV export drops the last row',
  's-csv-impl': 'Step 2 of 7 · Fix: CSV export drops the last row',
  's-flags-flagsmith': 'Step 5 of 6 · Research: choosing a feature-flag service',
  's-flags-growthbook': 'Step 4 of 6 · Research: choosing a feature-flag service',
};

const SEEDS: SessionSeed[] = [
  {
    id: 's-flags-chat',
    taskId: 't-flags-chat',
    topic: 'Pick a feature-flag service',
    ago: 1,
    state: 'idle',
    mode: 'conversation',
    messages: 6,
  },
  {
    id: 's-flags-flagsmith',
    taskId: 't-flags-flagsmith',
    topic: 'Evaluate Flagsmith',
    ago: 2,
    state: 'running',
    mode: 'task',
  },
  {
    id: 's-flags-growthbook',
    taskId: 't-flags-growthbook',
    topic: 'Evaluate GrowthBook',
    ago: 6,
    state: 'failed',
    mode: 'task',
  },
  {
    id: 's-csv-fix',
    taskId: 't-csv-fix',
    topic: 'Fix review findings',
    ago: 4,
    state: 'done',
    mode: 'task',
  },
  {
    id: 's-refund',
    taskId: 't-refund',
    topic: 'Add idempotency keys to refund webhook',
    ago: 9,
    state: 'running',
    mode: 'task',
  },
  {
    id: 's-csv-tests',
    taskId: 't-csv-tests',
    topic: 'Run tests on staging',
    ago: 16,
    state: 'done',
    mode: 'task',
  },
  {
    id: 's-csv-review',
    taskId: 't-csv-review',
    topic: 'Review the code',
    ago: 23,
    state: 'done',
    mode: 'task',
  },
  {
    id: 's-stripe',
    taskId: 't-stripe',
    topic: 'Stripe webhook signature rotation',
    ago: 55,
    state: 'sleeping',
    mode: 'conversation',
  },
  {
    id: 's-csv-impl',
    taskId: 't-csv-impl',
    topic: 'Implement the change',
    ago: 44,
    state: 'done',
    mode: 'task',
  },
  {
    id: 's-ledger',
    taskId: 't-ledger',
    topic: 'Migrate ledger to double-entry bookkeeping',
    ago: 75,
    state: 'idle',
    mode: 'conversation',
  },
];

export const CHAT_SESSIONS: ChatSessionListItem[] = SEEDS.map(toSession);

/** Same sessions without workflow step chats — what Option A's list keeps. */
export const NON_STEP_SESSIONS = CHAT_SESSIONS.filter((s) => !STEP_LINEAGE[s.id]);

export const TASK_INFO: Map<string, TaskInfo> = new Map(
  SEEDS.map((s) => [
    s.taskId,
    {
      id: s.taskId,
      title: s.topic,
      parentTaskId: null,
      status:
        s.state === 'running'
          ? 'in_progress'
          : s.state === 'done'
            ? 'completed'
            : s.state === 'failed'
              ? 'failed'
              : s.state === 'cancelled'
                ? 'cancelled'
                : 'in_progress',
      blocked: false,
      triggeredBy: 'user',
      dispatchDepth: 0,
      taskMode: s.mode,
      errorMessage: s.state === 'failed' ? 'Agent reported failure' : null,
    } satisfies TaskInfo,
  ])
);

export function sessionById(id: string) {
  const found = CHAT_SESSIONS.find((s) => s.id === id);
  if (!found) throw new Error(`prototype: unknown session ${id}`);
  return found;
}

export function minutesAgo(m: number) {
  return min(m);
}
