/**
 * Synthetic session resource histories for the Resources drawer audits, served
 * exactly as the API serves them: a `/resource-timeline` index with per-minute
 * rollups and raw 5-second chunks behind `/resource-timeline/chunks/:id`.
 *
 * Shapes are calibrated against production sessions (2026-09-28/29): idle at
 * ~0.01-0.03 cores with flat memory, builds at 1.5-3.8 cores for minutes with
 * memory swinging by gigabytes, most tool calls lasting milliseconds and a few
 * lasting minutes, and long sessions made of many wake cycles on several nodes.
 * Everything is seeded, so screenshots are reproducible.
 */
import type {
  ResourceTimelineChunkEntry,
  ResourceTimelineChunkResponse,
  ResourceTimelineIndexResponse,
  ResourceTimelineRollup,
  ResourceTimelineRunEntry,
  WorkspaceResourceSample,
  WorkspaceResourceToolSpan,
} from '../../src/lib/api/resource-timeline';

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const MINUTE = 60_000;
const SAMPLE_INTERVAL_MS = 5_000;
const CHUNK_INTERVAL_MS = 15 * MINUTE;

interface Reservation {
  cpuMillis: number;
  memoryMb: number;
}

interface RunPlan {
  startMin: number;
  durationMin: number;
  node: string;
  reservation: Reservation | null;
  unsupported?: string;
  /** Force an out-of-memory kill this many minutes into the run. */
  oomAtMin?: number;
}

type Workload = 'coordinator' | 'builder';

interface ScenarioPlan {
  /** Minutes before `now` the session started. */
  startedMinutesAgo: number;
  seed: number;
  workload: Workload;
  runs: RunPlan[];
  /** VM agents that predate working-set memory and tool labels report neither. */
  modernAgent: boolean;
  /** Chunks uploaded before rollups existed carry only their summary. */
  rollups: boolean;
  /** Oldest chunks the server left out past its cap. */
  omittedChunkCount?: number;
  collection?: ResourceTimelineIndexResponse['collection'];
  runtime?: string;
}

export type ResourceScenarioId = 'overnight' | 'legacy-agent' | 'truncated' | 'pending' | 'instant';

const SMALL: Reservation = { cpuMillis: 2_000, memoryMb: 4_096 };
const LARGE: Reservation = { cpuMillis: 4_000, memoryMb: 8_192 };

const SCENARIOS: Record<ResourceScenarioId, ScenarioPlan> = {
  // Modelled on session 449d73f8: many wakes on three nodes, a 9-hour overnight
  // sleep, an OOM kill, a wake whose container never started, and one wake that
  // landed on a larger size.
  overnight: {
    startedMinutesAgo: 1_625,
    seed: 7,
    workload: 'coordinator',
    modernAgent: true,
    rollups: true,
    runs: [
      { startMin: 0, durationMin: 52, node: 'node-hel1-a', reservation: SMALL },
      { startMin: 60, durationMin: 34, node: 'node-hel1-a', reservation: SMALL },
      { startMin: 131, durationMin: 18, node: 'node-fsn1-b', reservation: SMALL },
      { startMin: 689, durationMin: 115, node: 'node-fsn1-b', reservation: LARGE },
      { startMin: 845, durationMin: 47, node: 'node-nbg1-c', reservation: SMALL },
      { startMin: 904, durationMin: 131, node: 'node-nbg1-c', reservation: SMALL, oomAtMin: 88 },
      {
        startMin: 1_041,
        durationMin: 0.35,
        node: 'node-hel1-a',
        reservation: SMALL,
        unsupported: 'no running devcontainer found',
      },
      { startMin: 1_041.7, durationMin: 21, node: 'node-hel1-a', reservation: SMALL },
      { startMin: 1_242, durationMin: 64, node: 'node-hel1-a', reservation: SMALL },
      { startMin: 1_398, durationMin: 222, node: 'node-hel1-a', reservation: null },
    ],
  },
  'legacy-agent': {
    startedMinutesAgo: 820,
    seed: 11,
    workload: 'builder',
    modernAgent: false,
    rollups: false,
    runs: [
      { startMin: 0, durationMin: 52, node: 'node-hel1-a', reservation: null },
      { startMin: 60, durationMin: 34, node: 'node-hel1-a', reservation: null },
      { startMin: 689, durationMin: 115, node: 'node-fsn1-b', reservation: null },
    ],
  },
  truncated: {
    startedMinutesAgo: 250,
    seed: 21,
    workload: 'builder',
    modernAgent: true,
    rollups: true,
    omittedChunkCount: 612,
    runs: [{ startMin: 0, durationMin: 245, node: 'node-hel1-a', reservation: LARGE }],
  },
  pending: {
    startedMinutesAgo: 4,
    seed: 1,
    workload: 'coordinator',
    modernAgent: true,
    rollups: true,
    runs: [],
    collection: 'pending',
    runtime: 'vm',
  },
  instant: {
    startedMinutesAgo: 30,
    seed: 1,
    workload: 'coordinator',
    modernAgent: true,
    rollups: true,
    runs: [],
    collection: 'unsupported',
    runtime: 'cf-container',
  },
};

