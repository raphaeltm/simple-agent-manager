/**
 * Mock data for the chat-toolbar prototype.
 *
 * Shapes are the real production types (`ChatSessionResponse`, `WorkspaceResponse`,
 * `NodeResponse`, `DetectedPort`, `ConversationItem`) so the real `SessionHeader`,
 * `AcpConversationItemView`, and `ProjectChatComposer` render exactly as they do in
 * production. Values are stress-shaped per `.claude/rules/17-ui-visual-testing.md`:
 * long titles, long unbroken tokens, many ports, wide agent output.
 */
import type { ConversationItem } from '@simple-agent-manager/acp-client';
import type { DetectedPort, NodeResponse, WorkspaceResponse } from '@simple-agent-manager/shared';

import type { ChatSessionResponse } from '../../lib/api';

export const MOCK_PROJECT_ID = '01KHRJGANBBWGDY1NZ0KVF0D4J';
export const MOCK_SESSION_ID = '07472787-24af-4bcd-ba28-a31ed6c2411f';
export const MOCK_TASK_ID = '01M19FTM2MT79QA3FVHYBS3VZ9';
export const MOCK_WORKSPACE_ID = '01M19QJAG22NDG97TD8C8TGQFK';
export const MOCK_NODE_ID = '01M0Z8Z1KQ4V7YB2W9NRTC5XJH';

const SHORT_TITLE = 'Identify source and purpose of running tasks';
const LONG_TITLE =
  'Identify source and purpose of every running task, then reconcile the supersession ledger against the ProjectData Durable Object so the active-agent count stops reporting ten times the real compute';

/** Base session — `topic` and lifecycle fields are overridden per scenario. */
export function makeSession(opts: {
  long?: boolean;
  state?: 'active' | 'idle' | 'sleeping' | 'terminated';
}): ChatSessionResponse {
  const { long = false, state = 'sleeping' } = opts;
  const now = Date.now();

  return {
    id: MOCK_SESSION_ID,
    workspaceId: MOCK_WORKSPACE_ID,
    taskId: MOCK_TASK_ID,
    createdByUserId: 'user-raphael',
    createdBy: {
      id: 'user-raphael',
      name: 'Raphaël Titsworth-Morin',
      email: 'raphael@example.com',
      image: null,
      avatarUrl: null,
    },
    isMine: true,
    topic: long ? LONG_TITLE : SHORT_TITLE,
    status: state === 'terminated' ? 'stopped' : 'active',
    messageCount: 42,
    startedAt: now - 1000 * 60 * 96,
    endedAt: state === 'terminated' ? now - 1000 * 60 * 4 : null,
    createdAt: now - 1000 * 60 * 96,
    agentCompletedAt: state === 'active' ? null : now - 1000 * 60 * 12,
    lastMessageAt: now - 1000 * 60 * 12,
    isIdle: state === 'idle',
    isTerminated: state === 'terminated',
    workspaceUrl: `https://ws-${MOCK_WORKSPACE_ID.toLowerCase()}.sammy.party`,
    cleanupAt: state === 'idle' ? now + 1000 * 60 * 7 : null,
    agentSessionId: '01M19QKJ4AA6D0T3VSEGGMGKDZ',
    agentType: 'claude-code',
    attention: null,
    task: {
      id: MOCK_TASK_ID,
      status: state === 'active' ? 'in_progress' : 'awaiting_followup',
      executionStep: state === 'active' ? 'agent_running' : null,
      errorMessage: null,
      outputBranch: 'sam/layered-resource-management',
      outputPrUrl: 'https://github.com/raphaeltm/simple-agent-manager/pull/1974',
      outputSummary: null,
      finalizedAt: null,
      taskMode: 'conversation',
      agentProfileHint: 'Codex 5.5 High Chat',
    },
  };
}

export function makeWorkspace(): WorkspaceResponse {
  return {
    id: MOCK_WORKSPACE_ID,
    nodeId: MOCK_NODE_ID,
    projectId: MOCK_PROJECT_ID,
    name: 'few-buttons-drop-down',
    displayName: 'few-buttons-drop-down',
    repository: 'raphaeltm/simple-agent-manager',
    branch: 'sam/few-buttons-drop-down-fvckk5',
    status: 'running',
    vmSize: 'medium',
    vmLocation: 'nbg1',
    workspaceProfile: 'lightweight',
    devcontainerConfigName: null,
    vmIp: '203.0.113.42',
    lastActivityAt: new Date(Date.now() - 1000 * 60 * 12).toISOString(),
    portsPublicEnabled: false,
    errorMessage: null,
    createdAt: new Date(Date.now() - 1000 * 60 * 96).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 12).toISOString(),
    chatSessionId: MOCK_SESSION_ID,
  };
}

