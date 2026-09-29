/**
 * PROTOTYPE ONLY — synthetic session resource histories.
 *
 * Shapes are calibrated against production sessions (2026-09-28/29): idle at
 * ~0.01-0.03 cores with flat memory, builds at 1.5-3.8 cores for minutes with
 * memory swinging by gigabytes, most tool calls lasting milliseconds and a few
 * lasting minutes, and long sessions made of many wake cycles on several nodes.
 * Everything is seeded, so screenshots are reproducible.
 */

import { withToolStarts } from '../../components/chat/resource-timeline/resource-source';
import type {
  ResourceAggregate,
  ResourceChunkDetail,
  ResourceRun,
  ResourceToolSpan,
  ToolKind,
} from '../../components/chat/resource-timeline/types';

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const MINUTE = 60_000;
export const SAMPLE_INTERVAL_MS = 5_000;
export const CHUNK_INTERVAL_MS = 15 * MINUTE;

interface RunPlan {
  startMin: number;
  durationMin: number;
  node: string;
  unsupported?: string;
  /** Force an out-of-memory kill this many minutes into the run. */
  oomAtMin?: number;
}

/** A coordinator mostly waits and dispatches; a builder compiles and tests all day. */
type Workload = 'coordinator' | 'builder';

export interface ScenarioPlan {
  id: string;
  label: string;
  description: string;
  startedAt: number;
  seed: number;
  workload: Workload;
  runs: RunPlan[];
  reservation: { cpuCores: number; memoryBytes: number } | null;
  /** VM agents that predate working-set memory and tool labels report neither. */
  agentReportsWorkingSet: boolean;
  agentReportsToolNames: boolean;
}

export interface GeneratedRun {
  run: ResourceRun;
  samples: ResourceAggregate[];
  toolSpans: ResourceToolSpan[];
  samplerGaps: Array<{ start: number; end: number }>;
  memoryHighWater: number[];
}

