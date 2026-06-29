import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildTaskAgentSessionLabel,
  buildTaskInitialPrompt,
  handleAgentSession,
} from '../../../src/durable-objects/task-runner/agent-session-step';
import { redactTaskRunnerStatus } from '../../../src/durable-objects/task-runner/status';
import type {
  TaskRunnerContext,
  TaskRunnerState,
} from '../../../src/durable-objects/task-runner/types';

const {
  createAgentSessionOnNodeMock,
  createAcpSessionMock,
  insertedAgentSessions,
  startAgentSessionOnNodeMock,
  storeMcpTokenMock,
  transitionAcpSessionMock,
} = vi.hoisted(() => ({
  createAgentSessionOnNodeMock: vi.fn(async () => undefined),
  createAcpSessionMock: vi.fn(async () => ({ id: 'acp-session-1' })),
  insertedAgentSessions: [] as Array<Record<string, unknown>>,
  startAgentSessionOnNodeMock: vi.fn(async () => undefined),
  storeMcpTokenMock: vi.fn(async () => undefined),
  transitionAcpSessionMock: vi.fn(async () => undefined),
}));

vi.mock('../../../src/lib/ulid', () => ({
  ulid: () => 'agent-session-new',
}));

vi.mock('../../../src/services/mcp-token', () => ({
  generateMcpToken: () => 'mcp-token-new',
  storeMcpToken: storeMcpTokenMock,
}));

vi.mock('../../../src/services/node-agent', () => ({
  createAgentSessionOnNode: createAgentSessionOnNodeMock,
  startAgentSessionOnNode: startAgentSessionOnNodeMock,
}));

vi.mock('../../../src/services/project-data', () => ({
  createAcpSession: createAcpSessionMock,
  persistMessage: vi.fn(async () => undefined),
  transitionAcpSession: transitionAcpSessionMock,
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        insertedAgentSessions.push(row);
      },
    }),
  }),
}));

function makeState(overrides: Partial<TaskRunnerState> = {}): TaskRunnerState {
  return {
    version: 1,
    taskId: 'task-1',
    projectId: 'project-1',
    userId: 'user-1',
    currentStep: 'agent_session',
    stepResults: {
      nodeId: 'node-1',
      autoProvisioned: false,
      workspaceId: 'workspace-1',
      chatSessionId: 'chat-1',
      agentSessionId: null,
      agentStarted: false,
      mcpToken: null,
      provisionedVmSize: null,
    },
    config: {
      vmSize: 'medium',
      vmLocation: 'nbg1',
      branch: 'main',
      preferredNodeId: null,
      userName: 'Test User',
      userEmail: 'test@example.com',
      githubId: 'gh-1',
      taskTitle: 'Fix runtime orchestration coverage with a deliberately long title',
      taskDescription: 'Exercise the TaskRunner agent-session path.',
      repository: 'octo/repo',
      installationId: 'install-1',
      outputBranch: 'task-runner-tests',
      defaultBranch: 'main',
      projectDefaultVmSize: null,
      chatSessionId: 'chat-1',
      agentType: 'openai-codex',
      workspaceProfile: null,
      devcontainerConfigName: null,
      cloudProvider: null,
      taskMode: 'task',
      model: 'gpt-5-codex',
      effort: 'high',
      permissionMode: 'auto-edit',
      opencodeProvider: null,
      opencodeBaseUrl: null,
      systemPromptAppend: 'Use the backend implementation profile.',
      agentProfileHint: 'profile-1',
      attachments: [
        {
          uploadId: 'attachment-1',
          filename: 'evidence.txt',
          contentType: 'text/plain',
          size: 123,
        },
      ],
    },
    retryCount: 0,
    workspaceReadyReceived: true,
    workspaceReadyStatus: 'running',
    workspaceErrorMessage: null,
    createdAt: Date.parse('2026-06-29T10:00:00.000Z'),
    lastStepAt: Date.parse('2026-06-29T10:00:00.000Z'),
    provisioningStartedAt: null,
    agentReadyStartedAt: null,
    workspaceReadyStartedAt: null,
    workspaceDispatchStartedAt: null,
    workspaceDispatchAttempts: 0,
    workspaceDispatchLastAttemptAt: null,
    workspaceDispatchLastError: null,
    workspaceDispatchAckedAt: null,
    lastD1Step: 'agent_session',
    completed: false,
    ...overrides,
  };
}

