// PROTOTYPE ONLY — fake fleet for /prototype/nodes-glass. Delete with the prototype.
//
// Shapes follow the real wire types: machine hardware from NodeResponse
// (providerInstance*), reservations from ResolvedResourceReservation (cpuMillis,
// memoryMb, diskMb, exclusiveNode) and usage from the per-workspace cgroup samples
// (WorkspaceResourceSample: cpuMillis, memoryWorkingSetBytes). Numbers are made up but
// sized like production on 2026-11-04.

import type { PersonSlot } from '@simple-agent-manager/ui';

export type SessionState = 'working' | 'idle' | 'needs-you';
export type MachineState = 'running' | 'warm' | 'starting' | 'error';
export type AgentName = 'Claude Code' | 'Codex' | 'OpenCode';

export interface ProtoPerson {
  id: string;
  name: string;
  slot: PersonSlot;
}

export interface ProtoSession {
  id: string;
  title: string;
  project: string;
  owner: ProtoPerson;
  agent: AgentName;
  state: SessionState;
  startedMinutesAgo: number;
  workspaceId: string;
  reserved: { cpuMillis: number; memoryMb: number; diskMb: number; exclusiveNode?: boolean };
  used: { cpuMillis: number; memoryMb: number; diskMb: number };
  peakMemoryMb: number;
  /** 30 one-minute points, oldest first. */
  cpuSeries: number[];
  memorySeries: number[];
}

export interface ProtoMachine {
  id: string;
  provider: string;
  instanceType: string;
  location: string;
  vcpu: number;
  memoryMb: number;
  diskGb: number;
  hourlyEur: number;
  state: MachineState;
  /** Minutes until a warm machine is removed. */
  warmMinutesLeft?: number;
  errorMessage?: string;
  createdMinutesAgo: number;
  sessions: ProtoSession[];
}

export const YOU: ProtoPerson = { id: 'u-you', name: 'You', slot: 'you' };
export const JONAS: ProtoPerson = { id: 'u-jonas', name: 'Jonas Weber', slot: 1 };
export const MAYA: ProtoPerson = { id: 'u-maya', name: 'Maya', slot: 2 };
export const NIGHTLY: ProtoPerson = {
  id: 'u-auto',
  name: 'Weekly dependency refresh',
  slot: 'auto',
};

/** Deterministic wobble so every render and screenshot is identical. */
function series(seed: number, base: number, swing: number, end: number, ceiling: number): number[] {
  const points: number[] = [];
  let x = seed;
  for (let i = 0; i < 29; i++) {
    x = (x * 9301 + 49297) % 233280;
    const r = x / 233280;
    const trend = base + ((end - base) * i) / 29;
    points.push(Math.max(0, Math.min(ceiling, trend + (r - 0.5) * swing)));
  }
  points.push(end);
  return points;
}

function session(
  s: Omit<ProtoSession, 'cpuSeries' | 'memorySeries'> & {
    seed: number;
    cpuBase?: number;
    memBase?: number;
    cpuCeiling: number;
    memCeiling: number;
  }
): ProtoSession {
  const { seed, cpuBase, memBase, cpuCeiling, memCeiling, ...rest } = s;
  return {
    ...rest,
    cpuSeries: series(
      seed,
      cpuBase ?? rest.used.cpuMillis * 0.7,
      rest.used.cpuMillis * 0.9,
      rest.used.cpuMillis,
      cpuCeiling
    ),
    memorySeries: series(
      seed + 7,
      memBase ?? rest.used.memoryMb * 0.8,
      rest.used.memoryMb * 0.18,
      rest.used.memoryMb,
      memCeiling
    ),
  };
}

