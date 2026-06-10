/**
 * Mock data for the task hierarchy prototype.
 * Simulates realistic parent/child task chains with various states.
 */

export type MockTaskStatus =
  | 'pending'
  | 'queued'
  | 'dispatching'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'stopped';

export type MockTaskMode = 'task' | 'conversation';

export interface MockSession {
  id: string;
  topic: string | null;
  taskId: string | null;
  status: string;
  startedAt: number;
  endedAt: number | null;
  messageCount: number;
  agentType: string | null;
}

export interface MockTask {
  id: string;
  title: string;
  parentTaskId: string | null;
  status: MockTaskStatus;
  taskMode: MockTaskMode;
  triggeredBy: string;
  dispatchDepth: number;
  blocked: boolean;
}

export interface MockHierarchyNode {
  session: MockSession;
  task: MockTask;
  children: MockHierarchyNode[];
}

// ─── Timestamps ────────────────────────────────────────────────────────
const now = Date.now();
const mins = (n: number) => n * 60_000;

// ─── Scenario 1: Deep hierarchy — a /do workflow with subtasks ──────────
export const SCENARIO_1_TASKS: MockTask[] = [
  {
    id: 'task-root-1',
    title: 'Implement OAuth2 PKCE flow for GitHub authentication',
    parentTaskId: null,
    status: 'running',
    taskMode: 'task',
    triggeredBy: 'user',
    dispatchDepth: 0,
    blocked: false,
  },
  {
    id: 'task-child-1a',
    title: 'Research GitHub OAuth2 PKCE requirements and constraints',
    parentTaskId: 'task-root-1',
    status: 'completed',
    taskMode: 'task',
    triggeredBy: 'mcp',
    dispatchDepth: 1,
    blocked: false,
  },
  {
    id: 'task-child-1b',
    title: 'Implement PKCE token exchange endpoint in API worker',
    parentTaskId: 'task-root-1',
    status: 'completed',
    taskMode: 'task',
    triggeredBy: 'mcp',
    dispatchDepth: 1,
    blocked: false,
  },
  {
    id: 'task-child-1c',
    title: 'Build OAuth callback handler with state verification',
    parentTaskId: 'task-root-1',
    status: 'running',
    taskMode: 'task',
    triggeredBy: 'mcp',
    dispatchDepth: 1,
    blocked: false,
  },
  {
    id: 'task-grandchild-1c1',
    title: 'Add CORS configuration for OAuth redirect URIs',
    parentTaskId: 'task-child-1c',
    status: 'running',
    taskMode: 'task',
    triggeredBy: 'mcp',
    dispatchDepth: 2,
    blocked: false,
  },
  {
    id: 'task-child-1d',
    title: 'Write integration tests for the complete OAuth flow',
    parentTaskId: 'task-root-1',
    status: 'pending',
    taskMode: 'task',
    triggeredBy: 'mcp',
    dispatchDepth: 1,
    blocked: true,
  },
];

export const SCENARIO_1_SESSIONS: MockSession[] = SCENARIO_1_TASKS.map((t, i) => ({
  id: `sess-s1-${i}`,
  topic: t.title,
  taskId: t.id,
  status: t.status === 'running' ? 'active' : t.status,
  startedAt: now - mins(60 - i * 10),
  endedAt: t.status === 'completed' ? now - mins(30 - i * 5) : null,
  messageCount: 10 + i * 5,
  agentType: 'claude-code',
}));

// ─── Scenario 2: Simple parent with 2 children ─────────────────────────
export const SCENARIO_2_TASKS: MockTask[] = [
  {
    id: 'task-root-2',
    title: 'Fix flaky WebSocket reconnection in terminal component',
    parentTaskId: null,
    status: 'completed',
    taskMode: 'task',
    triggeredBy: 'user',
    dispatchDepth: 0,
    blocked: false,
  },
  {
    id: 'task-child-2a',
    title: 'Add exponential backoff to WebSocket retry logic',
    parentTaskId: 'task-root-2',
    status: 'completed',
    taskMode: 'task',
    triggeredBy: 'mcp',
    dispatchDepth: 1,
    blocked: false,
  },
  {
    id: 'task-child-2b',
    title: 'Write regression tests for reconnection edge cases',
    parentTaskId: 'task-root-2',
    status: 'completed',
    taskMode: 'task',
    triggeredBy: 'mcp',
    dispatchDepth: 1,
    blocked: false,
  },
];

