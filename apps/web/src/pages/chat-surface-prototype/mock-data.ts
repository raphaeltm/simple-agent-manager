/**
 * PROTOTYPE ONLY — mock data for the chat-surface prototype (unbubbled agent messages and an
 * immersive "messages only" view). Must be removed before merge to main
 * (`apps/web/.claude/rules/37-prototype-development.md`).
 *
 * The transcript deliberately stresses width on a phone: a wide table (the case in the
 * screenshot that prompted this), fenced code, a long unbroken URL, nested lists, tool-call
 * groups, a thinking block and a short one-line reply.
 */

export const PROTO_PROJECT_ID = 'proto-chat-surface-project';
export const PROTO_SESSION_ID = 'proto-chat-surface-session';
export const PROTO_NOW = Date.now();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const RAPH = { id: 'user-proto-raph', name: 'Raphaël Titsworth-Morin', email: 'raph@example.com' };

export const PROTO_USER = {
  user: {
    id: RAPH.id,
    email: RAPH.email,
    name: RAPH.name,
    image: null,
    role: 'superadmin',
    status: 'active',
    emailVerified: true,
    createdAt: '2026-05-19T00:00:00Z',
    updatedAt: '2026-05-19T00:00:00Z',
  },
  session: {
    id: 'auth-proto-raph',
    userId: RAPH.id,
    expiresAt: new Date(PROTO_NOW + 86_400_000).toISOString(),
    token: 'mock-token',
    createdAt: '2026-05-19T00:00:00Z',
    updatedAt: '2026-05-19T00:00:00Z',
  },
};

export const PROTO_PROJECT = {
  id: PROTO_PROJECT_ID,
  name: 'SAM',
  repository: 'raphaeltm/simple-agent-manager',
  defaultBranch: 'main',
  userId: RAPH.id,
  githubInstallationId: 'inst-1',
  multiplayerActive: false,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-11-03T00:00:00Z',
};

interface SessionSpec {
  id: string;
  topic: string;
  ageMinutes: number;
  state: 'running' | 'idle' | 'sleeping' | 'completed';
}

const SESSION_SPECS: SessionSpec[] = [
  {
    id: PROTO_SESSION_ID,
    topic: 'Plan: debugger-project tooling (node debug access, ops MCP tools) + explainer HTML',
    ageMinutes: 4,
    state: 'idle',
  },
  { id: 'proto-sess-2', topic: 'Disable MPTCP in VM agent sockets', ageMinutes: 26, state: 'running' },
  {
    id: 'proto-sess-3',
    topic: 'Weekly queue & memory reconciliation',
    ageMinutes: 190,
    state: 'sleeping',
  },
  {
    id: 'proto-sess-4',
    topic: 'Nodes page: fix wrong project label on cards',
    ageMinutes: 420,
    state: 'completed',
  },
];

function sessionFor(spec: SessionSpec) {
  const at = PROTO_NOW - spec.ageMinutes * MINUTE;
  const taskId = `task-${spec.id}`;
  return {
    id: spec.id,
    projectId: PROTO_PROJECT_ID,
    workspaceId: `ws-${spec.id}`,
    taskId,
    task: {
      id: taskId,
      status: spec.state === 'completed' ? 'completed' : 'in_progress',
      executionStep: spec.state === 'running' ? 'running' : 'awaiting_followup',
      triggeredBy: 'user',
      outputBranch: `sam/${spec.id}`,
      outputPrUrl: null,
      errorMessage: null,
      outputSummary: null,
      finalizedAt: null,
      taskMode: 'conversation',
      agentProfileHint: null,
    },
    topic: spec.topic,
    status: spec.state === 'sleeping' ? 'sleeping' : 'active',
    messageCount: 12,
    startedAt: at - HOUR,
    endedAt: null,
    createdAt: at - HOUR,
    lastMessageAt: at,
    isIdle: spec.state !== 'running',
    agentCompletedAt: spec.state === 'running' ? null : at,
    isTerminated: false,
    workspaceUrl: null,
    cleanupAt: null,
    agentSessionId: null,
    agentType: 'claude-code',
    isMine: true,
    createdByUserId: RAPH.id,
    createdBy: { id: RAPH.id, name: RAPH.name, email: RAPH.email, image: null, avatarUrl: null },
    attention: null,
    viewerAccess: 'owner',
  };
}

