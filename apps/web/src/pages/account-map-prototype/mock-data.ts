/**
 * PROTOTYPE mock data for /prototype/account-map. Never merge to main.
 *
 * Shapes follow `AccountMapResponse` (apps/web/src/lib/api/projects.ts), enriched with the
 * fields a production version would derive: cost per hour, metrics, attention reasons and
 * linked pull requests.
 */

export type MachineState = 'running' | 'warm' | 'starting' | 'unhealthy';
export type WorkState = 'working' | 'needs-you' | 'idle' | 'sleeping' | 'failed' | 'done';

export interface MockProject {
  id: string;
  name: string;
  repo: string;
  lastActive: string;
  openIdeas: number;
  doneToday: number;
}

export interface MockMachine {
  id: string;
  name: string;
  provider: 'Hetzner' | 'GCP' | 'Scaleway' | 'Cloudflare';
  size: string;
  location: string;
  state: MachineState;
  cpu: number;
  memory: number;
  disk: number;
  costPerHour: number;
  uptime: string;
  /** One sentence about the machine's situation, when there is one. */
  note?: string;
  /** True for Instant (Cloudflare container) capacity, which is not a VM the user pays for by the hour. */
  instant?: boolean;
}

export interface MockWorkspace {
  id: string;
  machineId: string;
  projectId: string;
  branch: string;
  state: 'running' | 'stopped' | 'starting';
}

export interface MockWork {
  id: string;
  projectId: string;
  workspaceId: string | null;
  kind: 'chat' | 'task';
  title: string;
  agent: string;
  state: WorkState;
  since: string;
  idea?: string;
  pr?: { number: number; state: 'checks running' | 'checks failing' | 'ready to merge' | 'merged' };
}

export type AttentionKind = 'question' | 'failed' | 'machine' | 'cost' | 'review';

export interface MockAttention {
  id: string;
  kind: AttentionKind;
  title: string;
  detail: string;
  age: string;
  action: string;
  /** Ids of the work, workspace, machine and project this item is about. */
  workId?: string;
  workspaceId?: string;
  machineId?: string;
  projectId?: string;
}

export interface MockScene {
  projects: MockProject[];
  quietProjectCount: number;
  machines: MockMachine[];
  workspaces: MockWorkspace[];
  work: MockWork[];
  attention: MockAttention[];
  today: { agentHours: number; tasksDone: number; prsOpened: number; spend: number };
}

const projects: MockProject[] = [
  { id: 'p-sam', name: 'SAM', repo: 'raphaeltm/simple-agent-manager', lastActive: 'now', openIdeas: 41, doneToday: 9 },
  { id: 'p-ttv', name: 'TTV', repo: 'raphaeltm/ttv', lastActive: '54m', openIdeas: 6, doneToday: 2 },
  { id: 'p-rtm', name: 'RaphaelTM', repo: 'raphaeltm/raphaeltm.com', lastActive: '1h', openIdeas: 3, doneToday: 1 },
  {
    id: 'p-biere',
    name: 'BiereCode Games — multiplayer prototype with the extremely long project name',
    repo: 'biercode/games-multiplayer-prototype-with-a-very-long-repository-name',
    lastActive: '2h',
    openIdeas: 0,
    doneToday: 0,
  },
];

const machines: MockMachine[] = [
  {
    id: 'm-fsn1',
    name: 'sam-fsn1-01',
    provider: 'Hetzner',
    size: '8 vCPU · 16 GB',
    location: 'Falkenstein',
    state: 'running',
    cpu: 62,
    memory: 71,
    disk: 48,
    costPerHour: 0.03,
    uptime: '3h 12m',
  },
  {
    id: 'm-gcp',
    name: 'sam-gcp-euw4-02',
    provider: 'GCP',
    size: '4 vCPU · 16 GB',
    location: 'Netherlands',
    state: 'running',
    cpu: 18,
    memory: 44,
    disk: 84,
    costPerHour: 0.19,
    uptime: '1d 4h',
    note: 'Disk is 84% full, so SAM won’t start new work here.',
  },
  {
    id: 'm-nbg1',
    name: 'sam-nbg1-03',
    provider: 'Hetzner',
    size: '4 vCPU · 8 GB',
    location: 'Nuremberg',
    state: 'warm',
    cpu: 1,
    memory: 9,
    disk: 22,
    costPerHour: 0.015,
    uptime: '52m',
    note: 'Nothing running. Kept warm for fast starts; shuts down in 18 min.',
  },
  {
    id: 'm-hel1',
    name: 'sam-hel1-04',
    provider: 'Hetzner',
    size: '2 vCPU · 4 GB',
    location: 'Helsinki',
    state: 'unhealthy',
    cpu: 0,
    memory: 0,
    disk: 0,
    costPerHour: 0.008,
    uptime: '6h 40m',
    note: 'No heartbeat for 6 min. Its chat may be stuck.',
  },
  {
    id: 'm-instant',
    name: 'Instant',
    provider: 'Cloudflare',
    size: 'Containers',
    location: 'Edge',
    state: 'running',
    cpu: 0,
    memory: 0,
    disk: 0,
    costPerHour: 0,
    uptime: '—',
    instant: true,
  },
];