export const SCENARIO_2_SESSIONS: MockSession[] = SCENARIO_2_TASKS.map((t, i) => ({
  id: `sess-s2-${i}`,
  topic: t.title,
  taskId: t.id,
  status: t.status === 'running' ? 'active' : t.status,
  startedAt: now - mins(180 - i * 20),
  endedAt: t.status === 'completed' ? now - mins(120) : null,
  messageCount: 20 + i * 3,
  agentType: 'claude-code',
}));

// ─── Scenario 3: Standalone chat (no hierarchy) ────────────────────────
export const SCENARIO_3_SESSIONS: MockSession[] = [
  {
    id: 'sess-standalone-chat',
    topic: 'How does the warm pool node recycling work?',
    taskId: null,
    status: 'completed',
    startedAt: now - mins(240),
    endedAt: now - mins(200),
    messageCount: 8,
    agentType: null,
  },
];

// ─── Scenario 4: Failed subtask in a chain ──────────────────────────────
export const SCENARIO_4_TASKS: MockTask[] = [
  {
    id: 'task-root-4',
    title: 'Add R2 file upload support for workspace attachments',
    parentTaskId: null,
    status: 'failed',
    taskMode: 'task',
    triggeredBy: 'user',
    dispatchDepth: 0,
    blocked: false,
  },
  {
    id: 'task-child-4a',
    title: 'Create presigned URL generation endpoint',
    parentTaskId: 'task-root-4',
    status: 'completed',
    taskMode: 'task',
    triggeredBy: 'mcp',
    dispatchDepth: 1,
    blocked: false,
  },
  {
    id: 'task-child-4b',
    title: 'Configure R2 CORS rules in deployment pipeline',
    parentTaskId: 'task-root-4',
    status: 'failed',
    taskMode: 'task',
    triggeredBy: 'mcp',
    dispatchDepth: 1,
    blocked: false,
  },
];

export const SCENARIO_4_SESSIONS: MockSession[] = SCENARIO_4_TASKS.map((t, i) => ({
  id: `sess-s4-${i}`,
  topic: t.title,
  taskId: t.id,
  status: t.status === 'running' ? 'active' : t.status,
  startedAt: now - mins(300 - i * 15),
  endedAt: t.status !== 'running' && t.status !== 'pending' ? now - mins(250) : null,
  messageCount: 15 + i * 4,
  agentType: 'claude-code',
}));

// ─── Scenario 5: 10 levels deep chain ───────────────────────────────────

const DEEP_TITLES = [
  'Refactor authentication middleware to support multi-tenant SSO',
  'Extract token validation into shared package',
  'Add SAML 2.0 assertion parser',
  'Implement XML signature verification',
  'Add certificate chain validation for SAML IdP',
  'Write X.509 certificate pinning utility',
  'Add CRL and OCSP revocation checking',
  'Implement certificate transparency log verification',
  'Add SCT timestamp validation against CT logs',
  'Write Merkle tree proof verifier for inclusion proofs',
];

export const SCENARIO_5_TASKS: MockTask[] = DEEP_TITLES.map((title, i) => ({
  id: `task-deep-${i}`,
  title,
  parentTaskId: i === 0 ? null : `task-deep-${i - 1}`,
  status: (i < 4 ? 'completed' : i === 4 ? 'running' : 'pending') as MockTaskStatus,
  taskMode: 'task' as MockTaskMode,
  triggeredBy: i === 0 ? 'user' : 'mcp',
  dispatchDepth: i,
  blocked: i > 5,
}));

export const SCENARIO_5_SESSIONS: MockSession[] = SCENARIO_5_TASKS.map((t, i) => ({
  id: `sess-deep-${i}`,
  topic: t.title,
  taskId: t.id,
  status: t.status === 'running' ? 'active' : t.status,
  startedAt: now - mins(500 - i * 8),
  endedAt: t.status === 'completed' ? now - mins(400 - i * 5) : null,
  messageCount: 5 + i * 2,
  agentType: 'claude-code',
}));