/** mulberry32 — tiny, fast, good enough for fixture data. */
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
  let roll = random() * weights.reduce((sum, [, weight]) => sum + weight, 0);
  for (const [kind, weight] of weights) {
    roll -= weight;
    if (roll <= 0) return kind;
  }
  return 'agent';
}

function phaseShape(kind: PhaseKind, random: () => number) {
  switch (kind) {
    case 'idle':
      return { minutes: 1 + random() * 7, cpu: 0.015, memoryLift: 0 };
    case 'agent':
      return { minutes: 1 + random() * 5, cpu: 0.05 + random() * 0.12, memoryLift: 0.05 * GB };
    case 'build':
      return {
        minutes: 2 + random() * 8,
        cpu: 1.5 + random() * 2.2,
        memoryLift: (0.8 + random() * 1.4) * GB,
      };
    case 'install':
      return { minutes: 1 + random() * 2, cpu: 0.6 + random() * 0.6, memoryLift: 0.3 * GB };
    case 'test':
      return {
        minutes: 2 + random() * 6,
        cpu: 1.2 + random() * 2.4,
        memoryLift: (1.2 + random() * 1.6) * GB,
      };
    case 'fetch':
      return { minutes: 0.5 + random() * 1.5, cpu: 0.08, memoryLift: 0.02 * GB };
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
    phases.push({
      kind,
      start: cursor,
      end: phaseEnd,
      cpu: shape.cpu,
      memoryLift: shape.memoryLift,
    });
    cursor = phaseEnd;
    previous = kind;
  }
  return phases;
}

type AgentTool = [name: string, kind: string, minMs: number, maxMs: number];
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
): WorkspaceResourceToolSpan[] {
  const span = (
    name: string,
    kind: string,
    startedAt: number,
    endedAt: number
  ): WorkspaceResourceToolSpan =>
    labelled
      ? { id: nextId(), kind, toolName: name, startedAt, endedAt }
      : { id: nextId(), kind: 'acp_tool_call', startedAt, endedAt };
  const duration = phase.end - phase.start;
  switch (phase.kind) {
    case 'build':
    case 'test':
    case 'install':
      return [
        span('Bash', 'execute', phase.start + Math.min(8_000, duration * 0.05), phase.end - 1_000),
      ];
    case 'fetch': {
      const spans: WorkspaceResourceToolSpan[] = [];
      for (let t = phase.start + 2_000; t < phase.end - 6_000; t += 8_000 + random() * 12_000) {
        spans.push(span('WebFetch', 'fetch', t, t + 900 + random() * 5_000));
      }
      return spans;
    }
    case 'agent': {
      const spans: WorkspaceResourceToolSpan[] = [];
      for (
        let t = phase.start + random() * 6_000;
        t < phase.end - 3_000;
        t += 4_000 + random() * 22_000
      ) {
        const [name, kind, minMs, maxMs] =
          AGENT_TOOLS[Math.floor(random() * AGENT_TOOLS.length)] ?? READ_TOOL;
        spans.push(span(name, kind, t, t + minMs + random() * (maxMs - minMs)));
      }
      return spans;
    }
    case 'idle':
      return [];
  }
}