/** mulberry32 — tiny, fast, good enough for mock data. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type PhaseKind = 'idle' | 'agent' | 'build' | 'install' | 'test' | 'fetch';

interface Phase {
  kind: PhaseKind;
  start: number;
  end: number;
  cpu: number;
  memoryLift: number;
}

const PHASE_WEIGHTS: Record<Workload, Array<[PhaseKind, number]>> = {
  coordinator: [
    ['idle', 5],
    ['agent', 6],
    ['build', 0.7],
    ['install', 0.3],
    ['test', 0.5],
    ['fetch', 1.5],
  ],
  builder: [
    ['idle', 3],
    ['agent', 5],
    ['build', 2],
    ['install', 1],
    ['test', 1.5],
    ['fetch', 1],
  ],
};

function pickPhase(random: () => number, workload: Workload): PhaseKind {
  const weights = PHASE_WEIGHTS[workload];
  const total = weights.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = random() * total;
  for (const [kind, weight] of weights) {
    roll -= weight;
    if (roll <= 0) return kind;
  }
  return 'agent';
}

function phaseShape(kind: PhaseKind, random: () => number): Omit<Phase, 'start' | 'end'> & { minutes: number } {
  switch (kind) {
    case 'idle':
      return { kind, minutes: 1 + random() * 7, cpu: 0.015, memoryLift: 0 };
    case 'agent':
      return { kind, minutes: 1 + random() * 5, cpu: 0.05 + random() * 0.12, memoryLift: 0.05 * GB };
    case 'build':
      return { kind, minutes: 2 + random() * 8, cpu: 1.5 + random() * 2.2, memoryLift: (0.8 + random() * 1.4) * GB };
    case 'install':
      return { kind, minutes: 1 + random() * 2, cpu: 0.6 + random() * 0.6, memoryLift: 0.3 * GB };
    case 'test':
      return { kind, minutes: 2 + random() * 6, cpu: 1.2 + random() * 2.4, memoryLift: (1.2 + random() * 1.6) * GB };
    case 'fetch':
      return { kind, minutes: 0.5 + random() * 1.5, cpu: 0.08, memoryLift: 0.02 * GB };
  }
}

function planPhases(start: number, end: number, random: () => number, workload: Workload): Phase[] {
  const phases: Phase[] = [];
  let cursor = start;
  let previous: PhaseKind = 'idle';
  while (cursor < end) {
    let kind = pickPhase(random, workload);
    if (kind === previous && kind !== 'agent') kind = 'agent';
    const shape = phaseShape(kind, random);
    const phaseEnd = Math.min(end, cursor + shape.minutes * MINUTE);
    phases.push({ kind, start: cursor, end: phaseEnd, cpu: shape.cpu, memoryLift: shape.memoryLift });
    cursor = phaseEnd;
    previous = kind;
  }
  return phases;
}

type AgentTool = [name: string, kind: ToolKind, minMs: number, maxMs: number];

const READ_TOOL: AgentTool = ['Read', 'read', 5, 400];
const AGENT_TOOLS: AgentTool[] = [
  READ_TOOL,
  ['Grep', 'search', 20, 900],
  ['Glob', 'search', 5, 200],
  ['Edit', 'edit', 10, 600],
  ['Write', 'edit', 10, 300],
  ['TodoWrite', 'think', 5, 50],
  ['mcp__sam-mcp__update_task_status', 'other', 150, 2_500],
  ['Bash', 'execute', 200, 6_000],
];

function spansForPhase(
  phase: Phase,
  random: () => number,
  nextId: () => string,
  labelled: boolean
): ResourceToolSpan[] {
  const span = (name: string, kind: ToolKind, startedAt: number, endedAt: number): ResourceToolSpan => ({
    id: nextId(),
    kind: labelled ? kind : 'other',
    name: labelled ? name : null,
    startedAt,
    endedAt,
    approximateEnd: false,
  });
  const duration = phase.end - phase.start;
  switch (phase.kind) {
    case 'build':
    case 'test':
    case 'install': {
      const lead = Math.min(8_000, duration * 0.05);
      return [span('Bash', 'execute', phase.start + lead, phase.end - 1_000)];
    }
    case 'fetch': {
      const spans: ResourceToolSpan[] = [];
      for (let t = phase.start + 2_000; t < phase.end - 6_000; t += 8_000 + random() * 12_000) {
        spans.push(span('WebFetch', 'fetch', t, t + 900 + random() * 5_000));
      }
      return spans;
    }
    case 'agent': {
      const spans: ResourceToolSpan[] = [];
      for (let t = phase.start + random() * 6_000; t < phase.end - 3_000; t += 4_000 + random() * 22_000) {
        const [name, kind, minMs, maxMs] = AGENT_TOOLS[Math.floor(random() * AGENT_TOOLS.length)] ?? READ_TOOL;
        spans.push(span(name, kind, t, t + minMs + random() * (maxMs - minMs)));
      }
      return spans;
    }
    case 'idle':
      return [];
  }
}

/** Generates one run's 5-second samples, tool spans and kernel memory high-water marks. */
export function generateRun(plan: RunPlan, scenario: ScenarioPlan, index: number): GeneratedRun {
  const random = createRandom(scenario.seed * 97 + index * 7919);
  const startedAt = scenario.startedAt + plan.startMin * MINUTE;
  const endedAt = startedAt + plan.durationMin * MINUTE;
  const run: ResourceRun = {
    id: `ws-${scenario.id}-${index + 1}`,
    nodeId: plan.node,
    startedAt,
    endedAt,
    unsupportedReason: plan.unsupported ?? null,
  };
  if (plan.unsupported) return { run, samples: [], toolSpans: [], samplerGaps: [], memoryHighWater: [] };

  const phases = planPhases(startedAt, endedAt, random, scenario.workload);
  let spanCounter = 0;
  const nextId = () => `span-${scenario.id}-${index}-${(spanCounter += 1)}`;
  const toolSpans = phases.flatMap((phase) =>
    spansForPhase(phase, random, nextId, scenario.agentReportsToolNames)
  );

  const baseMemory = (0.75 + random() * 0.45) * GB;
  const limit = scenario.reservation?.memoryBytes ?? Infinity;
  const oomAt = plan.oomAtMin == null ? null : startedAt + plan.oomAtMin * MINUTE;
  const samplerGapAt = plan.durationMin > 90 ? startedAt + plan.durationMin * 0.4 * MINUTE : null;
  const samples: ResourceAggregate[] = [];
  const samplerGaps: Array<{ start: number; end: number }> = [];
  const memoryHighWater: number[] = [];
  let cache = 0.1 * GB;
  let memoryLift = 0;
  let highWater = 0;
  let oomFired = false;
  let phaseIndex = 0;

  for (let t = startedAt + SAMPLE_INTERVAL_MS; t <= endedAt; t += SAMPLE_INTERVAL_MS) {
    if (samplerGapAt != null && t >= samplerGapAt && t < samplerGapAt + 40_000) {
      if (samplerGaps.length === 0) samplerGaps.push({ start: samplerGapAt, end: samplerGapAt + 40_000 });
      continue;
    }
    while (phaseIndex < phases.length - 1 && (phases[phaseIndex]?.end ?? Infinity) < t) phaseIndex += 1;
    const phase = phases[phaseIndex];
    if (!phase) break;
    const progress = (t - phase.start) / Math.max(1, phase.end - phase.start);
    const ramp = Math.min(1, progress * 6) * Math.min(1, (1 - progress) * 8);
    const jitter = 0.75 + random() * 0.5;
    let cores = Math.max(0.005, phase.cpu * (phase.kind === 'idle' ? 1 : ramp) * jitter);

    const targetLift = phase.memoryLift * ramp * (0.8 + random() * 0.4);
    memoryLift += (targetLift - memoryLift) * 0.35;
    let ioRead = phase.kind === 'build' ? random() * 3 * MB : random() * 0.2 * MB;
    const ioWrite = phase.kind === 'install' ? (4 + random() * 16) * MB * 5 : random() * 0.4 * MB;
    if (progress < 0.08 && phase.kind !== 'idle' && phase.kind !== 'agent') ioRead += (10 + random() * 60) * MB;
    cache = Math.min(cache + (ioRead + ioWrite) * 0.6, (baseMemory + memoryLift) * 0.45);
    cache *= 0.998;

    let memory = baseMemory + memoryLift + cache;
    let oomKills = 0;
    if (!oomFired && oomAt != null && t >= oomAt && phase.kind !== 'idle') {
      memory = limit;
      oomKills = 1;
      oomFired = true;
      memoryLift = 0;
      cores = Math.max(cores, 3.4);
    } else if (memory > limit * 0.98) {
      memory = limit * 0.98;
    }
    const spike = (phase.kind === 'build' || phase.kind === 'test') && random() < 0.03 ? (0.05 + random() * 0.3) * GB : 0;
    highWater = Math.max(highWater, memory + spike);
    memoryHighWater.push(highWater);
    const workingSet = scenario.agentReportsWorkingSet ? Math.max(0, memory - cache) : null;
    samples.push({
      start: t - SAMPLE_INTERVAL_MS,
      end: t,
      cpuMeanCores: cores,
      cpuMaxCores: cores,
      memoryMeanBytes: memory,
      memoryMaxBytes: memory,
      workingSetMeanBytes: workingSet,
      workingSetMaxBytes: workingSet,
      ioReadBytes: Math.round(ioRead),
      ioWriteBytes: Math.round(ioWrite),
      oomKills,
      toolCallStarts: 0,
      exact: true,
    });
  }
  return { run, samples, toolSpans, samplerGaps, memoryHighWater };
}

