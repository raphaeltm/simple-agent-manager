// PROTOTYPE ONLY — mock data for the task-hierarchy prototype route.
// Must NOT ship to production. See .claude/rules/37-prototype-development.md.
import type { ChatSessionListItem } from '../../lib/api';
import type { TaskInfo } from '../project-chat/useTaskGroups';

export interface HierarchyScenario {
  id: string;
  label: string;
  description: string;
  taskInfoMap: Map<string, TaskInfo>;
  sessions: ChatSessionListItem[];
  focusTaskId: string;
}

const NOW = Date.now();
const MIN = 60_000;

/**
 * Subtasks must look like genuine dispatches (not retries/forks) to nest:
 * isRetryOrFork() returns false when triggeredBy === 'mcp' or dispatchDepth > 0.
 */
function makeTask(overrides: Partial<TaskInfo> & { id: string; title: string }): TaskInfo {
  return {
    parentTaskId: null,
    status: 'completed',
    blocked: false,
    triggeredBy: 'mcp',
    dispatchDepth: 1,
    taskMode: 'task',
    ...overrides,
  };
}

function makeSession(
  taskId: string,
  startedAtOffsetMin: number,
  overrides: Partial<ChatSessionListItem> = {},
): ChatSessionListItem {
  return {
    id: `sess-${taskId}`,
    workspaceId: `ws-${taskId}`,
    taskId,
    topic: null,
    status: 'stopped',
    messageCount: 12,
    startedAt: NOW - startedAtOffsetMin * MIN,
    endedAt: null,
    createdAt: NOW - startedAtOffsetMin * MIN,
    ...overrides,
  };
}

// ─── Scenario 1: Screenshot replica ────────────────────────────────────

function buildScreenshotReplica(): HierarchyScenario {
  const tasks: TaskInfo[] = [
    makeTask({
      id: 'root',
      title: 'Review task hierarchy component for UI issues from screenshot',
      status: 'in_progress',
      triggeredBy: 'user',
      dispatchDepth: 0,
    }),
    makeTask({
      id: 'child-1',
      title: 'Use the SAM MCP tools (get_session_messages, search_messages) to review the previous session',
      status: 'in_progress',
      parentTaskId: 'root',
    }),
  ];
  return {
    id: 'screenshot-replica',
    label: 'Screenshot replica',
    description: 'The original 2-task chain from the bug report — child card must align with, not out-dent, its parent.',
    taskInfoMap: new Map(tasks.map((t) => [t.id, t])),
    sessions: [makeSession('root', 120), makeSession('child-1', 30)],
    focusTaskId: 'child-1',
  };
}

// ─── Scenario 2: Kitchen sink ──────────────────────────────────────────

const LONG_TITLE =
  'Investigate and remediate the intermittent workspace provisioning failure that occurs when the Hetzner API returns a 409 conflict during volume attachment, including adding retry logic with exponential backoff, updating the cloud-init template to tolerate slow volume mounts, writing regression tests for the node lifecycle state machine, and documenting the recovery procedure for operators in the self-hosting guide';

const URL_TITLE =
  'https://github.com/raphaeltm/simple-agent-manager/pull/1503/files#diff-8c2fa46c3b89428bb235d835b7914106aVeryLongUnbrokenUrlSegmentThatCannotWrapAnywhere';

const EMOJI_TITLE = '🚀 デプロイパイプラインの改善 — ステージング環境の検証を自動化する 🔧✨';