interface GeneratedRun {
  id: string;
  plan: RunPlan;
  startedAt: number;
  endedAt: number;
  samples: WorkspaceResourceSample[];
  toolSpans: WorkspaceResourceToolSpan[];
}

function generateRun(
  plan: RunPlan,
  scenario: ScenarioPlan,
  sessionStart: number,
  index: number
): GeneratedRun {
  const random = createRandom(scenario.seed * 97 + index * 7919);
  const startedAt = sessionStart + plan.startMin * MINUTE;
  const endedAt = startedAt + plan.durationMin * MINUTE;
  const id = `ws-timeline-${index + 1}`;
  if (plan.unsupported) return { id, plan, startedAt, endedAt, samples: [], toolSpans: [] };

  const phases = planPhases(startedAt, endedAt, random, scenario.workload);
  let spanCounter = 0;
  const nextId = () => `span-${index}-${(spanCounter += 1)}`;
  const toolSpans = phases.flatMap((phase) =>
    spansForPhase(phase, random, nextId, scenario.modernAgent)
  );

  const baseMemory = (0.75 + random() * 0.45) * GB;
  const limit = plan.reservation ? plan.reservation.memoryMb * MB : Infinity;
  const oomAt = plan.oomAtMin == null ? null : startedAt + plan.oomAtMin * MINUTE;
  const gapAt = plan.durationMin > 90 ? startedAt + plan.durationMin * 0.4 * MINUTE : null;
  const samples: WorkspaceResourceSample[] = [];
  let cache = 0.1 * GB;
  let memoryLift = 0;
  let highWater = 0;
  let oomFired = false;
  let phaseIndex = 0;

  for (let t = startedAt + SAMPLE_INTERVAL_MS; t <= endedAt; t += SAMPLE_INTERVAL_MS) {
    if (gapAt != null && t >= gapAt && t < gapAt + 40_000) {
      samples.push({ t, gap: true });
      continue;
    }
    while (phaseIndex < phases.length - 1 && (phases[phaseIndex]?.end ?? Infinity) < t)
      phaseIndex += 1;
    const phase = phases[phaseIndex];
    if (!phase) break;
    const progress = (t - phase.start) / Math.max(1, phase.end - phase.start);
    const ramp = Math.min(1, progress * 6) * Math.min(1, (1 - progress) * 8);
    let cores = Math.max(
      0.005,
      phase.cpu * (phase.kind === 'idle' ? 1 : ramp) * (0.75 + random() * 0.5)
    );
    memoryLift += (phase.memoryLift * ramp * (0.8 + random() * 0.4) - memoryLift) * 0.35;
    let ioRead = phase.kind === 'build' ? random() * 3 * MB : random() * 0.2 * MB;
    const ioWrite = phase.kind === 'install' ? (4 + random() * 16) * MB * 5 : random() * 0.4 * MB;
    if (progress < 0.08 && phase.kind !== 'idle' && phase.kind !== 'agent')
      ioRead += (10 + random() * 60) * MB;
    cache = Math.min(cache + (ioRead + ioWrite) * 0.6, (baseMemory + memoryLift) * 0.45) * 0.998;

    let memory = baseMemory + memoryLift + cache;
    let oom = 0;
    if (!oomFired && oomAt != null && t >= oomAt && phase.kind !== 'idle') {
      memory = limit;
      oom = 1;
      oomFired = true;
      memoryLift = 0;
      cores = Math.max(cores, 3.4);
    } else if (memory > limit * 0.98) {
      memory = limit * 0.98;
    }
    const spike =
      (phase.kind === 'build' || phase.kind === 'test') && random() < 0.03
        ? (0.05 + random() * 0.3) * GB
        : 0;
    highWater = Math.max(highWater, memory + spike);
    samples.push({
      t,
      intervalMillis: SAMPLE_INTERVAL_MS,
      cpuMillis: Math.round(cores * SAMPLE_INTERVAL_MS),
      memoryBytes: Math.round(memory),
      memoryPeakBytes: Math.round(highWater),
      ...(scenario.modernAgent
        ? { memoryWorkingSetBytes: Math.round(Math.max(0, memory - cache)) }
        : {}),
      ioReadBytes: Math.round(ioRead),
      ioWriteBytes: Math.round(ioWrite),
      ...(oom ? { oomKill: oom } : {}),
    });
  }
  return { id, plan, startedAt, endedAt, samples, toolSpans };
}

