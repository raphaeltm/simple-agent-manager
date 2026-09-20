/**
 * Stress-test datasets for the Resources panel prototypes.
 *
 * Shapes are the REAL API types, so anything that renders here renders against
 * production data too. Four datasets, selectable from the prototype toolbar:
 * Rich (typical), Huge (overflows every phone), Empty, Error.
 */
import type {
  WorkspaceResourceChunk,
  WorkspaceResourceHistoryResponse,
  WorkspaceResourceSample,
  WorkspaceResourceSummary,
  WorkspaceResourceToolSpan,
} from '../../lib/api/sessions';

export type PrototypeDatasetId = 'rich' | 'huge' | 'empty' | 'error';

export const DATASET_IDS: readonly PrototypeDatasetId[] = ['rich', 'huge', 'empty', 'error'];

export const DATASET_LABEL: Record<PrototypeDatasetId, string> = {
  rich: 'Rich',
  huge: 'Huge',
  empty: 'Empty',
  error: 'Error',
};

const PROJECT_ID = 'proto-project';
const SESSION_ID = 'proto-session';
const WORKSPACE_ID = 'proto-workspace';
const NODE_ID = 'proto-node';

/** Fixed clock so screenshots are byte-comparable between runs. */
const NOW = Date.UTC(2026, 8, 20, 14, 30, 0);
const MINUTE = 60_000;

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** One tool `kind` long enough to prove the row truncates rather than pushing the panel wide. */
const LONG_TOOL_KIND =
  'acp_tool_call:bash:pnpm --filter @simple-agent-manager/api test -- --reporter=verbose --coverage';

interface SummaryOverrides extends Partial<WorkspaceResourceSummary> {
  startedAt: number;
  endedAt: number;
}

function makeSummary(overrides: SummaryOverrides): WorkspaceResourceSummary {
  return {
    id: `workspace:${PROJECT_ID}:${WORKSPACE_ID}:session:${SESSION_ID}`,
    projectId: PROJECT_ID,
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    taskId: 'proto-task',
    nodeId: NODE_ID,
    agentProfileId: 'proto-profile',
    skillId: 'proto-skill',
    agentType: 'openai-codex',
    runtime: 'vm',
    sourceVersion: 1,
    sampleCount: 180,
    gapCount: 1,
    toolSpanCount: 9,
    cpuMeanMillis: 46,
    cpuPeakMillis: 420,
    memoryMeanBytes: 720 * MIB,
    memoryPeakBytes: 1.25 * GIB,
    memoryKernelPeakBytes: 1.5 * GIB,
    ioReadBytes: 184 * MIB,
    ioWriteBytes: 612 * MIB,
    oomCount: 1,
    completeness: { status: 'partial', nodeLossMayLoseUnflushedWindow: true },
    summary: { weightedMeanWallMillis: 1_780_000 },
    firstChunkId: null,
    latestChunkId: null,
    ...overrides,
  };
}

interface ChunkOverrides extends Partial<WorkspaceResourceChunk> {
  id: string;
  chunkSequence: number;
  startedAt: number;
  endedAt: number;
}

function makeChunk(overrides: ChunkOverrides): WorkspaceResourceChunk {
  return {
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    taskId: 'proto-task',
    nodeId: NODE_ID,
    sourceVersion: 1,
    storageFormat: 'resource-history-gzip-json-v1',
    compressedBytes: 6_299,
    uncompressedBytes: 106_968,
    sha256: 'a'.repeat(64),
    sampleCount: 180,
    gapCount: 1,
    toolSpanCount: 9,
    completeness: { status: 'partial' },
    summary: { cpuPeakMillis: 420 },
    expiresAt: NOW + 90 * 24 * 60 * MINUTE,
    ...overrides,
  };
}

/**
 * 30 minutes at a 10s cadence, shaped so every marker the chart can draw is
 * present: a CPU spike, a memory plateau, a sampling gap, a counter reset and
 * an OOM sample.
 */