// ─── Scenario 6: 50 children (wide fan-out) ────────────────────────────

const WIDE_CHILD_PREFIXES = [
  'Migrate', 'Refactor', 'Test', 'Fix', 'Update', 'Add', 'Remove', 'Optimize',
  'Document', 'Validate', 'Audit', 'Review', 'Benchmark', 'Profile', 'Debug',
  'Rewrite', 'Parallelize', 'Cache', 'Compress', 'Encrypt', 'Decrypt', 'Hash',
  'Normalize', 'Sanitize', 'Serialize', 'Deserialize', 'Transform', 'Aggregate',
  'Filter', 'Sort', 'Paginate', 'Batch', 'Queue', 'Schedule', 'Retry', 'Throttle',
  'Rate-limit', 'Circuit-break', 'Load-balance', 'Replicate', 'Shard', 'Partition',
  'Index', 'Vacuum', 'Compact', 'Archive', 'Restore', 'Snapshot', 'Rollback', 'Deploy',
];

const WIDE_COMPONENTS = [
  'user service', 'auth module', 'billing system', 'notification handler',
  'webhook dispatcher', 'task runner', 'workspace manager', 'node lifecycle DO',
  'session store', 'message broker', 'file upload handler', 'DNS resolver',
  'TLS terminator', 'rate limiter', 'circuit breaker', 'health checker',
  'metrics collector', 'log aggregator', 'error reporter', 'cache layer',
  'search index', 'email sender', 'SMS gateway', 'push notifications',
  'OAuth provider', 'API gateway', 'CDN proxy', 'image processor',
  'PDF generator', 'CSV exporter', 'webhook receiver', 'cron scheduler',
  'migration runner', 'seed generator', 'fixture factory', 'mock server',
  'integration test harness', 'E2E test runner', 'visual regression tool',
  'performance profiler', 'memory leak detector', 'deadlock analyzer',
  'race condition finder', 'fuzz tester', 'contract verifier', 'schema validator',
  'API documentation generator', 'changelog builder', 'release manager', 'deployment pipeline',
];

const STATUSES_POOL: MockTaskStatus[] = [
  'completed', 'completed', 'completed', 'completed', 'completed',
  'completed', 'completed', 'running', 'running', 'failed',
  'pending', 'pending', 'cancelled',
];

export const SCENARIO_6_TASKS: MockTask[] = [
  {
    id: 'task-wide-root',
    title: 'Run comprehensive system audit across all 50 service modules',
    parentTaskId: null,
    status: 'running',
    taskMode: 'task',
    triggeredBy: 'user',
    dispatchDepth: 0,
    blocked: false,
  },
  ...Array.from({ length: 50 }, (_, i) => ({
    id: `task-wide-child-${i}`,
    title: `${WIDE_CHILD_PREFIXES[i % WIDE_CHILD_PREFIXES.length]} ${WIDE_COMPONENTS[i % WIDE_COMPONENTS.length]}`,
    parentTaskId: 'task-wide-root',
    status: STATUSES_POOL[i % STATUSES_POOL.length],
    taskMode: 'task' as MockTaskMode,
    triggeredBy: 'mcp' as const,
    dispatchDepth: 1,
    blocked: false,
  })),
];

export const SCENARIO_6_SESSIONS: MockSession[] = SCENARIO_6_TASKS.map((t, i) => ({
  id: `sess-wide-${i}`,
  topic: t.title,
  taskId: t.id,
  status: t.status === 'running' ? 'active' : t.status,
  startedAt: now - mins(700 - i * 2),
  endedAt: t.status === 'completed' ? now - mins(600 - i) : null,
  messageCount: 3 + (i % 20),
  agentType: 'claude-code',
}));

// ─── Scenario 7: Deep AND wide — 5 levels, each with 3-5 children ──────

