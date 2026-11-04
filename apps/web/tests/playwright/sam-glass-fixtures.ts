/**
 * Mock data for the SAM Glass chat and navigation audit (`sam-glass-chat-audit.spec.ts`).
 *
 * A shared project with four people and ten sessions in every list state the chat list draws:
 * running, idle, sleeping, needs your answer, completed, stopped, with and without pull requests,
 * started by you, by teammates and by automations. The open chat is shared with two teammates and
 * carries a teammate's message, so the conversation shows people colours as well as the agent.
 */
import type { Page, Route } from '@playwright/test';

import { makeIdleSessionState, makeMockUser } from './audit-helpers';

export const GLASS_PROJECT_ID = '01KH2ZQ7M4R9T6V3X8B5N1C0SG';
export const GLASS_SESSION_ID = 'sess-glass-competitor-research';
export const GLASS_NOW = Date.parse('2026-11-03T14:20:00Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const RAPH = { id: 'user-raph', name: 'Raphaël Titsworth-Morin', email: 'raph@example.com' };
const JONAS = { id: 'user-jonas', name: 'Jonas Weber', email: 'jonas@example.com' };
const MAYA = { id: 'user-maya', name: 'Maya Chen', email: 'maya@example.com' };
const PRIYA = { id: 'user-priya', name: 'Priya Anand', email: 'priya@example.com' };

export const GLASS_USER = makeMockUser({
  email: RAPH.email,
  name: RAPH.name,
  sessionId: 'auth-glass-raph',
  userId: RAPH.id,
});

function person(p: { id: string; name: string; email: string }) {
  return { id: p.id, name: p.name, email: p.email, image: null, avatarUrl: null };
}

function member(p: { id: string; name: string; email: string }, role = 'admin') {
  return {
    projectId: GLASS_PROJECT_ID,
    userId: p.id,
    role,
    status: 'active',
    invitedBy: null,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    user: person(p),
  };
}

const MEMBERS = {
  members: [member(RAPH, 'owner'), member(MAYA), member(JONAS), member(PRIYA)],
  inviteLinks: [],
  accessRequests: [],
};

export const GLASS_PROJECT = {
  id: GLASS_PROJECT_ID,
  name: 'SAM',
  repository: 'raphaeltm/simple-agent-manager',
  defaultBranch: 'main',
  userId: RAPH.id,
  githubInstallationId: 'inst-1',
  multiplayerActive: true,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-11-03T00:00:00Z',
};

interface SessionSpec {
  id: string;
  topic: string;
  owner: typeof RAPH | null;
  ageMinutes: number;
  mode: 'task' | 'conversation';
  state: 'running' | 'idle' | 'sleeping' | 'needs_input' | 'completed' | 'stopped';
  triggeredBy?: string;
  prUrl?: string;
}

const SESSION_SPECS: SessionSpec[] = [
  {
    id: 'sess-glass-blog',
    topic: 'Daily public blog post review and publishing',
    owner: null,
    ageMinutes: 3,
    mode: 'task',
    state: 'running',
    triggeredBy: 'cron',
  },
  {
    id: GLASS_SESSION_ID,
    topic: 'Competitor UI research: T3 Code & multi-agent orchestrators (chat/session panels)',
    owner: RAPH,
    ageMinutes: 8,
    mode: 'conversation',
    state: 'running',
  },
  {
    id: 'sess-glass-stuck',
    topic: 'Root-cause stuck workspace provisioning on warm nodes',
    owner: JONAS,
    ageMinutes: 21,
    mode: 'conversation',
    state: 'running',
  },
  {
    id: 'sess-glass-mptcp',
    topic: 'Disable MPTCP in VM agent sockets',
    owner: MAYA,
    ageMinutes: 26,
    mode: 'task',
    state: 'running',
    prUrl: 'https://github.com/raphaeltm/simple-agent-manager/pull/2501',
  },
  {
    id: 'sess-glass-cve',
    topic: 'Assess CVE-2026-98432 impact on the API worker',
    owner: PRIYA,
    ageMinutes: 47,
    mode: 'conversation',
    state: 'needs_input',
  },
  {
    id: 'sess-glass-orphan',
    topic: 'Resolve PR #2458 orphaned workspace cleanup',
    owner: RAPH,
    ageMinutes: 180,
    mode: 'task',
    state: 'idle',
    prUrl: 'https://github.com/raphaeltm/simple-agent-manager/pull/2458',
  },
  {
    id: 'sess-glass-shepherd',
    topic: 'Run SAM PR Shepherd for raphaeltm/simple-agent-manager',
    owner: null,
    ageMinutes: 190,
    mode: 'task',
    state: 'sleeping',
    triggeredBy: 'cron',
  },
  {
    id: 'sess-glass-weekly',
    topic: 'Perform weekly SAM production health review',
    owner: MAYA,
    ageMinutes: 360,
    mode: 'task',
    state: 'sleeping',
  },
  {
    id: 'sess-glass-nodes',
    topic: 'Nodes page: fix wrong project label on cards',
    owner: RAPH,
    ageMinutes: 420,
    mode: 'conversation',
    state: 'completed',
  },
  {
    id: 'sess-glass-queue',
    topic: 'Weekly queue & memory reconciliation',
    owner: null,
    ageMinutes: 440,
    mode: 'task',
    state: 'idle',
    triggeredBy: 'cron',
  },
];

const GRANTS = [MAYA, JONAS].map((grantee, index) => ({
  id: `grant-${grantee.id}`,
  sessionId: GLASS_SESSION_ID,
  grantee: { id: grantee.id, name: grantee.name, avatarUrl: null },
  grantedBy: { id: RAPH.id, name: RAPH.name, avatarUrl: null },
  parentGrantId: null,
  createdAt: GLASS_NOW - (30 + index * 5) * MINUTE,
  expiresAt: GLASS_NOW + (30 - index * 5) * MINUTE,
  durationMinutes: 60,
}));

function taskIdFor(spec: SessionSpec) {
  return `task-${spec.id}`;
}

function taskStatusFor(spec: SessionSpec): string {
  if (spec.state === 'completed') return 'completed';
  if (spec.state === 'stopped') return 'cancelled';
  return 'in_progress';
}

function sessionFor(spec: SessionSpec) {
  const at = GLASS_NOW - spec.ageMinutes * MINUTE;
  const owner = spec.owner ?? RAPH;
  const isOpen = spec.id === GLASS_SESSION_ID;
  return {
    id: spec.id,
    projectId: GLASS_PROJECT_ID,
    workspaceId: `ws-${spec.id}`,
    taskId: taskIdFor(spec),
    task: {
      id: taskIdFor(spec),
      status: taskStatusFor(spec),
      executionStep: spec.state === 'running' ? 'running' : 'awaiting_followup',
      triggeredBy: spec.triggeredBy ?? 'user',
      outputBranch: `sam/${spec.id}`,
      outputPrUrl: spec.prUrl ?? null,
      errorMessage: null,
      outputSummary: null,
      finalizedAt: null,
      taskMode: spec.mode,
      agentProfileHint: null,
    },
    topic: spec.topic,
    status: spec.state === 'sleeping' ? 'sleeping' : 'active',
    messageCount: 6,
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
    isMine: owner.id === RAPH.id && spec.owner !== null,
    createdByUserId: owner.id,
    createdBy: person(owner),
    attention:
      spec.state === 'needs_input'
        ? {
            markerId: `marker-${spec.id}`,
            kind: 'needs_input',
            createdAt: at,
            expiresAt: null,
            reason: 'Should I open a PR with the dependency bump?',
            options: ['Yes', 'No'],
          }
        : null,
    ...(isOpen
      ? {
          viewerAccess: 'owner',
          access: {
            sessionId: GLASS_SESSION_ID,
            viewerAccess: 'owner',
            owner: { id: RAPH.id, name: RAPH.name, avatarUrl: null },
            grants: GRANTS,
            serverTime: GLASS_NOW,
          },
        }
      : {}),
  };
}

export const GLASS_SESSIONS = SESSION_SPECS.map(sessionFor);

const SESSION_TASKS = SESSION_SPECS.map((spec) => ({
  id: taskIdFor(spec),
  projectId: GLASS_PROJECT_ID,
  title: spec.topic,
  status: taskStatusFor(spec),
  executionStep: spec.state === 'running' ? 'running' : 'awaiting_followup',
  triggeredBy: spec.triggeredBy ?? 'user',
  taskMode: spec.mode,
  parentTaskId: null,
  outputPrUrl: spec.prUrl ?? null,
  createdAt: new Date(GLASS_NOW - spec.ageMinutes * MINUTE).toISOString(),
  updatedAt: new Date(GLASS_NOW - spec.ageMinutes * MINUTE).toISOString(),
}));

/** A sub-task the MPTCP task dispatched, so its row shows the hierarchy badge. */
const GLASS_TASKS = [
  ...SESSION_TASKS,
  {
    ...SESSION_TASKS[3]!,
    id: 'task-glass-mptcp-subtask',
    title: 'Measure socket latency with MPTCP off',
    triggeredBy: 'mcp',
    parentTaskId: SESSION_TASKS[3]!.id,
  },
];

const ASSISTANT_REPLY = [
  'Here is how the other orchestrators lay out their session panels.',
  '',
  '- **Each row shows** the title, one line of what the agent is doing or what it is stuck on, pull request status, lines changed (+N −M), and age. Tools that span several machines also show which machine.',
  '- **Choices sit under the message box:** agent, model, branch and which machine.',
  '- **Sub-agents show inside their parent session**, not as separate rows in the main list.',
  '',
  '**Why they are organized that way** (the main story)',
  '',
  '- **T3 Code took project grouping out** in favour of a flat inbox, where you "settle" a thread once it is done.',
  '- **What users kept designing for themselves:** a "Needs you" section on top, then collapsible project groups with one-line rows.',
  '',
  '**Where SAM stands:** our session list is flat, with no "needs you" section and no agent, machine, pull request or unread state on the rows.',
  '',
  'Do you want me to turn the "Needs you" section plus project groups into a clickable prototype next?',
].join('\n');

export const GLASS_MESSAGES = [
  {
    id: 'msg-glass-1',
    role: 'user',
    content:
      'Research how T3 Code and other multi-agent orchestrators lay out their chat and session panels. What should SAM borrow?',
    toolMetadata: null,
  },
  {
    id: 'msg-glass-2',
    role: 'assistant',
    content:
      'I read the public docs, changelogs and community threads for T3 Code, Conductor, Sculptor and two others. Summary coming up.',
    toolMetadata: null,
  },
  {
    id: 'msg-glass-3',
    role: 'user',
    content:
      'Can we fold Conductor and Sculptor into this too? I mostly care how they show sub-agents.',
    toolMetadata: {
      kind: 'durable_prompt_delivery',
      deliveryId: 'delivery-glass-jonas',
      source: 'user_followup',
      userId: JONAS.id,
      senderName: JONAS.name,
      onBehalfOfUserId: RAPH.id,
      grantId: `grant-${JONAS.id}`,
    },
  },
  { id: 'msg-glass-4', role: 'assistant', content: ASSISTANT_REPLY, toolMetadata: null },
].map((message, index) => ({
  ...message,
  sessionId: GLASS_SESSION_ID,
  createdAt: GLASS_NOW - (30 - index * 6) * MINUTE,
  sequence: index + 1,
}));

const NOTIFICATIONS = [
  {
    id: 'notif-glass-1',
    userId: RAPH.id,
    projectId: GLASS_PROJECT_ID,
    taskId: taskIdFor(SESSION_SPECS[4]!),
    sessionId: 'sess-glass-cve',
    type: 'needs_input',
    urgency: 'high',
    title: 'Agent needs your answer',
    body: 'Should I open a PR with the dependency bump?',
    actionUrl: `/projects/${GLASS_PROJECT_ID}/chat/sess-glass-cve`,
    metadata: { projectName: 'SAM' },
    readAt: null,
    dismissedAt: null,
    createdAt: new Date(GLASS_NOW - 12 * MINUTE).toISOString(),
  },
  {
    id: 'notif-glass-2',
    userId: RAPH.id,
    projectId: GLASS_PROJECT_ID,
    taskId: taskIdFor(SESSION_SPECS[5]!),
    sessionId: 'sess-glass-orphan',
    type: 'task_complete',
    urgency: 'medium',
    title: 'Task finished: Resolve PR #2458 orphaned workspace cleanup',
    body: 'Pull request #2458 is ready for review.',
    actionUrl: `/projects/${GLASS_PROJECT_ID}/chat/sess-glass-orphan`,
    metadata: { projectName: 'SAM' },
    readAt: null,
    dismissedAt: null,
    createdAt: new Date(GLASS_NOW - 40 * MINUTE).toISOString(),
  },
];

const WORKSPACE = {
  id: `ws-${GLASS_SESSION_ID}`,
  nodeId: 'node-03',
  name: 'node-03',
  displayName: 'Competitor research',
  repository: GLASS_PROJECT.repository,
  branch: 'main',
  status: 'running',
  vmSize: 'small',
  vmLocation: 'fsn1',
  workspaceProfile: 'lightweight',
  projectId: GLASS_PROJECT_ID,
  chatSessionId: GLASS_SESSION_ID,
  createdAt: new Date(GLASS_NOW - 2 * HOUR).toISOString(),
  updatedAt: new Date(GLASS_NOW - 2 * MINUTE).toISOString(),
};

const FILE_LIST = {
  path: '.',
  entries: [
    { name: 'apps', type: 'dir', size: 0, modifiedAt: '2026-11-03T13:40:00Z' },
    { name: 'packages', type: 'dir', size: 0, modifiedAt: '2026-11-03T13:40:00Z' },
    { name: 'docs', type: 'dir', size: 0, modifiedAt: '2026-11-03T12:10:00Z' },
    { name: 'CLAUDE.md', type: 'file', size: 18_442, modifiedAt: '2026-11-03T11:02:00Z' },
    { name: 'package.json', type: 'file', size: 2_310, modifiedAt: '2026-11-02T09:15:00Z' },
    {
      name: 'competitor-ui-research-t3-code-conductor-sculptor-session-panels-synthesis.md',
      type: 'file',
      size: 31_904,
      modifiedAt: '2026-11-03T14:12:00Z',
    },
  ],
};

const GIT_STATUS = {
  staged: [{ path: 'docs/research/competitor-ui.md', status: 'A' }],
  unstaged: [
    { path: 'apps/web/src/pages/project-chat/SessionItem.tsx', status: 'M' },
    { path: 'apps/web/src/components/shell/GlassSheet.tsx', status: 'M' },
  ],
  untracked: [{ path: 'notes/needs-you-section-prototype.md', status: '?' }],
};

/**
 * Registers every API route the chat, its panels and the app shell read. `openSessionError`
 * marks the open chat's task as failed with that message, so the failure card shows.
 */
export async function setupGlassChatMocks(
  page: Page,
  options: { theme: 'dark' | 'light'; openSessionError?: string }
) {
  const allSessions = options.openSessionError
    ? GLASS_SESSIONS.map((s) =>
        s.id === GLASS_SESSION_ID
          ? { ...s, task: { ...s.task, status: 'failed', errorMessage: options.openSessionError } }
          : s
      )
    : GLASS_SESSIONS;
  await page.clock.setFixedTime(GLASS_NOW);
  await page.addInitScript(
    ({ userId, theme }) => {
      window.localStorage.setItem('sam-theme', theme);
      window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
      window.localStorage.setItem('sam-session-tool-strip-mode', 'icons');
    },
    { userId: RAPH.id, theme: options.theme }
  );
  await page.routeWebSocket(/\/ws(\?|$)|\/ws\//, (ws) => {
    ws.onMessage((raw) => {
      try {
        if (JSON.parse(String(raw))?.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      } catch {
        /* ignore non-JSON frames */
      }
    });
  });

  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route: Route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      const respond = (body: unknown) => route.fulfill({ status: 200, json: body });

      if (path.includes('/api/auth/')) return respond(GLASS_USER);
      if (path === '/api/notifications/unread-count') return respond({ count: 2 });
      if (path.startsWith('/api/notifications')) {
        return respond({ notifications: NOTIFICATIONS, unreadCount: 2, nextCursor: null });
      }
      if (path === '/api/credentials/agent') {
        return respond({ credentials: [{ agentType: 'claude-code', isActive: true }] });
      }
      if (path.startsWith('/api/credentials')) {
        return respond([{ id: 'cred-glass-hetzner', provider: 'hetzner', name: 'Hetzner' }]);
      }
      if (path === '/api/github/installations') {
        return respond([{ id: 'inst-1', accountName: 'raphaeltm', accountType: 'User' }]);
      }
      if (path === '/api/agents') return respond({ agents: [] });
      if (path === '/api/nodes') return respond([]);
      if (path === '/api/report-issue/config') return respond({ enabled: true });
      if (path === '/api/trial/status') return respond({ available: false });
      if (path === '/api/workspaces') return respond([WORKSPACE]);
      if (path.startsWith('/api/workspaces/')) return respond(WORKSPACE);
      if (path === '/api/projects') return respond({ projects: [GLASS_PROJECT], nextCursor: null });
      if (path === '/api/chats/recent' || path.startsWith('/api/chats')) {
        return respond({
          sessions: allSessions.slice(0, 5).map((session) => ({
            ...session,
            projectName: GLASS_PROJECT.name,
          })),
          hasMore: false,
        });
      }

      const match = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
      if (!match) return respond({});
      const sub = match[2] ?? '';
      const open = allSessions.find((s) => s.id === GLASS_SESSION_ID)!;
      if (sub === '/members') return respond(MEMBERS);
      if (sub === `/sessions/${GLASS_SESSION_ID}/access`) return respond(open.access);
      if (sub === `/sessions/${GLASS_SESSION_ID}/comments`) return respond({ comments: [] });
      if (sub === '/comment-threads') return respond({ threads: [], total: 0 });
      if (sub === '/sessions') {
        const scope = url.searchParams.get('scope');
        const sessions = scope === 'my' ? allSessions.filter((s) => s.isMine) : allSessions;
        return respond({ sessions, total: sessions.length, hasMore: false });
      }
      if (/^\/sessions\/[^/]+\/state$/.test(sub)) return respond(makeIdleSessionState());
      if (sub === `/sessions/${GLASS_SESSION_ID}`) {
        return respond({
          session: open,
          messages: GLASS_MESSAGES,
          hasMore: false,
          state: makeIdleSessionState(),
        });
      }
      if (sub === `/sessions/${GLASS_SESSION_ID}/messages`) {
        return respond({ messages: GLASS_MESSAGES, hasMore: false });
      }
      if (sub === '/tasks') return respond({ tasks: GLASS_TASKS, nextCursor: null });
      if (sub.endsWith('/files/list')) return respond(FILE_LIST);
      if (sub.endsWith('/git/status')) return respond(GIT_STATUS);
      if (sub === '/agent-profiles' || sub === '/skills') return respond({ items: [] });
      if (sub === '/triggers') return respond({ triggers: [] });
      if (/\/commands|\/cached-commands/.test(sub)) return respond({ commands: [] });
      if (sub === '/credential-attribution-health') {
        return respond({
          multiplayerActive: true,
          counts: {
            resources: 0,
            personalResources: 0,
            personalCredentials: 0,
            projectCoveredCredentials: 0,
          },
          resources: [],
        });
      }
      if (sub === '') return respond(GLASS_PROJECT);
      // Empty bounded lists for the project's remaining list endpoints (automation schedules,
      // watches, subscriptions, triggers), so panels render their empty states instead of
      // reading fields off a bare object.
      return respond({ items: [], subscriptions: [], nextCursor: null, total: 0, hasMore: false });
    }
  );
}