const workspaces: MockWorkspace[] = [
  { id: 'w-1', machineId: 'm-fsn1', projectId: 'p-sam', branch: 'sam/wake-progress-banner', state: 'running' },
  { id: 'w-2', machineId: 'm-fsn1', projectId: 'p-sam', branch: 'sam/account-map-screen-kinda-g64d06', state: 'running' },
  { id: 'w-3', machineId: 'm-fsn1', projectId: 'p-ttv', branch: 'feature/subtitle-timing', state: 'running' },
  { id: 'w-4', machineId: 'm-gcp', projectId: 'p-sam', branch: 'sam/provider-priority-gcp-first', state: 'running' },
  { id: 'w-5', machineId: 'm-hel1', projectId: 'p-biere', branch: 'fix/lobby-websocket-reconnect-after-sleep-on-mobile-safari', state: 'running' },
  { id: 'w-6', machineId: 'm-instant', projectId: 'p-rtm', branch: 'main', state: 'running' },
];

const work: MockWork[] = [
  {
    id: 'c-1',
    projectId: 'p-sam',
    workspaceId: 'w-1',
    kind: 'task',
    title: 'Show wake progress phases in the chat banner',
    agent: 'Claude Code',
    state: 'needs-you',
    since: '4m',
    idea: 'Wake progress you can see',
    pr: { number: 2541, state: 'checks running' },
  },
  {
    id: 'c-2',
    projectId: 'p-sam',
    workspaceId: 'w-2',
    kind: 'chat',
    title: 'Account map prototypes',
    agent: 'Claude Code',
    state: 'working',
    since: '12m',
  },
  {
    id: 'c-3',
    projectId: 'p-ttv',
    workspaceId: 'w-3',
    kind: 'task',
    title: 'Fix subtitle drift after 40 minutes of playback',
    agent: 'Codex',
    state: 'working',
    since: '31m',
    pr: { number: 88, state: 'checks failing' },
  },
  {
    id: 'c-4',
    projectId: 'p-sam',
    workspaceId: 'w-4',
    kind: 'task',
    title: 'Use GCP first, Hetzner when GCP has no room',
    agent: 'Codex',
    state: 'working',
    since: '1h',
    idea: 'Provider priority',
  },
  {
    id: 'c-5',
    projectId: 'p-biere',
    workspaceId: 'w-5',
    kind: 'chat',
    title: 'Lobby drops players when Safari sleeps the tab and the websocket never reconnects afterwards',
    agent: 'OpenCode',
    state: 'idle',
    since: '6m',
  },
  {
    id: 'c-6',
    projectId: 'p-rtm',
    workspaceId: 'w-6',
    kind: 'chat',
    title: 'Blog post: what my agents shipped this week',
    agent: 'Claude Code',
    state: 'needs-you',
    since: '22m',
  },
  {
    id: 'c-7',
    projectId: 'p-sam',
    workspaceId: null,
    kind: 'task',
    title: 'Retire stale deployment nodes automatically',
    agent: 'Codex',
    state: 'failed',
    since: '38m',
    idea: 'Self-cleaning infrastructure',
  },
  {
    id: 'c-8',
    projectId: 'p-sam',
    workspaceId: null,
    kind: 'task',
    title: 'Steer/queue chip in the Interrupt row',
    agent: 'Claude Code',
    state: 'done',
    since: '2h',
    pr: { number: 2543, state: 'merged' },
  },
  {
    id: 'c-9',
    projectId: 'p-ttv',
    workspaceId: null,
    kind: 'chat',
    title: 'Pick a voice for the trailer',
    agent: 'Claude Code',
    state: 'sleeping',
    since: '3h',
  },
];

const attention: MockAttention[] = [
  {
    id: 'a-1',
    kind: 'question',
    title: 'Claude Code is asking you something',
    detail: '“Should the banner hide once the agent is awake, or stay for 3 seconds?”',
    age: '4m',
    action: 'Answer',
    workId: 'c-1',
    workspaceId: 'w-1',
    machineId: 'm-fsn1',
    projectId: 'p-sam',
  },
  {
    id: 'a-2',
    kind: 'question',
    title: 'Draft is ready for your review',
    detail: 'Blog post: what my agents shipped this week',
    age: '22m',
    action: 'Open chat',
    workId: 'c-6',
    workspaceId: 'w-6',
    machineId: 'm-instant',
    projectId: 'p-rtm',
  },
  {
    id: 'a-3',
    kind: 'machine',
    title: 'sam-hel1-04 stopped responding',
    detail: 'No heartbeat for 6 min. 1 chat runs on it.',
    age: '6m',
    action: 'Look at it',
    workId: 'c-5',
    workspaceId: 'w-5',
    machineId: 'm-hel1',
    projectId: 'p-biere',
  },
  {
    id: 'a-4',
    kind: 'failed',
    title: 'Task failed',
    detail: 'Retire stale deployment nodes automatically — tests timed out',
    age: '38m',
    action: 'See why',
    workId: 'c-7',
    projectId: 'p-sam',
  },
  {
    id: 'a-5',
    kind: 'review',
    title: 'PR #88 checks are failing',
    detail: 'Fix subtitle drift after 40 minutes of playback',
    age: '9m',
    action: 'Open PR',
    workId: 'c-3',
    workspaceId: 'w-3',
    machineId: 'm-fsn1',
    projectId: 'p-ttv',
  },
];