export const PROTO_SESSIONS = SESSION_SPECS.map(sessionFor);

export const PROTO_TASKS = SESSION_SPECS.map((spec) => ({
  id: `task-${spec.id}`,
  projectId: PROTO_PROJECT_ID,
  title: spec.topic,
  status: spec.state === 'completed' ? 'completed' : 'in_progress',
  executionStep: spec.state === 'running' ? 'running' : 'awaiting_followup',
  triggeredBy: 'user',
  taskMode: 'conversation',
  parentTaskId: null,
  outputPrUrl: null,
  createdAt: new Date(PROTO_NOW - spec.ageMinutes * MINUTE).toISOString(),
  updatedAt: new Date(PROTO_NOW - spec.ageMinutes * MINUTE).toISOString(),
}));

const TABLE_REPLY = [
  'All three PRs have merged in order. PR1 and PR2 are in production; PR3 should deploy within the hour.',
  '',
  '| PR | Merged | In production | Notes |',
  '| --- | --- | --- | --- |',
  '| PR1 [#2501](https://github.com/raphaeltm/simple-agent-manager/pull/2501), Foundations | 18:00 yesterday | ✅ | Clean deploy, no follow-ups |',
  '| PR2 [#2504](https://github.com/raphaeltm/simple-agent-manager/pull/2504), Eyes | 04:36 | ✅ deployed 07:12 along with the fix for the deploy blocker | The deploy blocker was a stale migration tag |',
  '| PR3 [#2502](https://github.com/raphaeltm/simple-agent-manager/pull/2502), Hands + memory | 07:40 | ⏳ should be next after the current run finishes | Waiting on Deploy Production |',
  '',
  'Nothing needs you right now. I will check the PR3 deploy when it finishes and tell you if it fails.',
].join('\n');

const PLAN_REPLY = [
  "Here's the plan for the debugger project. Three slices, each shippable on its own:",
  '',
  '1. **Foundations**: a `debugger` project type, superadmin-only, with an audited ops token.',
  '   - Every `ops_*` call writes an audit row with the caller, target and a hash of the arguments.',
  '   - Tokens are scoped to one installation and expire after `OPS_TOKEN_TTL_MS` (default 1 hour).',
  '2. **Eyes**: read-only tools: `ops_find_anomalies`, `ops_timeline`, `ops_node_logs` with server-side `contains` filtering so we never pull a whole journal.',
  '3. **Hands + memory**: `ops_request_action` (human-approved) and a debug-package capture that lands in the project library under `/debug-packages/` with automatic retention.',
  '',
  'The node-side change is small. The VM agent already exposes `/debug/journal`; we add a bounded query:',
  '',
  '```go',
  'func (s *Server) handleJournal(w http.ResponseWriter, r *http.Request) {',
  '\tq := journalQuery{Unit: r.URL.Query().Get("unit"), Contains: r.URL.Query().Get("contains"), Limit: clamp(parseInt(r.URL.Query().Get("limit")), 1, s.cfg.MaxJournalLines)}',
  '\tlines, err := s.journal.Read(r.Context(), q)',
  '\tif err != nil {',
  '\t\twriteError(w, http.StatusBadGateway, "journal_read_failed", err)',
  '\t\treturn',
  '\t}',
  '\twriteJSON(w, http.StatusOK, lines)',
  '}',
  '```',
  '',
  'Reference for the journal export format: https://www.freedesktop.org/software/systemd/man/latest/journalctl.html#--output=export-and-the-very-long-anchor-that-keeps-going',
  '',
  'I also wrote the explainer page as `docs/explainers/debugger-project-top-10.html`. Want me to open the PRs in that order?',
].join('\n');

