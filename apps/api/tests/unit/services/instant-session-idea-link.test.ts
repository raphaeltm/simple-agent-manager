/**
 * The Instant seam: `acceptInstantSession` records the session → idea link before it
 * returns, which is before `continueInstantSessionLaunch` gives the agent its first
 * prompt. Both Instant entry points — `POST /sessions/start` and `/tasks/submit`'s
 * Instant branch — go through this one function, so covering it covers both.
 *
 * Only T1's `recordLink` is stubbed; the real `recordWorkStartIdeaLink` and the real
 * `acceptInstantSession` run, so the relation and the ordering are the production ones
 * (rule 62).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as string[]);
const mocks = vi.hoisted(() => ({
  recordLink: vi.fn(),
  jwt: {
    signCallbackToken: vi.fn(),
    signNodeCallbackToken: vi.fn(),
    signTerminalToken: vi.fn(),
  },
  nodeAgent: {
    createAgentSessionOnNode: vi.fn(),
    createWorkspaceOnNode: vi.fn(),
    fetchNodeAgent: vi.fn(),
    getCfContainerCreateWorkspaceTimeoutMs: vi.fn(),
    startAgentSessionOnNode: vi.fn(),
    waitForNodeAgentReady: vi.fn(),
  },
  nodes: { createNodeRecord: vi.fn() },
  projectData: {
    createAcpSession: vi.fn(),
    createSession: vi.fn(),
    getAcpSession: vi.fn(),
    persistMessage: vi.fn(),
    transitionAcpSession: vi.fn(),
    failSession: vi.fn(),
  },
  container: {
    destroyVmAgentContainer: vi.fn(),
    getVmAgentContainerConfig: vi.fn(),
    launchVmAgentContainer: vi.fn(),
    requireVmAgentContainer: vi.fn(),
    runContainerPhase: vi.fn(),
  },
  ulid: vi.fn(),
  transitionTaskToTerminal: vi.fn(),
}));

vi.mock('../../../src/operations/link-core', () => ({ recordLink: mocks.recordLink }));
vi.mock('../../../src/services/jwt', () => mocks.jwt);
vi.mock('../../../src/services/node-agent', () => mocks.nodeAgent);
vi.mock('../../../src/services/nodes', () => mocks.nodes);
vi.mock('../../../src/services/project-data', () => mocks.projectData);
vi.mock('../../../src/services/vm-agent-container', () => mocks.container);
vi.mock('../../../src/lib/ulid', () => ({ ulid: mocks.ulid }));
vi.mock('../../../src/services/task-terminal-transition', () => ({
  transitionTaskToTerminal: mocks.transitionTaskToTerminal,
}));

import {
  acceptInstantSession,
  continueInstantSessionLaunch,
  type LaunchInstantSessionInput,
} from '../../../src/services/instant-session';

function makeDb() {
  return {
    insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve()) })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          get: vi.fn().mockResolvedValue(null),
          limit: vi.fn().mockResolvedValue([]),
        })),
      })),
    })),
  } as never;
}

const project = {
  id: 'project-1',
  repository: 'owner/repo',
  defaultBranch: 'main',
  installationId: 'installation-1',
} as never;

const env = {
  BASE_DOMAIN: 'example.com',
  KV: {},
  CF_CONTAINER_ENABLED: 'true',
  CF_CONTAINER_VM_AGENT_PORT: '8080',
} as never;

function launchInput(overrides: Record<string, unknown> = {}): LaunchInstantSessionInput {
  return {
    taskId: 'task-1',
    project,
    userId: 'user-1',
    initialPrompt: 'Match the 3-day window.',
    displayMessage: 'Match the 3-day window.',
    agentType: 'claude-code',
    ...overrides,
  } as never;
}

describe('acceptInstantSession records the idea link before the agent starts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    mocks.recordLink.mockImplementation(() => {
      calls.push('recordLink');
      return Promise.resolve();
    });
    mocks.ulid.mockReset().mockReturnValue('workspace-1');
    mocks.jwt.signNodeCallbackToken.mockResolvedValue('node-callback-token');
    mocks.jwt.signCallbackToken.mockResolvedValue('workspace-callback-token');
    mocks.jwt.signTerminalToken.mockResolvedValue({ token: 'terminal-token' });
    mocks.nodes.createNodeRecord.mockResolvedValue({ id: 'node-1' });
    mocks.nodeAgent.getCfContainerCreateWorkspaceTimeoutMs.mockReturnValue(120_000);
    mocks.nodeAgent.waitForNodeAgentReady.mockResolvedValue(undefined);
    mocks.nodeAgent.createWorkspaceOnNode.mockResolvedValue({});
    mocks.nodeAgent.createAgentSessionOnNode.mockResolvedValue({});
    mocks.nodeAgent.startAgentSessionOnNode.mockResolvedValue({});
    mocks.nodeAgent.fetchNodeAgent.mockResolvedValue(new Response('{}'));
    mocks.projectData.createSession.mockImplementation(() => {
      calls.push('createSession');
      return Promise.resolve('chat-session-1');
    });
    mocks.projectData.persistMessage.mockResolvedValue(undefined);
    mocks.projectData.createAcpSession.mockResolvedValue({ id: 'agent-session-1' });
    mocks.projectData.getAcpSession.mockResolvedValue(null);
    mocks.projectData.transitionAcpSession.mockResolvedValue({});
    mocks.projectData.failSession.mockResolvedValue(undefined);
    mocks.container.getVmAgentContainerConfig.mockReturnValue({
      vmAgentPort: 8080,
      enabled: true,
      sleepAfter: '10m',
    });
    mocks.container.launchVmAgentContainer.mockImplementation(() => {
      calls.push('launchVmAgentContainer');
      return Promise.resolve();
    });
    mocks.container.destroyVmAgentContainer.mockResolvedValue(undefined);
    mocks.container.runContainerPhase.mockImplementation(
      (_phase: unknown, _detail: unknown, fn: () => unknown) => fn()
    );
  });

  it('records works_on for a task-mode Instant start, after the session exists', async () => {
    await acceptInstantSession(
      makeDb(),
      env,
      launchInput({ sourceIdeaId: 'idea-1', taskMode: 'task' })
    );

    expect(mocks.recordLink).toHaveBeenCalledWith(env, 'project-1', {
      sourceKind: 'session',
      sourceId: 'chat-session-1',
      targetKind: 'idea',
      targetId: 'idea-1',
      relation: 'works_on',
      origin: 'explicit',
      context: null,
    });
    expect(calls).toEqual(['createSession', 'recordLink']);
  });

  it('records discusses for a conversation-mode Instant start', async () => {
    await acceptInstantSession(
      makeDb(),
      env,
      launchInput({ sourceIdeaId: 'idea-1', taskMode: 'conversation' })
    );
    expect(mocks.recordLink.mock.calls[0]?.[2]).toMatchObject({ relation: 'discusses' });
  });

  it('defaults to discusses when the caller sets no task mode (chat-start)', async () => {
    await acceptInstantSession(makeDb(), env, launchInput({ sourceIdeaId: 'idea-1' }));
    expect(mocks.recordLink.mock.calls[0]?.[2]).toMatchObject({ relation: 'discusses' });
  });

  // The ordering requirement: the link is in place before the container that runs the
  // agent is ever launched.
  it('links before the launch that gives the agent its first prompt', async () => {
    const input = launchInput({ sourceIdeaId: 'idea-1', taskMode: 'task' });
    const accepted = await acceptInstantSession(makeDb(), env, input);
    // Liveness beside the ordering assertion: without it, "recordLink came first" is
    // also satisfied by recordLink never being called at all.
    expect(calls).toContain('recordLink');
    expect(calls).not.toContain('launchVmAgentContainer');

    await continueInstantSessionLaunch(makeDb(), env, input, accepted).catch(() => undefined);
    expect(calls).toContain('launchVmAgentContainer');
    expect(calls.indexOf('recordLink')).toBeLessThan(calls.indexOf('launchVmAgentContainer'));
  });

  // Control: without this, the suite would pass with the link write deleted outright.
  it('records nothing when the start did not come from an idea', async () => {
    await acceptInstantSession(makeDb(), env, launchInput());
    expect(mocks.recordLink).not.toHaveBeenCalled();
    expect(calls).toEqual(['createSession']);
  });

  it('fails acceptance when the link cannot be written, before any container launch', async () => {
    mocks.recordLink.mockImplementation(() => Promise.reject(new Error('DO unavailable')));
    await expect(
      acceptInstantSession(makeDb(), env, launchInput({ sourceIdeaId: 'idea-1', taskMode: 'task' }))
    ).rejects.toThrow(/Could not link this chat to the idea/);
    expect(mocks.container.launchVmAgentContainer).not.toHaveBeenCalled();
  });
});
