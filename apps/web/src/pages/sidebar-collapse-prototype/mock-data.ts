import type { TaskMode, TaskStatus } from '@simple-agent-manager/shared';

import type { ChatSessionListItem } from '../../lib/api';
import type { TaskInfo } from '../project-chat/useTaskGroups';

/**
 * Mock data for the sidebar-collapse prototype.
 *
 * These shapes match the REAL `ChatSessionListItem` + `TaskInfo` types so the
 * prototype can render the production `SessionList` / `SessionItem` components
 * unchanged. The data is stress-test variety (every attention state, long
 * titles, stale items, hierarchy) so the real cards exercise their full
 * rendering surface.
 */

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const now = Date.now();

interface SessionSeed {
  id: string;
  topic: string;
  /** Minutes ago for last activity. */
  ago: number;
  status: 'active' | 'stopped' | 'failed';
  taskId?: string;
  isIdle?: boolean;
  agentCompletedAt?: boolean;
  needsInput?: boolean;
  messageCount?: number;
}

/** Each seed targets a specific attention state when enriched with its task. */
const SESSION_SEEDS: SessionSeed[] = [
  {
    id: 's1',
    topic: 'Add collapsible sidebars to the desktop UI with a coordinated focus mode toggle',
    ago: 0,
    status: 'active',
    taskId: 't1',
    messageCount: 24,
  },
  {
    id: 's2',
    topic: 'Fix the agent status bar staying alive during long tool calls',
    ago: 4,
    status: 'active',
    taskId: 't2',
    needsInput: true,
    messageCount: 11,
  },
  {
    id: 's3',
    topic: 'Investigate disappearing messages regression',
    ago: 12,
    status: 'failed',
    taskId: 't3',
    messageCount: 31,
  },
  {
    id: 's4',
    topic: 'Refactor SessionList virtualization',
    ago: 31,
    status: 'active',
    taskId: 't4',
    agentCompletedAt: true,
    messageCount: 18,
  },
  {
    id: 's5',
    topic: 'Q',
    ago: 44,
    status: 'active',
    taskId: 't5',
    messageCount: 2,
  },
  {
    id: 's6',
    topic: 'Wire up the new chat starter prompts grid',
    ago: 70,
    status: 'active',
    isIdle: true,
    messageCount: 6,
  },
  {
    id: 's7',
    topic: 'Audit warm-pool node lifecycle alarms and cron sweep interaction',
    ago: 120,
    status: 'active',
    taskId: 't7',
    messageCount: 40,
  },
  {
    id: 's8',
    topic: 'Bump default Workers AI model to Gemma 4 26B',
    ago: 180,
    status: 'active',
    taskId: 't8',
    messageCount: 9,
  },
  {
    id: 's9',
    topic: 'Trace credential snapshot resilience for raw hetzner tokens',
    ago: 300,
    status: 'failed',
    messageCount: 14,
  },
  {
    id: 's10',
    topic: 'Polish the glass chrome accent glow on mobile header',
    ago: 360,
    status: 'active',
    taskId: 't10',
    messageCount: 7,
  },
  {
    id: 's11',
    topic: 'Older exploratory spike on inline session dropdown',
    ago: 24 * 60,
    status: 'stopped',
    messageCount: 3,
  },
  {
    id: 's12',
    topic: 'Archived: original 1-env-per-node provisioning notes',
    ago: 48 * 60,
    status: 'active',
    taskId: 't12',
    messageCount: 21,
  },
  {
    id: 's13',
    topic: 'Archived chat about email triggers via Cloudflare Email Workers',
    ago: 72 * 60,
    status: 'active',
    taskId: 't13',
    messageCount: 16,
  },
];

/** Task metadata keyed by taskId — drives mode + terminal attention states. */
interface TaskSeed {
  status: TaskStatus;
  taskMode: TaskMode;
  parentTaskId?: string;
  triggeredBy?: string;
}

const TASK_SEEDS: Record<string, TaskSeed> = {
  t1: { status: 'in_progress', taskMode: 'task' }, // → active
  t2: { status: 'in_progress', taskMode: 'task' }, // → needs_input (attention marker wins)
  t3: { status: 'failed', taskMode: 'task' }, // → failed
  t4: { status: 'in_progress', taskMode: 'task' }, // → idle (agentCompletedAt)
  t5: { status: 'completed', taskMode: 'conversation' }, // → completed
  t7: { status: 'in_progress', taskMode: 'task', parentTaskId: 't1', triggeredBy: 'mcp' }, // child of t1
  t8: { status: 'completed', taskMode: 'task' }, // → completed
  t10: { status: 'cancelled', taskMode: 'task' }, // → stopped
  t12: { status: 'completed', taskMode: 'task' }, // → completed
  t13: { status: 'completed', taskMode: 'conversation' }, // → completed
};

export const MOCK_SESSIONS: ChatSessionListItem[] = SESSION_SEEDS.map((seed) => {
  const lastMessageAt = now - seed.ago * MIN;
  return {
    id: seed.id,
    workspaceId: `ws-${seed.id}`,
    taskId: seed.taskId ?? null,
    topic: seed.topic,
    status: seed.status,
    messageCount: seed.messageCount ?? 0,
    startedAt: lastMessageAt - 2 * HOUR,
    endedAt: seed.status === 'active' ? null : lastMessageAt,
    createdAt: lastMessageAt - 2 * HOUR,
    lastMessageAt,
    isIdle: seed.isIdle,
    agentCompletedAt: seed.agentCompletedAt ? lastMessageAt : undefined,
    attention: seed.needsInput
      ? { kind: 'needs_input', createdAt: lastMessageAt, expiresAt: null, reason: 'Agent asked a question' }
      : null,
  };
});

export const MOCK_TASK_INFO: Map<string, TaskInfo> = new Map(
  Object.entries(TASK_SEEDS).map(([taskId, t]) => [
    taskId,
    {
      id: taskId,
      title: SESSION_SEEDS.find((s) => s.taskId === taskId)?.topic ?? taskId,
      parentTaskId: t.parentTaskId ?? null,
      status: t.status,
      blocked: false,
      triggeredBy: t.triggeredBy ?? 'user',
      dispatchDepth: t.parentTaskId ? 1 : 0,
      taskMode: t.taskMode,
    },
  ]),
);

export interface MockMessage {
  id: string;
  role: 'user' | 'agent';
  text: string;
}

export const MOCK_CONVERSATION: MockMessage[] = [
  { id: 'm1', role: 'user', text: 'Come up with some cool ways to collapse the sidebars in the desktop UI.' },
  {
    id: 'm2',
    role: 'agent',
    text: 'On a project chat page desktop spends ~508px of chrome before the conversation: a 220px main nav plus a 288px session sidebar. The most interesting wins collapse both together. Try the Focus Mode toggle in the top-right — it cycles Default → Focus → Zen.',
  },
  { id: 'm3', role: 'user', text: 'Nice. What does each state actually do?' },
  {
    id: 'm4',
    role: 'agent',
    text: 'Default is today\u2019s layout. Focus shrinks the nav to a 56px icon rail and the sessions to a live status strip using the real chat-card status icons. Zen tucks both to glowing edge seams \u2014 hover a seam to peek the full panel as an overlay without reflowing your reading column.',
  },
  { id: 'm5', role: 'user', text: 'Can I still get to a chat fast in Zen?' },
  {
    id: 'm6',
    role: 'agent',
    text: 'Yep \u2014 the floating + stays pinned for New Chat, and hovering the right seam slides the whole session list back over the conversation. Press F (or use the toggle) to cycle. In Focus, hover any status icon to see the full real chat card as a tooltip.',
  },
];
