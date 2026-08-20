import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildInjectedInstructions,
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
  completeSessionSnapshotRecoveryMock,
  dbAgentSessionIds,
  failSessionSnapshotRecoveryMock,
  getAcpSessionMock,
  insertedAgentSessions,
  prepareAcpSessionForFreshStartMock,
  revokeMcpTokenMock,
  restoreAgentSessionOnNodeMock,
  startAgentSessionOnNodeMock,
  storeMcpTokenMock,
  transitionAcpSessionMock,
  wakeSessionMock,
} = vi.hoisted(() => ({
  createAgentSessionOnNodeMock: vi.fn(async () => undefined),
  createAcpSessionMock: vi.fn(async () => ({ id: 'acp-session-1' })),
  completeSessionSnapshotRecoveryMock: vi.fn(async () => true),
  dbAgentSessionIds: new Set<string>(),
  failSessionSnapshotRecoveryMock: vi.fn(async () => undefined),
  getAcpSessionMock: vi.fn(async () => null),
  insertedAgentSessions: [] as Array<Record<string, unknown>>,
  prepareAcpSessionForFreshStartMock: vi.fn(async () => ({ id: 'agent-session-new' })),
  revokeMcpTokenMock: vi.fn(async () => undefined),
  restoreAgentSessionOnNodeMock: vi.fn(async () => ({ status: 'restored' })),
  startAgentSessionOnNodeMock: vi.fn(async () => undefined),
  storeMcpTokenMock: vi.fn(async () => undefined),
  transitionAcpSessionMock: vi.fn(async () => undefined),
  wakeSessionMock: vi.fn(async () => true),
}));

vi.mock('../../../src/lib/ulid', () => ({
  ulid: () => 'agent-session-new',
}));

vi.mock('../../../src/services/mcp-token', () => ({
  generateMcpToken: () => 'mcp-token-new',
  revokeMcpToken: revokeMcpTokenMock,
  storeMcpToken: storeMcpTokenMock,
}));

vi.mock('../../../src/services/node-agent', () => ({
  createAgentSessionOnNode: createAgentSessionOnNodeMock,
  restoreAgentSessionOnNode: restoreAgentSessionOnNodeMock,
  startAgentSessionOnNode: startAgentSessionOnNodeMock,
}));

vi.mock('../../../src/services/project-data', () => ({
  createAcpSession: createAcpSessionMock,
  getAcpSession: getAcpSessionMock,
  persistMessage: vi.fn(async () => undefined),
  prepareAcpSessionForFreshStart: prepareAcpSessionForFreshStartMock,
  transitionAcpSession: transitionAcpSessionMock,
  wakeSession: wakeSessionMock,
}));

