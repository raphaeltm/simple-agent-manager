/**
 * A small but varied account for the Account Map tests: two busy projects and a quiet one, a
 * healthy machine shared by both projects, an unresponsive machine, an empty machine, an Instant
 * workspace, and chats in every state (waiting on you, working, idle, asleep, failed).
 */
import type { AccountMapResponse } from '../../../../src/lib/api';

export function accountMapFixture(overrides: Partial<AccountMapResponse> = {}): AccountMapResponse {
  const node = (
    id: string,
    name: string,
    extra: Partial<AccountMapResponse['nodes'][number]> = {}
  ) => ({
    id,
    name,
    status: 'running',
    vmSize: 'cx43',
    vmLocation: 'fsn1',
    cloudProvider: 'hetzner',
    ipAddress: null,
    healthStatus: 'healthy',
    lastHeartbeatAt: null,
    lastMetrics: null,
    ...extra,
  });
  const workspace = (
    id: string,
    nodeId: string | null,
    projectId: string,
    branch: string,
    chatSessionId: string | null = null
  ) => ({
    id,
    nodeId,
    projectId,
    displayName: null,
    branch,
    status: 'running',
    vmSize: null,
    chatSessionId,
  });
  const session = (
    id: string,
    projectId: string,
    extra: Partial<AccountMapResponse['sessions'][number]> = {}
  ) => ({
    id,
    projectId,
    topic: `Chat ${id}`,
    status: 'active',
    messageCount: 3,
    workspaceId: null,
    taskId: null,
    attention: null,
    ...extra,
  });
  const task = (
    id: string,
    projectId: string,
    extra: Partial<AccountMapResponse['tasks'][number]> = {}
  ) => ({
    id,
    projectId,
    workspaceId: null,
    title: `Task ${id}`,
    status: 'in_progress',
    executionStep: 'agent_session',
    priority: 0,
    agentActivityState: 'working' as const,
    outputPrUrl: null,
    ...extra,
  });

  return {
    projects: [
      {
        id: 'p-sam',
        name: 'SAM',
        repository: 'raphaeltm/simple-agent-manager',
        status: 'active',
        lastActivityAt: null,
        activeSessionCount: 3,
      },
      {
        id: 'p-ttv',
        name: 'TTV',
        repository: 'raphaeltm/ttv',
        status: 'active',
        lastActivityAt: null,
        activeSessionCount: 1,
      },
      {
        id: 'p-quiet',
        name: 'Quiet project',
        repository: null,
        status: 'active',
        lastActivityAt: null,
        activeSessionCount: 0,
      },
    ],
    nodes: [
      node('n-1', 'sam-fsn1-01'),
      node('n-2', 'sam-hel1-02', { healthStatus: 'unhealthy', vmLocation: 'hel1' }),
      node('n-3', 'sam-nbg1-03', { vmLocation: 'nbg1' }),
    ],
    workspaces: [
      workspace('w-1', 'n-1', 'p-sam', 'sam/wake-progress', 's-1'),
      workspace('w-2', 'n-1', 'p-ttv', 'feature/subtitle-timing'),
      workspace('w-3', 'n-2', 'p-sam', 'fix/lobby-reconnect', 's-3'),
      workspace('w-4', null, 'p-ttv', 'main', 's-2'),
    ],
    sessions: [
      session('s-1', 'p-sam', {
        taskId: 't-1',
        workspaceId: 'w-1',
        attention: { kind: 'needs_input', reason: 'Which branch should I use?', createdAt: 1 },
      }),
      session('s-2', 'p-ttv', { topic: 'Pick a voice for the trailer' }),
      session('s-3', 'p-sam', { topic: 'Lobby drops players' }),
      session('s-4', 'p-sam', { topic: 'Old idea chat', status: 'sleeping' }),
    ],
    tasks: [
      task('t-1', 'p-sam', {
        workspaceId: 'w-1',
        title: 'Show wake progress',
        outputPrUrl: 'https://github.com/o/r/pull/12',
      }),
      task('t-2', 'p-ttv', { workspaceId: 'w-2', title: 'Fix subtitle drift' }),
      task('t-3', 'p-sam', {
        title: 'Retire stale nodes',
        status: 'failed',
        agentActivityState: 'awake-idle',
      }),
    ],
    ideas: [{ id: 'i-1', projectId: 'p-sam', title: 'Wake progress you can see', status: 'draft' }],
    ideaScan: { projectLimit: 10, candidateLimit: 100 },
    truncation: {
      projects: false,
      linkProjects: false,
      ideas: false,
      sessions: false,
      links: false,
      nodes: false,
      workspaces: false,
      tasks: false,
      incomplete: false,
    },
    relationships: [
      { source: 'i-1', target: 's-1', type: 'idea_session', active: true, primary: true },
    ],
    ...overrides,
  };
}