/** Splits a run into 15-minute chunks the way the VM collector uploads them. */
export function chunkRun(generated: GeneratedRun): Array<{ id: string; startedAt: number; endedAt: number; detail: ResourceChunkDetail; highWater: number | null }> {
  const { run } = generated;
  const chunks = [];
  for (let start = run.startedAt, sequence = 0; start < run.endedAt; start += CHUNK_INTERVAL_MS, sequence += 1) {
    const end = Math.min(run.endedAt, start + CHUNK_INTERVAL_MS);
    const inChunk = (t: number) => t > start && t <= end;
    const members = generated.samples.flatMap((sample, i) =>
      inChunk(sample.end) ? [{ sample, highWater: generated.memoryHighWater[i] ?? null }] : []
    );
    const id = `wrchunk:${run.id}:${sequence}`;
    // The collector records a span when it completes, so it lands in the chunk where it ends.
    const toolSpans = generated.toolSpans.filter((span) => inChunk(span.endedAt));
    chunks.push({
      id,
      startedAt: start,
      endedAt: end,
      highWater: members.at(-1)?.highWater ?? null,
      detail: {
        chunkId: id,
        samples: withToolStarts(members.map((member) => member.sample), toolSpans),
        toolSpans,
        samplerGaps: generated.samplerGaps.filter((gap) => inChunk(gap.start)),
      },
    });
  }
  return chunks;
}

