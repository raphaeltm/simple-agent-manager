/**
 * Capability tests for the TrialOrchestrator's discovery_agent_start step and
 * the `fetchDefaultBranch` GitHub probe used during project_creation.
 *
 * These assert the class-of-bug regressions described in
 * tasks/active/2026-04-19-trial-orchestrator-actually-start-agent.md:
 *
 *   1. handleDiscoveryAgentStart previously only created ACP session rows and
 *      never told the VM agent to actually launch the subprocess. The ACP
 *      session sat in `pending` forever, so `trial.ready` never fired.
 *   2. The orchestrator hardcoded `'main'` for both projects.default_branch
 *      and the workspace's `git clone --branch`, breaking trials on
 *      master-default repos (e.g. octocat/Hello-World).
 *
 * The tests mock the cross-boundary calls (node-agent HTTP, MCP token KV,
 * ProjectData DO transitions, GitHub API) and assert the payloads + the
 * idempotency flags.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { startDiscoveryAgentMock, resolveTrialRunnerConfigMock, emitTrialEventMock } = vi.hoisted(
  () => ({
    startDiscoveryAgentMock: vi.fn(),
    resolveTrialRunnerConfigMock: vi.fn(() => ({
      mode: 'staging' as const,
      agentType: 'opencode',
      model: '@cf/meta/llama-4-scout-17b-16e-instruct',
      provider: 'workers-ai' as const,
    })),
    emitTrialEventMock: vi.fn(async () => {}),
  }),
);
vi.mock('../../../src/services/trial/trial-runner', () => ({
  emitTrialEvent: emitTrialEventMock,
  emitTrialEventForProject: vi.fn(async () => {}),
  startDiscoveryAgent: startDiscoveryAgentMock,
  resolveTrialRunnerConfig: resolveTrialRunnerConfigMock,
}));

vi.mock('../../../src/services/trial/trial-store', () => ({
  readTrial: vi.fn(async () => null),
  readTrialByProject: vi.fn(async () => null),
  writeTrial: vi.fn(async () => {}),
}));

const { linkSessionToWorkspaceMock, transitionAcpSessionMock } = vi.hoisted(() => ({
  linkSessionToWorkspaceMock: vi.fn(async () => {}),
  transitionAcpSessionMock: vi.fn(async () => {}),
}));
vi.mock('../../../src/services/project-data', () => ({
  linkSessionToWorkspace: linkSessionToWorkspaceMock,
  transitionAcpSession: transitionAcpSessionMock,
}));

const { createAgentSessionOnNodeMock, startAgentSessionOnNodeMock, createWorkspaceOnNodeMock } =
  vi.hoisted(() => ({
    createAgentSessionOnNodeMock: vi.fn(async () => {}),
    startAgentSessionOnNodeMock: vi.fn(async () => {}),
    createWorkspaceOnNodeMock: vi.fn(async () => {}),
  }));
vi.mock('../../../src/services/node-agent', () => ({
  createAgentSessionOnNode: createAgentSessionOnNodeMock,
  startAgentSessionOnNode: startAgentSessionOnNodeMock,
  createWorkspaceOnNode: createWorkspaceOnNodeMock,
}));

const { generateMcpTokenMock, storeMcpTokenMock } = vi.hoisted(() => ({
  generateMcpTokenMock: vi.fn(() => 'mcp_tok_fixture_abc123'),
  storeMcpTokenMock: vi.fn(async () => {}),
}));
vi.mock('../../../src/services/mcp-token', () => ({
  generateMcpToken: generateMcpTokenMock,
  storeMcpToken: storeMcpTokenMock,
}));

const { handleDiscoveryAgentStart, handleProjectCreation } = await import(
  '../../../src/durable-objects/trial-orchestrator/steps'
);

type Storage = Map<string, unknown>;

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    trialId: 'trial_boot_test',
    repoUrl: 'https://github.com/octocat/Hello-World',
    repoOwner: 'octocat',
    repoName: 'Hello-World',
    currentStep: 'discovery_agent_start',
    projectId: 'proj_X',
    nodeId: 'node_X',
    autoProvisionedNode: false,
    workspaceId: 'ws_X',
    chatSessionId: null,
    acpSessionId: null,
    defaultBranch: null,
    mcpToken: null,
    agentSessionCreatedOnVm: false,
    agentStartedOnVm: false,
    acpAssignedOnVm: false,
    acpRunningOnVm: false,
    retryCount: 0,
    createdAt: Date.now(),
    lastStepAt: Date.now(),
    nodeAgentReadyStartedAt: null,
    workspaceReadyStartedAt: null,
    completed: false,
    failureReason: null,
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeCtx(storage: Storage = new Map()) {
  return {
    storage: {
      get: vi.fn(async (k: string) => storage.get(k)),
      put: vi.fn(async (k: string, v: unknown) => {
        storage.set(k, v);
      }),
    },
    _storage: storage,
  };
}

function makeRc(ctx: ReturnType<typeof makeCtx>, advanced: string[]) {
  return {
    env: {
      BASE_DOMAIN: 'sammy.party',
      KV: { put: vi.fn(async () => {}) },
      DATABASE: {
        prepare: vi.fn(() => ({
          bind: vi.fn(() => ({ run: vi.fn(async () => {}) })),
        })),
      },
      TRIAL_ANONYMOUS_USER_ID: 'u_anon_trial',
    } as unknown as Parameters<typeof handleDiscoveryAgentStart>[1]['env'],
    ctx: ctx as unknown as Parameters<typeof handleDiscoveryAgentStart>[1]['ctx'],
    advanceToStep: vi.fn(async (state, step: string) => {
      advanced.push(step);
      state.currentStep = step;
      state.lastStepAt = Date.now();
      await ctx.storage.put('state', state);
    }),
    getAgentReadyTimeoutMs: () => 60_000,
    getWorkspaceReadyTimeoutMs: () => 180_000,
    getWorkspaceReadyPollIntervalMs: () => 5_000,
    getNodeReadyTimeoutMs: () => 180_000,
    getHeartbeatSkewMs: () => 30_000,
  } as unknown as Parameters<typeof handleDiscoveryAgentStart>[1];
}

describe('handleDiscoveryAgentStart — VM agent boot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    startDiscoveryAgentMock.mockResolvedValue({
      chatSessionId: 'cs_new',
      acpSessionId: 'acp_new',
      agentType: 'opencode',
      model: '@cf/meta/llama-4-scout-17b-16e-instruct',
      provider: 'workers-ai' as const,
      promptVersion: 'v1',
    });
  });

  it('calls createAgentSessionOnNode with the correct payload after startDiscoveryAgent', async () => {
    const ctx = makeCtx();
    const rc = makeRc(ctx, []);
    const state = makeState();

    await handleDiscoveryAgentStart(state, rc);

    expect(startDiscoveryAgentMock).toHaveBeenCalledTimes(1);
    expect(createAgentSessionOnNodeMock).toHaveBeenCalledTimes(1);
    const [nodeId, workspaceId, acpSessionId, label, , userId, chatSessionId, projectId] =
      createAgentSessionOnNodeMock.mock.calls[0];
    expect(nodeId).toBe('node_X');
    expect(workspaceId).toBe('ws_X');
    expect(acpSessionId).toBe('acp_new');
    expect(label).toContain('octocat/Hello-World');
    expect(userId).toBe('u_anon_trial');
    expect(chatSessionId).toBe('cs_new');
    expect(projectId).toBe('proj_X');

    expect(state.agentSessionCreatedOnVm).toBe(true);
  });

  it('mints + stores an MCP token keyed on trialId (synthetic taskId)', async () => {
    const ctx = makeCtx();
    const rc = makeRc(ctx, []);
    const state = makeState();

    await handleDiscoveryAgentStart(state, rc);

    expect(generateMcpTokenMock).toHaveBeenCalledTimes(1);
    expect(storeMcpTokenMock).toHaveBeenCalledTimes(1);
    const [, token, data] = storeMcpTokenMock.mock.calls[0];
    expect(token).toBe('mcp_tok_fixture_abc123');
    // Trial synthetic taskId = trialId.
    expect((data as { taskId: string }).taskId).toBe(state.trialId);
    expect((data as { projectId: string }).projectId).toBe('proj_X');
    expect((data as { workspaceId: string }).workspaceId).toBe('ws_X');

    expect(state.mcpToken).toBe('mcp_tok_fixture_abc123');
  });

  it('calls startAgentSessionOnNode with the discovery prompt + MCP server URL', async () => {
    const ctx = makeCtx();
    const rc = makeRc(ctx, []);
    const state = makeState();

    await handleDiscoveryAgentStart(state, rc);

    expect(startAgentSessionOnNodeMock).toHaveBeenCalledTimes(1);
    const [nodeId, workspaceId, acpSessionId, agentType, initialPrompt, , userId, mcpServer] =
      startAgentSessionOnNodeMock.mock.calls[0];
    expect(nodeId).toBe('node_X');
    expect(workspaceId).toBe('ws_X');
    expect(acpSessionId).toBe('acp_new');
    expect(agentType).toBe('opencode');
    expect(typeof initialPrompt).toBe('string');
    expect(initialPrompt as string).toContain('octocat/Hello-World');
    expect(userId).toBe('u_anon_trial');
    expect(mcpServer).toEqual({
      url: 'https://api.sammy.party/mcp',
      token: 'mcp_tok_fixture_abc123',
    });

    expect(state.agentStartedOnVm).toBe(true);
  });

  it('drives the ACP session pending → assigned → running → advances to running', async () => {
    const ctx = makeCtx();
    const advanced: string[] = [];
    const rc = makeRc(ctx, advanced);
    const state = makeState();

    await handleDiscoveryAgentStart(state, rc);

    // Two transitions in order: assigned, then running. Both from the
    // orchestrator (actorType: system).
    expect(transitionAcpSessionMock).toHaveBeenCalledTimes(2);
    expect(transitionAcpSessionMock.mock.calls[0][3]).toBe('assigned');
    expect(transitionAcpSessionMock.mock.calls[1][3]).toBe('running');
    expect(transitionAcpSessionMock.mock.calls[0][4]).toMatchObject({ actorType: 'system' });

    expect(state.acpAssignedOnVm).toBe(true);
    expect(state.acpRunningOnVm).toBe(true);

    // Finally, the step advances the orchestrator FSM to the `running` step
    // (terminal) so no further alarms fire.
    expect(advanced).toEqual(['running']);
  });

  it('is idempotent across crash-and-retry — re-entering with flags set does not re-call VM', async () => {
    const ctx = makeCtx();
    const advanced: string[] = [];
    const rc = makeRc(ctx, advanced);
    // Simulate a crash after every idempotency flag has already been set.
    const state = makeState({
      chatSessionId: 'cs_persist',
      acpSessionId: 'acp_persist',
      mcpToken: 'mcp_tok_persist',
      agentSessionCreatedOnVm: true,
      agentStartedOnVm: true,
      acpAssignedOnVm: true,
      acpRunningOnVm: true,
    });

    await handleDiscoveryAgentStart(state, rc);

    // None of the side-effectful cross-boundary calls should fire again.
    expect(startDiscoveryAgentMock).not.toHaveBeenCalled();
    expect(createAgentSessionOnNodeMock).not.toHaveBeenCalled();
    expect(generateMcpTokenMock).not.toHaveBeenCalled();
    expect(storeMcpTokenMock).not.toHaveBeenCalled();
    expect(startAgentSessionOnNodeMock).not.toHaveBeenCalled();
    expect(transitionAcpSessionMock).not.toHaveBeenCalled();

    // But the state machine MUST still advance to `running` so the alarm loop
    // doesn't re-fire the step forever.
    expect(advanced).toEqual(['running']);
  });

  it('re-entering after a partial crash (mcpToken set but subprocess not started) resumes from step 4', async () => {
    const ctx = makeCtx();
    const advanced: string[] = [];
    const rc = makeRc(ctx, advanced);
    const state = makeState({
      chatSessionId: 'cs_partial',
      acpSessionId: 'acp_partial',
      agentSessionCreatedOnVm: true,
      mcpToken: 'mcp_tok_partial',
      agentStartedOnVm: false, // crashed before step 4
      acpAssignedOnVm: false,
      acpRunningOnVm: false,
    });

    await handleDiscoveryAgentStart(state, rc);

    // Steps 1–3 must NOT fire again.
    expect(startDiscoveryAgentMock).not.toHaveBeenCalled();
    expect(createAgentSessionOnNodeMock).not.toHaveBeenCalled();
    expect(generateMcpTokenMock).not.toHaveBeenCalled();

    // Steps 4–5 MUST fire to complete the flow.
    expect(startAgentSessionOnNodeMock).toHaveBeenCalledTimes(1);
    expect(transitionAcpSessionMock).toHaveBeenCalledTimes(2);
    // MCP token passed to startAgentSessionOnNode is the persisted one, not a fresh mint.
    const startArgs = startAgentSessionOnNodeMock.mock.calls[0];
    expect(startArgs[7]).toMatchObject({ token: 'mcp_tok_partial' });

    expect(advanced).toEqual(['running']);
  });
});

describe('handleProjectCreation — default branch detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses GitHub API default_branch (master) when the probe succeeds', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ default_branch: 'master' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const ctx = makeCtx();
    const advanced: string[] = [];
    const rc = makeRc(ctx, advanced);
    const state = makeState({
      currentStep: 'project_creation',
      projectId: null,
      workspaceId: null,
      nodeId: null,
      defaultBranch: null,
    });

    await handleProjectCreation(state, rc);

    expect(state.defaultBranch).toBe('master');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // Request targets the canonical GitHub public repos endpoint.
    const req = fetchSpy.mock.calls[0][0];
    const url = typeof req === 'string' ? req : (req as Request | URL).toString();
    expect(url).toContain('api.github.com/repos/octocat/Hello-World');

    fetchSpy.mockRestore();
  });

  it('falls back to "main" when the probe fails (network error)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('network down'));

    const ctx = makeCtx();
    const advanced: string[] = [];
    const rc = makeRc(ctx, advanced);
    const state = makeState({
      currentStep: 'project_creation',
      projectId: null,
      workspaceId: null,
      nodeId: null,
      defaultBranch: null,
    });

    await handleProjectCreation(state, rc);

    expect(state.defaultBranch).toBe('main');
    fetchSpy.mockRestore();
  });

  it('falls back to "main" when GitHub returns 404', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Not Found', { status: 404 }),
    );

    const ctx = makeCtx();
    const advanced: string[] = [];
    const rc = makeRc(ctx, advanced);
    const state = makeState({
      currentStep: 'project_creation',
      projectId: null,
      workspaceId: null,
      nodeId: null,
      defaultBranch: null,
    });

    await handleProjectCreation(state, rc);

    expect(state.defaultBranch).toBe('main');
    fetchSpy.mockRestore();
  });

  it('skips the probe when state.defaultBranch is already set (idempotent re-entry)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const ctx = makeCtx();
    const advanced: string[] = [];
    const rc = makeRc(ctx, advanced);
    const state = makeState({
      currentStep: 'project_creation',
      projectId: null,
      workspaceId: null,
      nodeId: null,
      defaultBranch: 'trunk',
    });

    await handleProjectCreation(state, rc);

    expect(state.defaultBranch).toBe('trunk');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