const mean = (values: number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const maxOf = (values: number[]) => (values.length ? Math.max(...values) : null);

/** The same per-minute rollup the API computes on upload. */
function rollupOf(
  samples: WorkspaceResourceSample[],
  spans: WorkspaceResourceToolSpan[],
  start: number,
  end: number
): ResourceTimelineRollup {
  const rollup: ResourceTimelineRollup = {
    v: 1,
    bucketMs: MINUTE,
    start: [],
    end: [],
    samples: [],
    cpuMeanCores: [],
    cpuMaxCores: [],
    memoryMeanBytes: [],
    memoryMaxBytes: [],
    workingSetMeanBytes: [],
    workingSetMaxBytes: [],
    ioReadBytes: [],
    ioWriteBytes: [],
    oomKills: [],
    toolCallStarts: [],
  };
  for (let from = Math.floor(start / MINUTE) * MINUTE; from < end; from += MINUTE) {
    const to = from + MINUTE;
    const inside = samples.filter((s) => !s.gap && s.t > from && s.t <= to);
    const starts = spans.filter((s) => s.startedAt >= from && s.startedAt < to).length;
    if (inside.length === 0 && starts === 0) continue;
    const cores = inside.map((s) => (s.cpuMillis ?? 0) / SAMPLE_INTERVAL_MS);
    const memory = inside.map((s) => s.memoryBytes ?? 0);
    const workingSet = inside.flatMap((s) =>
      s.memoryWorkingSetBytes == null ? [] : [s.memoryWorkingSetBytes]
    );
    rollup.start.push(Math.max(from, start));
    rollup.end.push(Math.min(to, end));
    rollup.samples.push(inside.length);
    rollup.cpuMeanCores.push(mean(cores));
    rollup.cpuMaxCores.push(maxOf(cores));
    rollup.memoryMeanBytes.push(mean(memory));
    rollup.memoryMaxBytes.push(maxOf([...memory, ...inside.map((s) => s.memoryPeakBytes ?? 0)]));
    rollup.workingSetMeanBytes.push(mean(workingSet));
    rollup.workingSetMaxBytes.push(maxOf(workingSet));
    rollup.ioReadBytes.push(inside.reduce((sum, s) => sum + (s.ioReadBytes ?? 0), 0));
    rollup.ioWriteBytes.push(inside.reduce((sum, s) => sum + (s.ioWriteBytes ?? 0), 0));
    rollup.oomKills.push(inside.reduce((sum, s) => sum + (s.oom ?? 0) + (s.oomKill ?? 0), 0));
    rollup.toolCallStarts.push(starts);
  }
  return rollup;
}

function summaryOf(samples: WorkspaceResourceSample[], modernAgent: boolean) {
  const measured = samples.filter((s) => !s.gap);
  const cpu = measured.map((s) => s.cpuMillis ?? 0);
  const memory = measured.map((s) => s.memoryBytes ?? 0);
  const workingSet = measured.map((s) => s.memoryWorkingSetBytes ?? 0);
  return {
    sampleIntervalMillis: SAMPLE_INTERVAL_MS,
    cpuMeanMillis: mean(cpu),
    cpuPeakMillis: maxOf(cpu),
    memoryMeanBytes: mean(memory),
    memoryPeakBytes: maxOf(memory),
    memoryKernelPeakBytes: maxOf(measured.map((s) => s.memoryPeakBytes ?? 0)),
    ioReadBytes: measured.reduce((sum, s) => sum + (s.ioReadBytes ?? 0), 0),
    ioWriteBytes: measured.reduce((sum, s) => sum + (s.ioWriteBytes ?? 0), 0),
    oomCount: measured.reduce((sum, s) => sum + (s.oomKill ?? 0), 0),
    ...(modernAgent
      ? {
          memoryWorkingSetMeanBytes: mean(workingSet),
          memoryWorkingSetPeakBytes: maxOf(workingSet),
        }
      : {}),
  };
}

export interface ResourceScenarioApi {
  index: ResourceTimelineIndexResponse;
  chunks: Map<string, ResourceTimelineChunkResponse>;
}

export function buildResourceScenario(
  id: ResourceScenarioId,
  sessionId: string,
  now: number
): ResourceScenarioApi {
  const plan = SCENARIOS[id];
  const sessionStart = now - plan.startedMinutesAgo * MINUTE;
  const chunks = new Map<string, ResourceTimelineChunkResponse>();
  const entries: ResourceTimelineChunkEntry[] = [];
  const runs: ResourceTimelineRunEntry[] = [];

  plan.runs.forEach((runPlan, index) => {
    const run = generateRun(runPlan, plan, sessionStart, index);
    runs.push({
      workspaceId: run.id,
      nodeId: runPlan.node,
      runtime: 'vm',
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      reservation: runPlan.reservation,
    });
    for (
      let start = run.startedAt, sequence = 0;
      start < run.endedAt;
      start += CHUNK_INTERVAL_MS, sequence += 1
    ) {
      const end = Math.min(run.endedAt, start + CHUNK_INTERVAL_MS);
      const chunkId = `wrchunk:${run.id}:${sequence}`;
      const samples = run.samples.filter((s) => s.t > start && s.t <= end);
      // The collector records a span when it completes, so it lands in the chunk where it ends.
      const toolSpans = run.toolSpans.filter(
        (s) => (s.endedAt ?? s.startedAt) > start && (s.endedAt ?? s.startedAt) <= end
      );
      chunks.set(chunkId, {
        chunkId,
        samples,
        toolSpans,
        gaps: [],
        originalSampleCount: samples.length,
        downsampled: false,
        downsampleLimit: 720,
      });
      entries.push({
        id: chunkId,
        workspaceId: run.id,
        startedAt: start,
        endedAt: end,
        sampleCount: samples.filter((s) => !s.gap).length,
        gapCount: samples.filter((s) => s.gap).length,
        toolSpanCount: toolSpans.length,
        summary: summaryOf(samples, plan.modernAgent),
        completeness: runPlan.unsupported
          ? { unsupported: runPlan.unsupported }
          : { status: 'complete' },
        rollup:
          plan.rollups && samples.length > 0 ? rollupOf(samples, toolSpans, start, end) : null,
      });
    }
  });

  const omitted = plan.omittedChunkCount ?? 0;
  return {
    chunks,
    index: {
      sessionId,
      runs,
      chunks: entries,
      totalChunkCount: entries.length + omitted,
      omittedChunkCount: omitted,
      maxChunks: entries.length,
      collection: plan.collection ?? 'collected',
      runtime: plan.runtime ?? 'vm',
    },
  };
}