export const NORMAL_SCENE: MockScene = {
  projects,
  quietProjectCount: 34,
  machines,
  workspaces,
  work,
  attention,
  today: { agentHours: 14.5, tasksDone: 12, prsOpened: 7, spend: 2.41 },
};

const BUSY_NAMES = ['api', 'web', 'cli', 'docs', 'infra', 'mobile', 'design', 'billing'];

/** Index into a fixed list, wrapping around. */
function pick<T>(list: readonly T[], i: number): T {
  return list[i % list.length] as T;
}

/** Twelve machines, thirty chats: where cards wrap, lists scroll and lines cross. */
export const BUSY_SCENE: MockScene = (() => {
  const busyProjects: MockProject[] = [
    ...projects,
    ...BUSY_NAMES.map((name, i) => ({
      id: `p-busy-${i}`,
      name: `acme-${name}`,
      repo: `acme/${name}`,
      lastActive: `${i + 2}h`,
      openIdeas: i * 3,
      doneToday: i % 3,
    })),
  ];
  const busyMachines: MockMachine[] = [
    ...machines,
    ...Array.from({ length: 7 }, (_, i) => ({
      id: `m-busy-${i}`,
      name: `acme-${pick(['fsn1', 'nbg1', 'hel1', 'ash'], i)}-${10 + i}`,
      provider: pick(['Hetzner', 'Scaleway', 'GCP'] as const, i),
      size: pick(['8 vCPU · 16 GB', '4 vCPU · 8 GB', '16 vCPU · 32 GB'], i),
      location: pick(['Falkenstein', 'Paris', 'Iowa'], i),
      state: 'running' as const,
      cpu: (i * 23) % 97,
      memory: (i * 31) % 90,
      disk: (i * 17) % 70,
      costPerHour: 0.02 + i * 0.01,
      uptime: `${i + 1}h`,
    })),
  ];
  const busyWorkspaces: MockWorkspace[] = [
    ...workspaces,
    ...Array.from({ length: 18 }, (_, i) => ({
      id: `w-busy-${i}`,
      machineId: `m-busy-${i % 7}`,
      projectId: `p-busy-${i % BUSY_NAMES.length}`,
      branch: `sam/${pick(BUSY_NAMES, i)}-change-${i}`,
      state: 'running' as const,
    })),
  ];
  const busyWork: MockWork[] = [
    ...work,
    ...busyWorkspaces.slice(workspaces.length).map((ws, i) => ({
      id: `c-busy-${i}`,
      projectId: ws.projectId,
      workspaceId: ws.id,
      kind: (i % 2 ? 'chat' : 'task') as MockWork['kind'],
      title: `Refactor the ${pick(BUSY_NAMES, i)} module, part ${i + 1}`,
      agent: pick(['Claude Code', 'Codex', 'OpenCode'], i),
      state: pick(['working', 'working', 'idle', 'needs-you'] as const, i),
      since: `${i + 3}m`,
    })),
  ];
  return {
    projects: busyProjects,
    quietProjectCount: 112,
    machines: busyMachines,
    workspaces: busyWorkspaces,
    work: busyWork,
    attention: [
      ...attention,
      ...busyWork
        .filter((w) => w.id.startsWith('c-busy') && w.state === 'needs-you')
        .map((w) => ({
          id: `a-${w.id}`,
          kind: 'question' as const,
          title: 'An agent is asking you something',
          detail: w.title,
          age: w.since,
          action: 'Answer',
          workId: w.id,
          workspaceId: w.workspaceId ?? undefined,
          machineId: busyWorkspaces.find((ws) => ws.id === w.workspaceId)?.machineId,
          projectId: w.projectId,
        })),
    ],
    today: { agentHours: 61, tasksDone: 48, prsOpened: 22, spend: 9.12 },
  };
})();

/** A new account: nothing running, nothing waiting. */
export const EMPTY_SCENE: MockScene = {
  projects: projects.slice(0, 1),
  quietProjectCount: 0,
  machines: [],
  workspaces: [],
  work: [],
  attention: [],
  today: { agentHours: 0, tasksDone: 0, prsOpened: 0, spend: 0 },
};

export const SCENES = { normal: NORMAL_SCENE, busy: BUSY_SCENE, empty: EMPTY_SCENE } as const;
export type SceneKey = keyof typeof SCENES;