function makeContext(opts: {
  existingAgentSessionIds?: Set<string>;
  transitionChanges?: number;
} = {}) {
  const existingAgentSessionIds = opts.existingAgentSessionIds ?? new Set<string>();
  const transitionChanges = opts.transitionChanges ?? 1;
  const storageWrites: TaskRunnerState[] = [];
  const statusEvents: Array<{
    taskId: string;
    fromStatus: string;
    toStatus: string;
    reason: string;
  }> = [];

  const database = {
    prepare: vi.fn((sql: string) => ({
      bind: (...params: unknown[]) => ({
        first: async () => {
          if (sql.includes('SELECT id FROM agent_sessions')) {
            const sessionId = String(params[0]);
            return existingAgentSessionIds.has(sessionId) ? { id: sessionId } : null;
          }
          return null;
        },
        run: async () => {
          if (sql.includes("UPDATE tasks SET status = 'in_progress'")) {
            return { success: true, meta: { changes: transitionChanges } };
          }
          if (sql.includes('INSERT INTO task_status_events')) {
            statusEvents.push({
              taskId: String(params[1]),
              fromStatus: 'delegated',
              toStatus: 'in_progress',
              reason: String(params[2]),
            });
          }
          return { success: true, meta: { changes: 1 } };
        },
      }),
    })),
  };

  const rc = {
    env: {
      BASE_DOMAIN: 'example.test',
      DATABASE: database,
      DEFAULT_TASK_AGENT_TYPE: 'claude-code',
      KV: { put: vi.fn(), delete: vi.fn(), get: vi.fn() },
    },
    ctx: {
      storage: {
        put: vi.fn(async (_key: string, state: TaskRunnerState) => {
          storageWrites.push(structuredClone(state));
        }),
      },
    },
    updateD1ExecutionStep: vi.fn(async () => undefined),
  } as unknown as TaskRunnerContext;

  return {
    database,
    rc,
    statusEvents,
    storageWrites,
  };
}

describe('TaskRunner agent-session helpers', () => {
  it('builds the session label from the task title with the production truncation rule', () => {
    expect(buildTaskAgentSessionLabel('Short task')).toBe('Task: Short task');
    expect(buildTaskAgentSessionLabel('x'.repeat(45))).toBe(`Task: ${'x'.repeat(40)}`);
  });

  it('builds the initial prompt with task content, attachments, profile prompt, and MCP instructions', () => {
    const prompt = buildTaskInitialPrompt(makeState());

    expect(prompt).toContain('Exercise the TaskRunner agent-session path.');
    expect(prompt).toContain('/workspaces/.private/evidence.txt');
    expect(prompt).toContain('123 bytes, text/plain');
    expect(prompt).toContain('Use the backend implementation profile.');
    expect(prompt).toContain('get_instructions');
    expect(prompt.indexOf('Use the backend implementation profile.')).toBeLessThan(
      prompt.indexOf('IMPORTANT:'),
    );
  });

  it('redacts persisted MCP tokens from status snapshots', () => {
    const state = makeState({
      stepResults: {
        ...makeState().stepResults,
        mcpToken: 'mcp-token-secret',
      },
    });

    const status = redactTaskRunnerStatus(state);

    expect(status?.stepResults.mcpToken).toBe('[redacted]');
    expect(state.stepResults.mcpToken).toBe('mcp-token-secret');
  });
});