const EVENING = Date.parse('2026-09-28T19:40:00');

const OVERNIGHT: ScenarioPlan = {
id: 'overnight',
  label: 'Overnight coordinator · 27h · 10 wakes',
  description: 'Modelled on session 449d73f8: many wake cycles on three nodes, a 9-hour overnight sleep, an OOM kill and a wake whose container never started.',
  startedAt: EVENING,
  seed: 7,
  workload: 'coordinator',
  reservation: { cpuCores: 2, memoryBytes: 4 * GB },
  agentReportsWorkingSet: true,
  agentReportsToolNames: true,
  runs: [
    { startMin: 0, durationMin: 52, node: 'node-hel1-a' },
    { startMin: 60, durationMin: 34, node: 'node-hel1-a' },
    { startMin: 131, durationMin: 18, node: 'node-fsn1-b' },
    { startMin: 689, durationMin: 115, node: 'node-fsn1-b' },
    { startMin: 845, durationMin: 47, node: 'node-nbg1-c' },
    { startMin: 904, durationMin: 131, node: 'node-nbg1-c', oomAtMin: 88 },
    { startMin: 1041, durationMin: 0.35, node: 'node-hel1-a', unsupported: 'no running devcontainer found' },
    { startMin: 1041.7, durationMin: 21, node: 'node-hel1-a' },
    { startMin: 1242, durationMin: 64, node: 'node-hel1-a' },
    { startMin: 1398, durationMin: 222, node: 'node-hel1-a' },
  ],
};

export const SCENARIOS: ScenarioPlan[] = [
  OVERNIGHT,
  {
    id: 'build-heavy',
    label: 'One long run · 4h · heavy builds',
    description: 'Modelled on session 98ac3e40: a single four-hour run with frequent builds and hundreds of tool calls.',
    startedAt: Date.parse('2026-09-28T09:05:00'),
    seed: 21,
    workload: 'builder',
    reservation: { cpuCores: 4, memoryBytes: 8 * GB },
    agentReportsWorkingSet: true,
    agentReportsToolNames: true,
    runs: [{ startMin: 0, durationMin: 245, node: 'node-hel1-a' }],
  },
  {
    id: 'short',
    label: 'Short task · 11 min',
    description: 'One run shorter than a single upload interval: one partial chunk.',
    startedAt: Date.parse('2026-09-29T07:12:00'),
    seed: 3,
    workload: 'builder',
    reservation: { cpuCores: 2, memoryBytes: 4 * GB },
    agentReportsWorkingSet: true,
    agentReportsToolNames: true,
    runs: [{ startMin: 0, durationMin: 11, node: 'node-hel1-a' }],
  },
  {
    id: 'legacy-agent',
    label: 'Older VM agent · no labels or working set',
    description: 'The overnight session as reported by agents that predate tool labels and working-set memory.',
    startedAt: EVENING,
    seed: 7,
    workload: 'coordinator',
    reservation: null,
    agentReportsWorkingSet: false,
    agentReportsToolNames: false,
    runs: [
      { startMin: 0, durationMin: 52, node: 'node-hel1-a' },
      { startMin: 60, durationMin: 34, node: 'node-hel1-a' },
      { startMin: 689, durationMin: 115, node: 'node-fsn1-b' },
    ],
  },
  {
    id: 'empty',
    label: 'Just started · nothing uploaded yet',
    description: 'Samples upload every 15 minutes; a new session has none yet.',
    startedAt: Date.parse('2026-09-29T07:40:00'),
    seed: 1,
    workload: 'coordinator',
    reservation: null,
    agentReportsWorkingSet: true,
    agentReportsToolNames: true,
    runs: [],
  },
];

/** The scenario with `id`, or the overnight session when the id is unknown. */
export function scenarioById(id: string | null): ScenarioPlan {
  return SCENARIOS.find((scenario) => scenario.id === id) ?? OVERNIGHT;
}