function generateDeepWideTree(): { tasks: MockTask[]; sessions: MockSession[] } {
  const tasks: MockTask[] = [];
  let counter = 0;

  const verbs = ['Implement', 'Test', 'Review', 'Deploy', 'Monitor'];
  const nouns = ['endpoint', 'handler', 'middleware', 'validator', 'serializer'];

  function addLevel(parentId: string | null, depth: number, maxDepth: number) {
    const childCount = depth === 0 ? 1 : (3 + (depth % 3)); // 3-5 children per level
    for (let i = 0; i < childCount; i++) {
      const id = `task-dw-${counter++}`;
      const verb = verbs[(counter + depth) % verbs.length];
      const noun = nouns[(counter + i) % nouns.length];
      tasks.push({
        id,
        title: `${verb} L${depth} ${noun} #${i + 1}${depth > 3 ? ' (deeply nested sub-sub-task)' : ''}`,
        parentTaskId: parentId,
        status: depth < 2 ? 'completed' : depth === 2 ? 'running' : 'pending',
        taskMode: 'task',
        triggeredBy: parentId ? 'mcp' : 'user',
        dispatchDepth: depth,
        blocked: depth > 3,
      });
      if (depth < maxDepth) {
        addLevel(id, depth + 1, maxDepth);
      }
    }
  }

  addLevel(null, 0, 4); // 5 levels (0-4)

  const sessions: MockSession[] = tasks.map((t, i) => ({
    id: `sess-dw-${i}`,
    topic: t.title,
    taskId: t.id,
    status: t.status === 'running' ? 'active' : t.status,
    startedAt: now - mins(900 - i),
    endedAt: t.status === 'completed' ? now - mins(800) : null,
    messageCount: 2 + i,
    agentType: 'claude-code',
  }));

  return { tasks, sessions };
}

const SCENARIO_7 = generateDeepWideTree();
export const SCENARIO_7_TASKS = SCENARIO_7.tasks;
export const SCENARIO_7_SESSIONS = SCENARIO_7.sessions;

// ─── Combined dataset ──────────────────────────────────────────────────

export const ALL_TASKS: MockTask[] = [
  ...SCENARIO_1_TASKS,
  ...SCENARIO_2_TASKS,
  ...SCENARIO_4_TASKS,
  ...SCENARIO_5_TASKS,
  ...SCENARIO_6_TASKS,
  ...SCENARIO_7_TASKS,
];

export const ALL_SESSIONS: MockSession[] = [
  ...SCENARIO_1_SESSIONS,
  ...SCENARIO_2_SESSIONS,
  ...SCENARIO_3_SESSIONS,
  ...SCENARIO_4_SESSIONS,
  ...SCENARIO_5_SESSIONS,
  ...SCENARIO_6_SESSIONS,
  ...SCENARIO_7_SESSIONS,
];

// ─── Helper: build hierarchy tree from flat tasks ──────────────────────

export function buildHierarchyTree(
  tasks: MockTask[],
  sessions: MockSession[],
): MockHierarchyNode[] {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const sessionByTask = new Map(sessions.filter((s) => s.taskId).map((s) => [s.taskId!, s]));

  const nodesByTaskId = new Map<string, MockHierarchyNode>();

  for (const task of tasks) {
    const session = sessionByTask.get(task.id);
    if (!session) continue;
    nodesByTaskId.set(task.id, { session, task, children: [] });
  }

  const roots: MockHierarchyNode[] = [];

  for (const task of tasks) {
    const node = nodesByTaskId.get(task.id);
    if (!node) continue;

    if (task.parentTaskId && nodesByTaskId.has(task.parentTaskId)) {
      nodesByTaskId.get(task.parentTaskId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

/**
 * Given a taskId, find the full hierarchy tree that contains it
 * (walk up to root, then return that root's tree).
 */
export function getHierarchyForTask(
  taskId: string,
  tasks: MockTask[],
  sessions: MockSession[],
): { tree: MockHierarchyNode; focusTaskId: string } | null {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  // Walk up to root
  let rootId = taskId;
  const seen = new Set<string>();
  while (true) {
    if (seen.has(rootId)) break;
    seen.add(rootId);
    const t = taskMap.get(rootId);
    if (!t?.parentTaskId) break;
    rootId = t.parentTaskId;
  }

  const trees = buildHierarchyTree(tasks, sessions);
  const tree = trees.find((t) => t.task.id === rootId);
  if (!tree) return null;

  return { tree, focusTaskId: taskId };
}