function richSamples(startedAt: number): WorkspaceResourceSample[] {
  return Array.from({ length: 180 }, (_, i) => {
    const spiking = i >= 40 && i <= 55;
    const plateau = i >= 90;
    return {
      t: startedAt + i * 10_000,
      intervalMillis: 10_000,
      cpuMillis: spiking ? 420 - Math.abs(48 - i) * 12 : 30 + (i % 7) * 6,
      memoryBytes: plateau ? 1.25 * GIB : (420 + i * 8) * MIB,
      memoryPeakBytes: plateau ? 1.25 * GIB : (480 + i * 8) * MIB,
      ioReadBytes: i % 12 === 0 ? 4 * MIB : 24 * 1024,
      ioWriteBytes: i % 9 === 0 ? 12 * MIB : 96 * 1024,
      oom: i === 150 ? 1 : 0,
      oomKill: i === 150 ? 1 : 0,
      pidsCurrent: 48 + (i % 11),
      gap: i === 120,
      counterReset: i === 140,
    };
  });
}

function richToolSpans(startedAt: number): WorkspaceResourceToolSpan[] {
  const at = (minutes: number) => startedAt + minutes * MINUTE;
  return [
    {
      id: 'span-1',
      kind: 'acp_tool_call:read_file',
      startedAt: at(1),
      endedAt: at(2),
      concurrency: 1,
    },
    {
      id: 'span-2',
      kind: 'acp_tool_call:grep',
      startedAt: at(3),
      endedAt: at(4.5),
      concurrency: 1,
    },
    // Overlapping pair — the chart draws these as stacked bands.
    {
      id: 'span-3',
      kind: 'acp_tool_call:edit_file',
      startedAt: at(6),
      endedAt: at(11),
      concurrency: 2,
    },
    { id: 'span-4', kind: LONG_TOOL_KIND, startedAt: at(7), endedAt: at(13), concurrency: 2 },
    {
      id: 'span-5',
      kind: 'acp_tool_call:write_file',
      startedAt: at(14),
      endedAt: at(15),
      concurrency: 1,
    },
    {
      id: 'span-6',
      kind: 'acp_tool_call:bash:git status',
      startedAt: at(16),
      endedAt: at(17),
      concurrency: 1,
    },
    {
      id: 'span-7',
      kind: 'acp_tool_call:bash:pnpm typecheck',
      startedAt: at(18),
      endedAt: at(23),
      concurrency: 3,
    },
    {
      id: 'span-8',
      kind: 'acp_tool_call:bash:pnpm lint',
      startedAt: at(19),
      endedAt: at(22),
      concurrency: 3,
    },
    // No `endedAt`: the agent died mid-call, so the window end is inferred.
    {
      id: 'span-9',
      kind: 'acp_tool_call:bash:pnpm build',
      startedAt: at(25),
      approximate: true,
      concurrency: 1,
    },
  ];
}

const RICH_CHUNK_COUNT = 3;
const RICH_CHUNK_MINUTES = 30;

const RICH_CHUNKS: WorkspaceResourceChunk[] = Array.from(
  { length: RICH_CHUNK_COUNT },
  (_, index) => {
    // Newest first, matching the API's ordering.
    const endedAt = NOW - index * RICH_CHUNK_MINUTES * MINUTE;
    return makeChunk({
      id: `chunk-rich-${RICH_CHUNK_COUNT - index}`,
      chunkSequence: RICH_CHUNK_COUNT - index,
      startedAt: endedAt - RICH_CHUNK_MINUTES * MINUTE,
      endedAt,
      gapCount: index === 0 ? 1 : 0,
      toolSpanCount: index === 0 ? 9 : 4,
      compressedBytes: 6_299 - index * 380,
    });
  }
);

const HUGE_CHUNK_COUNT = 24;

const HUGE_CHUNKS: WorkspaceResourceChunk[] = Array.from(
  { length: HUGE_CHUNK_COUNT },
  (_, index) => {
    const endedAt = NOW - index * 20 * MINUTE;
    return makeChunk({
      id: `chunk-huge-${HUGE_CHUNK_COUNT - index}`,
      chunkSequence: HUGE_CHUNK_COUNT - index,
      startedAt: endedAt - 20 * MINUTE,
      endedAt,
      sampleCount: 720,
      gapCount: index % 4,
      toolSpanCount: 40,
      compressedBytes: 118_400 + index * 2_100,
      uncompressedBytes: 2_140_000 + index * 31_000,
    });
  }
);