vi.mock('../../../src/services/session-snapshots', () => ({
  completeSessionSnapshotRecovery: completeSessionSnapshotRecoveryMock,
  failSessionSnapshotRecovery: failSessionSnapshotRecoveryMock,
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            const existingId = [...dbAgentSessionIds][0];
            return existingId ? [{ id: existingId }] : [];
          },
        }),
      }),
    }),
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        insertedAgentSessions.push(row);
        if (typeof row.id === 'string') {
          dbAgentSessionIds.add(row.id);
        }
      },
    }),
    update: () => ({
      set: () => ({
        where: async () => undefined,
      }),
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

function makeContext(
  opts: {
    existingAgentSessionIds?: Set<string>;
    transitionChanges?: number;
  } = {}
) {
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
      // Real `rc.ctx` is a DurableObjectState, which always has waitUntil; the
      // mock previously omitted it, so any code offloading background work here
      // would throw rather than be exercised.
      waitUntil: vi.fn((promise: Promise<unknown>) => {
        void Promise.resolve(promise).catch(() => undefined);
      }),
    },
    assertRecoveryAuthority: vi.fn(async () => undefined),
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

  it('builds the visible initial prompt with task content, attachments, and profile prompt (no injected reminder)', () => {
    const prompt = buildTaskInitialPrompt(makeState());

    expect(prompt).toContain('Exercise the TaskRunner agent-session path.');
    expect(prompt).toContain('/workspaces/.private/evidence.txt');
    expect(prompt).toContain('123 bytes, text/plain');
    expect(prompt).toContain('Use the backend implementation profile.');
    // The get_instructions reminder is now a SEPARATE origin="system" injected
    // block (buildInjectedInstructions), NOT part of the visible user message.
    expect(prompt).not.toContain('get_instructions');
    expect(prompt).not.toContain('IMPORTANT:');
  });

  it('builds the injected system instructions containing the get_instructions reminder', () => {
    const injected = buildInjectedInstructions();
    expect(injected).toContain('get_instructions');
    expect(injected).toContain('IMPORTANT:');
    expect(injected).toContain('sam-mcp');
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
    dbAgentSessionIds.clear();
    getAcpSessionMock.mockResolvedValue(null);
    insertedAgentSessions.length = 0;
    completeSessionSnapshotRecoveryMock.mockResolvedValue(true);
    prepareAcpSessionForFreshStartMock.mockResolvedValue({ id: 'agent-session-new' });
    restoreAgentSessionOnNodeMock.mockResolvedValue({ status: 'restored' });
    transitionAcpSessionMock.mockResolvedValue(undefined);
    wakeSessionMock.mockResolvedValue(true);
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
      { url: 'https://api.example.test/mcp', token: 'mcp-token-new' },
      expect.objectContaining({
        beforeExternalMutation: expect.any(Function),
        sourceTaskGuard: undefined,
      })
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
      expect.objectContaining({ BASE_DOMAIN: 'example.test' })
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
      // Injected system instructions (get_instructions reminder) sent as a
      // separate origin="system" prompt block.
      expect.stringContaining('get_instructions'),
      expect.objectContaining({
        beforeExternalMutation: expect.any(Function),
        sourceTaskGuard: undefined,
      })
    );

    const startArgs = startAgentSessionOnNodeMock.mock.calls[0]!;
    expect(startArgs[4]).not.toContain('get_instructions');
    expect(startArgs[4]).toContain('Exercise the TaskRunner agent-session path.');
    expect(startArgs[10]).toContain('get_instructions');

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
    expect(storageWrites.some((write) => write.stepResults.mcpToken === 'mcp-token-new')).toBe(
      true
    );
    expect(storageWrites.at(-1)?.completed).toBe(true);
  });

  it('rechecks source authority at the agent boundary and never sends a stale initial prompt', async () => {
    restoreAgentSessionOnNodeMock.mockResolvedValueOnce({
      status: 'degraded',
      message: 'Restore requires a fresh session.',
    });
    const state = makeState({
      config: {
        ...makeState().config,
        resumeSnapshotChatSessionId: 'chat-1',
        recoverySourceTaskId: 'parent-task-1',
      },
    });
    const { rc } = makeContext();
    const revoked = Object.assign(new Error('Session recovery authority was revoked'), {
      permanent: true,
    });
    vi.mocked(rc.assertRecoveryAuthority).mockImplementation(async () => {
      if (restoreAgentSessionOnNodeMock.mock.calls.length > 0) throw revoked;
    });

    await expect(handleAgentSession(state, rc)).rejects.toBe(revoked);

    expect(restoreAgentSessionOnNodeMock).toHaveBeenCalledOnce();
    expect(restoreAgentSessionOnNodeMock.mock.calls[0]?.at(-1)).toMatchObject({
      sourceTaskGuard: {
        taskId: 'parent-task-1',
        projectId: 'project-1',
        chatSessionId: 'chat-1',
      },
      beforeExternalMutation: expect.any(Function),
    });
    expect(startAgentSessionOnNodeMock).not.toHaveBeenCalled();
    expect(completeSessionSnapshotRecoveryMock).not.toHaveBeenCalled();
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
    dbAgentSessionIds.add('agent-session-existing');

    await handleAgentSession(state, rc);

    expect(insertedAgentSessions).toHaveLength(0);
    expect(createAgentSessionOnNodeMock).toHaveBeenCalledWith(
      'node-1',
      'workspace-1',
      'agent-session-existing',
      'Task: Fix runtime orchestration coverage with ',
      expect.objectContaining({ BASE_DOMAIN: 'example.test' }),
      'user-1',
      'chat-1',
      'project-1',
      { url: 'https://api.example.test/mcp', token: 'mcp-token-new' },
      expect.objectContaining({
        beforeExternalMutation: expect.any(Function),
        sourceTaskGuard: undefined,
      })
    );
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

  it('wakes ProjectData before clearing the durable sleeping snapshot claim', async () => {
    const state = makeState({
      config: {
        ...makeState().config,
        resumeSnapshotChatSessionId: 'chat-1',
      },
    });
    const { rc } = makeContext();

    await handleAgentSession(state, rc);

    expect(restoreAgentSessionOnNodeMock).toHaveBeenCalledWith(
      'node-1',
      'workspace-1',
      'agent-session-new',
      expect.objectContaining({ BASE_DOMAIN: 'example.test' }),
      'user-1',
      expect.objectContaining({ chatSessionId: 'chat-1', agentType: 'openai-codex' }),
      expect.objectContaining({
        beforeExternalMutation: expect.any(Function),
        sourceTaskGuard: undefined,
      })
    );
    expect(startAgentSessionOnNodeMock).not.toHaveBeenCalled();
    expect(wakeSessionMock).toHaveBeenCalledWith(
      rc.env,
      'project-1',
      'chat-1',
      'workspace-1',
      'task-1'
    );
    expect(wakeSessionMock.mock.invocationCallOrder[0]).toBeLessThan(
      completeSessionSnapshotRecoveryMock.mock.invocationCallOrder[0]
    );
    expect(completeSessionSnapshotRecoveryMock).toHaveBeenCalledWith(
      expect.anything(),
      'chat-1',
      'task-1',
      'workspace-1'
    );
    expect(state.config.resumeSnapshotChatSessionId).toBeNull();
  });

  it('commits snapshot recovery when a retry sees the agent session already started', async () => {
    const state = makeState({
      stepResults: {
        ...makeState().stepResults,
        agentSessionId: 'agent-session-existing',
        agentStarted: true,
        mcpToken: 'mcp-token-existing',
      },
      config: {
        ...makeState().config,
        resumeSnapshotChatSessionId: 'chat-1',
      },
    });
    const { rc } = makeContext({
      existingAgentSessionIds: new Set(['agent-session-existing']),
    });

    await handleAgentSession(state, rc);

    expect(createAgentSessionOnNodeMock).not.toHaveBeenCalled();
    expect(startAgentSessionOnNodeMock).not.toHaveBeenCalled();
    expect(wakeSessionMock).toHaveBeenCalledWith(
      rc.env,
      'project-1',
      'chat-1',
      'workspace-1',
      'task-1'
    );
    expect(completeSessionSnapshotRecoveryMock).toHaveBeenCalledWith(
      expect.anything(),
      'chat-1',
      'task-1',
      'workspace-1'
    );
    expect(state.config.resumeSnapshotChatSessionId).toBeNull();
    expect(state.currentStep).toBe('running');
  });

  it('repairs a failed ACP row when strict snapshot restore reports restored before marking running', async () => {
    let rejectedRunning = false;
    getAcpSessionMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'agent-session-new', status: 'failed' });
    transitionAcpSessionMock.mockImplementation(async (...args: unknown[]) => {
      if (args[3] === 'running' && !rejectedRunning) {
        rejectedRunning = true;
        throw new Error('Invalid ACP session transition: failed → running');
      }
      return undefined;
    });
    const state = makeState({
      config: {
        ...makeState().config,
        resumeSnapshotChatSessionId: 'chat-1',
      },
    });
    const { rc } = makeContext();

    await handleAgentSession(state, rc);

    expect(restoreAgentSessionOnNodeMock).toHaveBeenCalledOnce();
    expect(startAgentSessionOnNodeMock).not.toHaveBeenCalled();
    expect(prepareAcpSessionForFreshStartMock).toHaveBeenCalledWith(
      rc.env,
      'project-1',
      'agent-session-new',
      expect.objectContaining({
        workspaceId: 'workspace-1',
        nodeId: 'node-1',
      })
    );
    expect(
      transitionAcpSessionMock.mock.calls.filter((call) => call[3] === 'running')
    ).toHaveLength(2);
    expect(completeSessionSnapshotRecoveryMock).toHaveBeenCalledWith(
      expect.anything(),
      'chat-1',
      'task-1',
      'workspace-1'
    );
    expect(state.config.resumeSnapshotChatSessionId).toBeNull();
  });

  it('falls back to a fresh ACP session when snapshot restore is degraded', async () => {
    createAcpSessionMock.mockResolvedValueOnce({ id: 'agent-session-new' });
    restoreAgentSessionOnNodeMock.mockResolvedValueOnce({
      status: 'degraded',
      message: 'The saved workspace was restored, but the agent context could not be resumed.',
    });
    const state = makeState({
      config: {
        ...makeState().config,
        resumeSnapshotChatSessionId: 'chat-1',
      },
    });
    const { rc } = makeContext();

    await handleAgentSession(state, rc);

    expect(createAcpSessionMock).toHaveBeenCalledTimes(1);
    expect(createAcpSessionMock.mock.calls[0][7]).toBe('agent-session-new');
    expect(prepareAcpSessionForFreshStartMock).toHaveBeenCalledWith(
      rc.env,
      'project-1',
      'agent-session-new',
      expect.objectContaining({
        actorType: 'system',
        actorId: 'task-runner',
        workspaceId: 'workspace-1',
        nodeId: 'node-1',
      })
    );
    expect(restoreAgentSessionOnNodeMock).toHaveBeenCalledOnce();
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
      expect.stringContaining('get_instructions'),
      expect.objectContaining({
        beforeExternalMutation: expect.any(Function),
        sourceTaskGuard: undefined,
      })
    );
    expect(transitionAcpSessionMock).toHaveBeenCalledWith(
      rc.env,
      'project-1',
      'agent-session-new',
      'running',
      expect.objectContaining({
        acpSdkSessionId: 'agent-session-new',
        reason: 'Task runner agent session started',
      })
    );
    expect(completeSessionSnapshotRecoveryMock).toHaveBeenCalledWith(
      expect.anything(),
      'chat-1',
      'task-1',
      'workspace-1'
    );
    expect(state.config.resumeSnapshotChatSessionId).toBeNull();
  });

  it('prepares the ACP row when degraded fallback recovers it after an initial create failure', async () => {
    createAcpSessionMock
      .mockRejectedValueOnce(new Error('transient ProjectData create failure'))
      .mockResolvedValueOnce({ id: 'agent-session-new' });
    restoreAgentSessionOnNodeMock.mockResolvedValueOnce({
      status: 'degraded',
      message: 'The saved workspace was restored, but the agent context could not be resumed.',
    });
    const state = makeState({
      config: {
        ...makeState().config,
        resumeSnapshotChatSessionId: 'chat-1',
      },
    });
    const { rc } = makeContext();

    await handleAgentSession(state, rc);

    expect(createAcpSessionMock).toHaveBeenCalledTimes(2);
    expect(prepareAcpSessionForFreshStartMock).toHaveBeenCalledWith(
      rc.env,
      'project-1',
      'agent-session-new',
      expect.objectContaining({
        workspaceId: 'workspace-1',
        nodeId: 'node-1',
      })
    );
    expect(transitionAcpSessionMock).toHaveBeenCalledWith(
      rc.env,
      'project-1',
      'agent-session-new',
      'running',
      expect.objectContaining({
        acpSdkSessionId: 'agent-session-new',
      })
    );
    expect(state.config.resumeSnapshotChatSessionId).toBeNull();
  });

  it('does not clear sleepingAt when ProjectData refuses the wake transition', async () => {
    wakeSessionMock.mockResolvedValueOnce(false);
    const state = makeState({
      config: {
        ...makeState().config,
        resumeSnapshotChatSessionId: 'chat-1',
      },
    });
    const { rc } = makeContext();

    await expect(handleAgentSession(state, rc)).rejects.toThrow(
      'Strict session restore succeeded but lifecycle recovery commit failed'
    );

    expect(completeSessionSnapshotRecoveryMock).not.toHaveBeenCalled();
  });
});