describe('handleAgentSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertedAgentSessions.length = 0;
  });

  it('creates the D1 agent-session row, starts the VM session, persists MCP token state, and transitions the task to running', async () => {
    const state = makeState();
    const { rc, statusEvents, storageWrites } = makeContext();

    await handleAgentSession(state, rc);

    expect(insertedAgentSessions).toHaveLength(1);
    expect(insertedAgentSessions[0]).toMatchObject({
      id: 'agent-session-new',
      workspaceId: 'workspace-1',
      userId: 'user-1',
      status: 'running',
      label: 'Task: Fix runtime orchestration coverage with ',
      agentType: 'openai-codex',
    });

    expect(createAgentSessionOnNodeMock).toHaveBeenCalledWith(
      'node-1',
      'workspace-1',
      'agent-session-new',
      'Task: Fix runtime orchestration coverage with ',
      expect.objectContaining({ BASE_DOMAIN: 'example.test' }),
      'user-1',
      'chat-1',
      'project-1',
    );

    expect(storeMcpTokenMock).toHaveBeenCalledWith(
      expect.anything(),
      'mcp-token-new',
      expect.objectContaining({
        taskId: 'task-1',
        projectId: 'project-1',
        userId: 'user-1',
        workspaceId: 'workspace-1',
      }),
      expect.objectContaining({ BASE_DOMAIN: 'example.test' }),
    );

    expect(startAgentSessionOnNodeMock).toHaveBeenCalledWith(
      'node-1',
      'workspace-1',
      'agent-session-new',
      'openai-codex',
      expect.stringContaining('Exercise the TaskRunner agent-session path.'),
      expect.objectContaining({ BASE_DOMAIN: 'example.test' }),
      'user-1',
      { url: 'https://api.example.test/mcp', token: 'mcp-token-new' },
      expect.objectContaining({
        model: 'gpt-5-codex',
        effort: 'high',
        permissionMode: 'auto-edit',
      }),
      { projectId: 'project-1', taskId: 'task-1', taskMode: 'task' },
    );

    expect(state.stepResults.agentSessionId).toBe('agent-session-new');
    expect(state.stepResults.mcpToken).toBe('mcp-token-new');
    expect(state.stepResults.agentStarted).toBe(true);
    expect(state.currentStep).toBe('running');
    expect(state.completed).toBe(true);
    expect(statusEvents).toEqual([
      {
        taskId: 'task-1',
        fromStatus: 'delegated',
        toStatus: 'in_progress',
        reason: 'Agent session agent-session-new created. Task execution started.',
      },
    ]);
    expect(storageWrites.some((write) => write.stepResults.mcpToken === 'mcp-token-new')).toBe(true);
    expect(storageWrites.at(-1)?.completed).toBe(true);
  });

  it('is idempotent on retry when agentSessionId already exists in D1', async () => {
    const state = makeState({
      stepResults: {
        ...makeState().stepResults,
        agentSessionId: 'agent-session-existing',
      },
    });
    const { rc } = makeContext({
      existingAgentSessionIds: new Set(['agent-session-existing']),
    });

    await handleAgentSession(state, rc);

    expect(insertedAgentSessions).toHaveLength(0);
    expect(createAgentSessionOnNodeMock).not.toHaveBeenCalled();
    expect(startAgentSessionOnNodeMock).toHaveBeenCalledOnce();
    expect(state.stepResults.agentSessionId).toBe('agent-session-existing');
  });

  it('resets a stale stored agentSessionId when the D1 row is gone and recreates it', async () => {
    const state = makeState({
      stepResults: {
        ...makeState().stepResults,
        agentSessionId: 'agent-session-missing',
        agentStarted: true,
      },
    });
    const { rc, storageWrites } = makeContext();

    await handleAgentSession(state, rc);

    expect(insertedAgentSessions).toHaveLength(1);
    expect(state.stepResults.agentSessionId).toBe('agent-session-new');
    expect(state.stepResults.agentStarted).toBe(true);
    expect(storageWrites.some((write) => write.stepResults.agentSessionId === null)).toBe(true);
  });

  it('does not start the VM agent again once agentStarted is true', async () => {
    const state = makeState({
      stepResults: {
        ...makeState().stepResults,
        agentSessionId: 'agent-session-existing',
        agentStarted: true,
        mcpToken: 'mcp-token-existing',
      },
    });
    const { rc } = makeContext({
      existingAgentSessionIds: new Set(['agent-session-existing']),
    });

    await handleAgentSession(state, rc);

    expect(insertedAgentSessions).toHaveLength(0);
    expect(createAgentSessionOnNodeMock).not.toHaveBeenCalled();
    expect(storeMcpTokenMock).not.toHaveBeenCalled();
    expect(startAgentSessionOnNodeMock).not.toHaveBeenCalled();
    expect(state.currentStep).toBe('running');
    expect(state.completed).toBe(true);
  });
});