export const MACHINES: ProtoMachine[] = [
  {
    id: '01M6DNECGB77ECCZ4DZY936702',
    provider: 'Hetzner',
    instanceType: 'cx53',
    location: 'Falkenstein',
    vcpu: 16,
    memoryMb: 32768,
    diskGb: 320,
    hourlyEur: 0.0384,
    state: 'running',
    createdMinutesAgo: 192,
    sessions: [
      session({
        id: 's1',
        title: 'Nodes page redesign: new resource-usage prototypes',
        project: 'SAM',
        owner: YOU,
        agent: 'Claude Code',
        state: 'working',
        startedMinutesAgo: 24,
        workspaceId: '01M6KHMBW2079P619Z2K1QBGAE',
        reserved: { cpuMillis: 2000, memoryMb: 4096, diskMb: 10240 },
        used: { cpuMillis: 1320, memoryMb: 2950, diskMb: 4100 },
        peakMemoryMb: 3480,
        seed: 11,
        cpuCeiling: 16000,
        memCeiling: 32256,
      }),
      session({
        id: 's2',
        title:
          'Fix OOM eviction relocation when the chat is stopped before the snapshot is marked sleeping',
        project: 'SAM',
        owner: YOU,
        agent: 'Codex',
        state: 'working',
        startedMinutesAgo: 71,
        workspaceId: '01M6KF0Q4N2TD8Y1K3VZ5C9B7R',
        reserved: { cpuMillis: 4000, memoryMb: 8192, diskMb: 20480 },
        used: { cpuMillis: 3100, memoryMb: 6240, diskMb: 9800 },
        peakMemoryMb: 7610,
        seed: 23,
        cpuCeiling: 16000,
        memCeiling: 32256,
      }),
      session({
        id: 's3',
        title: 'Review previous session context using SAM MCP and summarize',
        project: 'TTV',
        owner: JONAS,
        agent: 'Claude Code',
        state: 'idle',
        startedMinutesAgo: 140,
        workspaceId: '01M6JZ8E5R0WQ6T2N4M8B1X3HD',
        reserved: { cpuMillis: 1000, memoryMb: 2048, diskMb: 5120 },
        used: { cpuMillis: 20, memoryMb: 310, diskMb: 1200 },
        peakMemoryMb: 1420,
        seed: 31,
        cpuBase: 600,
        memBase: 1100,
        cpuCeiling: 16000,
        memCeiling: 32256,
      }),
      session({
        id: 's4',
        title: 'Bump Wrangler and Vite, then rerun the quality checks',
        project: 'SAM',
        owner: NIGHTLY,
        agent: 'OpenCode',
        state: 'needs-you',
        startedMinutesAgo: 38,
        workspaceId: '01M6KC1V7H3SPZ9R0QY2W6E4NA',
        reserved: { cpuMillis: 1000, memoryMb: 2048, diskMb: 5120 },
        used: { cpuMillis: 40, memoryMb: 880, diskMb: 2300 },
        peakMemoryMb: 1960,
        seed: 47,
        cpuBase: 800,
        cpuCeiling: 16000,
        memCeiling: 32256,
      }),
      session({
        id: 's5',
        title:
          'Translate onboarding copy 🇫🇷 → 🇩🇪 and check every string fits on a 375px screen (<script>alert(1)</script> & “quotes”)',
        project: 'Marketing site with a very long project name',
        owner: MAYA,
        agent: 'Claude Code',
        state: 'working',
        startedMinutesAgo: 9,
        workspaceId: '01M6KH9T2B6YN1D4P8R3Q0S7MF',
        reserved: { cpuMillis: 500, memoryMb: 1024, diskMb: 2048 },
        used: { cpuMillis: 610, memoryMb: 1290, diskMb: 1500 },
        peakMemoryMb: 1350,
        seed: 53,
        cpuCeiling: 16000,
        memCeiling: 32256,
      }),
    ],
  },
  {
    id: '01M6DP6FWE3PVPP4PGB4TANN91',
    provider: 'Hetzner',
    instanceType: 'cx43',
    location: 'Nuremberg',
    vcpu: 8,
    memoryMb: 16384,
    diskGb: 160,
    hourlyEur: 0.0192,
    state: 'running',
    createdMinutesAgo: 55,
    sessions: [
      session({
        id: 's6',
        title: 'Run the full test matrix locally before opening the PR',
        project: 'TTV',
        owner: JONAS,
        agent: 'Codex',
        state: 'working',
        startedMinutesAgo: 52,
        workspaceId: '01M6KA4X8D2RM7C5V1N9T3B6QE',
        reserved: { cpuMillis: 6000, memoryMb: 14336, diskMb: 40960 },
        used: { cpuMillis: 7400, memoryMb: 13920, diskMb: 31000 },
        peakMemoryMb: 14210,
        seed: 61,
        memBase: 9000,
        cpuCeiling: 8000,
        memCeiling: 15872,
      }),
    ],
  },
  {
    id: '01M6EHBZ85GDPDQS5JSAYCKF4Z',
    provider: 'Hetzner',
    instanceType: 'ccx33',
    location: 'Ashburn',
    vcpu: 8,
    memoryMb: 32768,
    diskGb: 240,
    hourlyEur: 0.0752,
    state: 'running',
    createdMinutesAgo: 230,
    sessions: [
      session({
        id: 's7',
        title: 'Benchmark Durable Object alarm throughput',
        project: 'SAM',
        owner: YOU,
        agent: 'Codex',
        state: 'idle',
        startedMinutesAgo: 228,
        workspaceId: '01M6EHC2J7K9QW3E5R8T1Y4U6I',
        reserved: { cpuMillis: 8000, memoryMb: 32256, diskMb: 245760, exclusiveNode: true },
        used: { cpuMillis: 90, memoryMb: 2100, diskMb: 18000 },
        peakMemoryMb: 9800,
        seed: 71,
        cpuBase: 5200,
        memBase: 7000,
        cpuCeiling: 8000,
        memCeiling: 32256,
      }),
    ],
  },
  {
    id: '01M6K2QW9E4RT6Y8U1I3O5P7AS',
    provider: 'Hetzner',
    instanceType: 'cx33',
    location: 'Helsinki',
    vcpu: 4,
    memoryMb: 8192,
    diskGb: 80,
    hourlyEur: 0.0096,
    state: 'warm',
    warmMinutesLeft: 18,
    createdMinutesAgo: 96,
    sessions: [],
  },
  {
    id: '01M6KJ0Z3X5C7V9B2N4M6L8K0J',
    provider: 'Scaleway',
    instanceType: 'DEV1-L',
    location: 'Paris',
    vcpu: 4,
    memoryMb: 8192,
    diskGb: 80,
    hourlyEur: 0.042,
    state: 'starting',
    createdMinutesAgo: 1,
    sessions: [],
  },
];