function buildKitchenSink(): HierarchyScenario {
  const tasks: TaskInfo[] = [
    // 8-level chain: L1 → L8
    makeTask({ id: 'l1', title: 'Ship the Q3 infrastructure overhaul', status: 'in_progress', triggeredBy: 'user', dispatchDepth: 0 }),
    makeTask({ id: 'l2', title: LONG_TITLE, status: 'in_progress', parentTaskId: 'l1' }),
    makeTask({ id: 'l3', title: URL_TITLE, status: 'delegated', parentTaskId: 'l2', dispatchDepth: 2 }),
    makeTask({ id: 'l4', title: EMOJI_TITLE, status: 'in_progress', parentTaskId: 'l3', dispatchDepth: 3 }),
    makeTask({ id: 'l5', title: 'Refactor the provider abstraction layer', status: 'failed', blocked: true, parentTaskId: 'l4', dispatchDepth: 4 }),
    makeTask({ id: 'l6', title: 'X', status: 'in_progress', parentTaskId: 'l5', dispatchDepth: 5 }),
    makeTask({ id: 'l7', title: 'Write integration tests for the retry path', status: 'queued', parentTaskId: 'l6', dispatchDepth: 6 }),
    makeTask({ id: 'l8', title: 'Deep focus task — eight levels down, past the max indent cutoff', status: 'in_progress', parentTaskId: 'l7', dispatchDepth: 7 }),
    // 12-child fan-out under l2
    ...Array.from({ length: 12 }, (_, i) =>
      makeTask({
        id: `fan-${i + 1}`,
        title: `Parallel migration batch ${i + 1}: convert legacy ${['credentials', 'workspaces', 'nodes', 'sessions', 'tasks', 'triggers', 'profiles', 'skills', 'policies', 'ideas', 'knowledge', 'activity'][i]} table`,
        status: (['completed', 'completed', 'failed', 'in_progress', 'queued', 'completed', 'cancelled', 'in_progress', 'queued', 'completed', 'draft', 'ready'] as const)[i],
        blocked: i === 2,
        parentTaskId: 'l2',
        dispatchDepth: 2,
      }),
    ),
  ];
  const sessions: ChatSessionListItem[] = [
    makeSession('l1', 600),
    makeSession('l2', 550),
    makeSession('l3', 500),
    makeSession('l4', 450),
    makeSession('l5', 400),
    makeSession('l6', 350),
    // l7 intentionally sessionless (queued — disabled card)
    makeSession('l8', 250),
    // Fan-out sessions with staggered start times; fan-5 and fan-9 sessionless (queued)
    ...[1, 2, 3, 4, 6, 7, 8, 10, 11, 12].map((i) => makeSession(`fan-${i}`, 540 - i * 10)),
  ];
  return {
    id: 'kitchen-sink',
    label: 'Kitchen sink',
    description: '8-level chain (focus at L8), 350-char title, unbroken URL, emoji/Japanese, 12-child fan-out, blocked + sessionless tasks.',
    taskInfoMap: new Map(tasks.map((t) => [t.id, t])),
    sessions,
    focusTaskId: 'l8',
  };
}

// ─── Scenario 3: Wide fan-out ──────────────────────────────────────────

function buildWideFanOut(): HierarchyScenario {
  const statuses = ['completed', 'completed', 'failed', 'completed', 'in_progress', 'completed', 'cancelled', 'queued', 'in_progress', 'completed', 'ready', 'completed', 'draft', 'completed'] as const;
  const tasks: TaskInfo[] = [
    makeTask({ id: 'parent', title: 'Fan out documentation rewrite across all guide pages', status: 'in_progress', triggeredBy: 'user', dispatchDepth: 0 }),
    ...Array.from({ length: 14 }, (_, i) =>
      makeTask({
        id: `sib-${i + 1}`,
        title: `Rewrite guide page ${i + 1}: ${['getting started', 'self-hosting', 'local development', 'architecture overview', 'security model', 'provider setup', 'agent profiles', 'skills', 'task runner', 'warm pooling', 'observability', 'billing', 'troubleshooting', 'FAQ'][i]}`,
        status: statuses[i],
        parentTaskId: 'parent',
      }),
    ),
  ];
  const sessions: ChatSessionListItem[] = [
    makeSession('parent', 300),
    // sib-8 (queued) and sib-13 (draft) are sessionless
    ...Array.from({ length: 14 }, (_, i) => i + 1)
      .filter((i) => i !== 8 && i !== 13)
      .map((i) => makeSession(`sib-${i}`, 290 - i * 5)),
  ];
  return {
    id: 'wide-fan-out',
    label: 'Wide fan-out',
    description: '14 siblings under one parent — focus is child #9, hidden behind the "Show more" collapse (must auto-reveal).',
    taskInfoMap: new Map(tasks.map((t) => [t.id, t])),
    sessions,
    focusTaskId: 'sib-9',
  };
}

export const SCENARIOS: HierarchyScenario[] = [
  buildScreenshotReplica(),
  buildKitchenSink(),
  buildWideFanOut(),
];