/** 720 samples over 2 hours, with sustained load rather than one spike. */
function hugeSamples(startedAt: number): WorkspaceResourceSample[] {
  return Array.from({ length: 720 }, (_, i) => ({
    t: startedAt + i * 10_000,
    intervalMillis: 10_000,
    cpuMillis: 180 + Math.round(Math.sin(i / 18) * 90) + (i % 23) * 4,
    memoryBytes: (2_600 + Math.round(Math.sin(i / 40) * 900) + (i % 17) * 12) * MIB,
    memoryPeakBytes: (3_800 + (i % 17) * 12) * MIB,
    ioReadBytes: i % 6 === 0 ? 96 * MIB : 512 * 1024,
    ioWriteBytes: i % 5 === 0 ? 148 * MIB : 640 * 1024,
    oom: i === 402 || i === 610 ? 1 : 0,
    pidsCurrent: 210 + (i % 40),
    gap: i % 160 === 0 && i > 0,
    counterReset: i === 480,
  }));
}

function hugeToolSpans(startedAt: number): WorkspaceResourceToolSpan[] {
  return Array.from({ length: 40 }, (_, i) => ({
    id: `span-huge-${i}`,
    kind:
      i === 11
        ? LONG_TOOL_KIND
        : `acp_tool_call:${['read_file', 'edit_file', 'bash', 'grep'][i % 4]}`,
    startedAt: startedAt + i * 2.8 * MINUTE,
    endedAt: startedAt + (i * 2.8 + (i % 3 === 0 ? 5.5 : 2)) * MINUTE,
    concurrency: (i % 3) + 1,
    approximate: i === 39,
  }));
}

type Detail = NonNullable<WorkspaceResourceHistoryResponse['detail']>;

function richDetail(chunk: WorkspaceResourceChunk): Detail {
  return {
    chunkId: chunk.id,
    samples: richSamples(chunk.startedAt),
    toolSpans: richToolSpans(chunk.startedAt),
    gaps: [
      {
        startedAt: chunk.startedAt + 20 * MINUTE,
        endedAt: chunk.startedAt + 20.5 * MINUTE,
        reason: 'sampler_delay',
      },
    ],
    originalSampleCount: 180,
    downsampled: false,
    downsampleLimit: 720,
  };
}

function hugeDetail(chunk: WorkspaceResourceChunk): Detail {
  return {
    chunkId: chunk.id,
    samples: hugeSamples(chunk.startedAt),
    toolSpans: hugeToolSpans(chunk.startedAt),
    gaps: [
      {
        startedAt: chunk.startedAt + 27 * MINUTE,
        endedAt: chunk.startedAt + 29 * MINUTE,
        reason: 'node_restart',
      },
    ],
    originalSampleCount: 4_320,
    downsampled: true,
    downsampleLimit: 720,
  };
}

export interface PrototypeDataset {
  id: PrototypeDatasetId;
  /** Variants render this as the panel's error state. */
  isError: boolean;
  /** Summary + chunk list, i.e. the response before any chunk is selected. */
  history: WorkspaceResourceHistoryResponse;
  /** Detail for a chunk, mirroring `GET …/resource-history?chunkId=…`. */
  detailFor: (chunkId: string) => Detail | undefined;
}

const EMPTY_HISTORY: WorkspaceResourceHistoryResponse = { summary: null, chunks: [] };

const RICH_SUMMARY = makeSummary({
  startedAt: RICH_CHUNKS.at(-1)?.startedAt ?? NOW,
  endedAt: NOW,
  firstChunkId: RICH_CHUNKS.at(-1)?.id ?? null,
  latestChunkId: RICH_CHUNKS[0]?.id ?? null,
});