function toolRow(
  id: string,
  toolCallId: string,
  title: string,
  kind: string,
  path: string,
  minutesAgo: number
) {
  return {
    id,
    role: 'tool',
    content: '',
    toolMetadata: {
      toolCallId,
      title,
      kind,
      status: 'completed',
      locations: [{ path, line: null }],
    },
    createdAt: PROTO_NOW - minutesAgo * MINUTE,
  };
}

const RAW_MESSAGES = [
  {
    id: 'proto-msg-1',
    role: 'user',
    content:
      'Plan the debugger project: node debug access, ops MCP tools, and a short explainer page I can skim.',
    toolMetadata: null,
    createdAt: PROTO_NOW - 70 * MINUTE,
  },
  {
    id: 'proto-msg-2',
    role: 'thinking',
    content:
      'The user wants a plan with three parts. I should look at the existing VM agent debug endpoints and the MCP tool registry before proposing anything new.',
    toolMetadata: null,
    createdAt: PROTO_NOW - 69 * MINUTE,
  },
  toolRow('proto-tool-1', 'tc-1', 'Read packages/vm-agent/internal/server/debug.go', 'read', 'packages/vm-agent/internal/server/debug.go', 69),
  toolRow('proto-tool-2', 'tc-2', 'Read apps/api/src/routes/mcp/index.ts', 'read', 'apps/api/src/routes/mcp/index.ts', 68),
  toolRow('proto-tool-3', 'tc-3', 'grep "ops_" apps/api/src', 'search', 'apps/api/src', 68),
  {
    id: 'proto-msg-3',
    role: 'assistant',
    content: PLAN_REPLY,
    toolMetadata: null,
    createdAt: PROTO_NOW - 66 * MINUTE,
  },
  {
    id: 'proto-msg-4',
    role: 'user',
    content: 'Yes, open them in that order and merge each one when it is green. Tell me when all three are in production.',
    toolMetadata: null,
    createdAt: PROTO_NOW - 60 * MINUTE,
  },
  {
    id: 'proto-msg-5',
    role: 'assistant',
    content: 'On it.',
    toolMetadata: null,
    createdAt: PROTO_NOW - 59 * MINUTE,
  },
  toolRow('proto-tool-4', 'tc-4', 'gh pr create --title "Debugger project: foundations"', 'execute', '.', 40),
  toolRow('proto-tool-5', 'tc-5', 'gh pr merge 2501 --squash', 'execute', '.', 30),
  {
    id: 'proto-msg-6',
    role: 'user',
    content: 'ok',
    toolMetadata: null,
    createdAt: PROTO_NOW - 10 * MINUTE,
  },
  {
    id: 'proto-msg-7',
    role: 'assistant',
    content: TABLE_REPLY,
    toolMetadata: null,
    createdAt: PROTO_NOW - 4 * MINUTE,
  },
];

export const PROTO_MESSAGES = RAW_MESSAGES.map((message, index) => ({
  ...message,
  sessionId: PROTO_SESSION_ID,
  sequence: index + 1,
}));

/** Canned replies the fake agent streams back when you send a message. */
export const PROTO_CANNED_REPLIES = [
  [
    'Sure. Here is what changed since my last update:',
    '',
    '- **PR3 deployed** at 08:31. Deploy Production run `41389211044` finished green.',
    '- The health check at `https://api.simple-agent-manager.org/health` reports the new version.',
    '',
    'All three PRs are now in production.',
  ].join('\n'),
  [
    'Good question. The short version: the ops token never leaves the control plane.',
    '',
    '```ts',
    'const token = await issueOpsToken(env, { installationId, ttlMs: env.OPS_TOKEN_TTL_MS });',
    '```',
    '',
    'The agent only ever sees the MCP tool results, never the token itself.',
  ].join('\n'),
  'Done.',
];