export function makeNode(): NodeResponse {
  return {
    id: MOCK_NODE_ID,
    name: 'sam-node-nbg1-7f3a',
    status: 'running',
    healthStatus: 'healthy',
    cloudProvider: 'hetzner',
    vmSize: 'medium',
    vmLocation: 'nbg1',
    nodeRole: 'workspace',
    nodeClass: 'managed',
    transport: null,
    tunnelName: null,
    ipAddress: '203.0.113.42',
    lastHeartbeatAt: new Date(Date.now() - 1000 * 18).toISOString(),
    heartbeatStaleAfterSeconds: 180,
    lastMetrics: null,
    errorMessage: null,
    createdAt: new Date(Date.now() - 1000 * 60 * 120).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 18).toISOString(),
  };
}

/** Several ports so the header renders the "+N more" affordance. */
export function makePorts(count = 3): DetectedPort[] {
  const all: DetectedPort[] = [
    {
      port: 5173,
      address: '127.0.0.1',
      label: 'Vite dev server',
      url: 'https://ws-abc--5173.sammy.party',
      detectedAt: new Date().toISOString(),
    },
    {
      port: 8787,
      address: '127.0.0.1',
      label: 'Wrangler',
      url: 'https://ws-abc--8787.sammy.party',
      detectedAt: new Date().toISOString(),
    },
    {
      port: 4983,
      address: '127.0.0.1',
      label: 'Drizzle Studio',
      url: 'https://ws-abc--4983.sammy.party',
      detectedAt: new Date().toISOString(),
    },
  ];
  return all.slice(0, count);
}

const AGENT_TEXT_1 = `Both Wave 1 tasks are done and their commits are on \`sam/layered-resource-management\`.

**What it did after waking:**

- It saw both Wave 1 tasks were done.
- It reported both Wave 1 commits are on \`sam/layered-resource-management\`.
- It dispatched Wave 2:
  - task \`01M19FTM2MT79QA3FVHYBS3VZ9\`
  - session \`07472787-24af-4bcd-ba28-a31ed6c2411f\`
  - title: "Implement pre-stop snapshot capture and container eviction mechanics in vm-agent"
  - status: \`in_progress\`

Current wrinkle: the coordinator itself does not appear as a live active runtime right now; it resumed, dispatched Wave 2, then appears to have yielded/slept again. But it is no longer stranded in the same way: the wake message landed, and the next implementation task is actively running.`;

const AGENT_TEXT_LONG = `${AGENT_TEXT_1}

Here is the unbroken identifier that stress-tests horizontal overflow: \`sam/layered-resource-management-with-an-extremely-long-branch-name-that-will-not-wrap-on-its-own-0123456789\`

And a bare URL: https://github.com/raphaeltm/simple-agent-manager/blob/sam/layered-resource-management/apps/api/src/durable-objects/project-data/knowledge.ts#L128-L214`;

export function makeConversation(opts: { long?: boolean } = {}): ConversationItem[] {
  const { long = false } = opts;
  const t0 = Date.now() - 1000 * 60 * 30;

  return [
    {
      kind: 'user_message',
      id: 'msg-user-1',
      text: 'Where did the running tasks come from, and what is each one actually doing right now?',
      timestamp: t0,
    },
    {
      kind: 'tool_call',
      id: 'msg-tool-1',
      toolCallId: 'tc-1',
      title: 'list_tasks',
      toolKind: 'other',
      toolName: 'mcp__sam-mcp__list_tasks',
      status: 'completed',
      content: [{ type: 'content', text: '68 tasks in_progress, 4 running workspaces' }],
      locations: [],
      timestamp: t0 + 1000 * 20,
    },
    {
      kind: 'agent_message',
      id: 'msg-agent-1',
      text: long ? AGENT_TEXT_LONG : AGENT_TEXT_1,
      streaming: false,
      timestamp: t0 + 1000 * 60 * 2,
    },
  ];
}

/** Empty-state variant — a brand new session with nothing in it yet. */
export const EMPTY_CONVERSATION: ConversationItem[] = [];