const HUGE_SUMMARY = makeSummary({
  startedAt: HUGE_CHUNKS.at(-1)?.startedAt ?? NOW,
  endedAt: NOW,
  sampleCount: 17_280,
  gapCount: 36,
  toolSpanCount: 960,
  cpuMeanMillis: 214,
  cpuPeakMillis: 3_980,
  memoryMeanBytes: 2.6 * GIB,
  memoryPeakBytes: 14.8 * GIB,
  memoryKernelPeakBytes: 15.6 * GIB,
  ioReadBytes: 412 * GIB,
  ioWriteBytes: 1.9 * 1024 * GIB,
  oomCount: 12,
  firstChunkId: HUGE_CHUNKS.at(-1)?.id ?? null,
  latestChunkId: HUGE_CHUNKS[0]?.id ?? null,
});

const DATASETS: Record<PrototypeDatasetId, PrototypeDataset> = {
  rich: {
    id: 'rich',
    isError: false,
    history: { summary: RICH_SUMMARY, chunks: RICH_CHUNKS },
    detailFor: (chunkId) => {
      const chunk = RICH_CHUNKS.find((item) => item.id === chunkId);
      return chunk ? richDetail(chunk) : undefined;
    },
  },
  huge: {
    id: 'huge',
    isError: false,
    history: { summary: HUGE_SUMMARY, chunks: HUGE_CHUNKS },
    detailFor: (chunkId) => {
      const chunk = HUGE_CHUNKS.find((item) => item.id === chunkId);
      return chunk ? hugeDetail(chunk) : undefined;
    },
  },
  empty: {
    id: 'empty',
    isError: false,
    history: EMPTY_HISTORY,
    detailFor: () => undefined,
  },
  error: {
    id: 'error',
    isError: true,
    history: EMPTY_HISTORY,
    detailFor: () => undefined,
  },
};

export function getDataset(id: PrototypeDatasetId): PrototypeDataset {
  return DATASETS[id];
}

/** Detail for one chunk, in whichever dataset owns it. */
export function mockDetailForChunk(id: PrototypeDatasetId, chunkId: string): Detail | undefined {
  return DATASETS[id].detailFor(chunkId);
}

/** Mock conversation rendered behind the panel. One long bubble, mixed roles. */
export interface MockMessage {
  id: string;
  role: 'user' | 'assistant';
  body: string;
}

export const MOCK_SESSION_TITLE =
  'Reconcile the supersession ledger against the ProjectData Durable Object so the active-agent count stops reporting ten times the real compute';

export const MOCK_MESSAGES: MockMessage[] = [
  {
    id: 'm1',
    role: 'user',
    body: 'Where did the running tasks come from, and what is each one doing?',
  },
  {
    id: 'm2',
    role: 'assistant',
    body: 'Eleven sessions report as active. Nine of them are supersession records whose parent task already finalized.',
  },
  { id: 'm3', role: 'user', body: 'Can you prove that from the ledger rather than the task list?' },
  {
    id: 'm4',
    role: 'assistant',
    body: 'Yes. The ledger writes one row per handoff, so a superseded run keeps its original row and gains a `supersededBy` pointer. Counting distinct `rootTaskId` values where `supersededBy IS NULL` gives two live runs, which matches the two workspaces actually holding a node lease. The remaining nine rows all resolve to those same two roots, which is why the dashboard triple-counts: it counts rows, not roots. I can add the aggregate to the DO query so the count is computed where the rows live instead of in the worker.',
  },
  {
    id: 'm5',
    role: 'user',
    body: 'Do it, and add a regression test that would have caught the triple count.',
  },
  {
    id: 'm6',
    role: 'assistant',
    body: 'Running the test suite now — the aggregate is in place and the fixture seeds three supersessions for one root.',
  },
  { id: 'm7', role: 'user', body: 'What did resource usage look like while that suite ran?' },
  {
    id: 'm8',
    role: 'assistant',
    body: 'Peak RAM sat at 1.25 GB for the last ten minutes and one OOM was recorded. Open Resources to see the window.',
  },
  { id: 'm9', role: 'user', body: 'Opening it now.' },
  {
    id: 'm10',
    role: 'assistant',
    body: 'The spike lines up with the `pnpm typecheck` and `pnpm lint` windows running concurrently.',
  },
];
