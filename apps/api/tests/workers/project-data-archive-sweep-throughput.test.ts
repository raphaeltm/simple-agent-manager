/**
 * The sweep message budget is a SELECTION PREDICATE, not just a pacing knob.
 *
 * `selectCandidates` binds `config.sweepMessageCeiling` into `AND ss.message_count <= ?`
 * whenever `PROJECT_DATA_ARCHIVE_COMPACT_ENABLED` is `true`, so a session larger than the
 * budget is not deferred — it is invisible to every tick for as long as the budget stands.
 * Both cases here drive the real `runProjectDataArchiveSharding` against real DO SQLite, real
 * D1 and the real R2 binding. Neither tells the sweep which candidate to take: selection,
 * estimation, reservation, chunking and the source-deletion proof all run for themselves
 * (`.claude/rules/62`).
 *
 * What "it archived" is asserted to mean here is deliberately strict, because the weaker
 * form — a non-empty hash, a chunk count and a zero source count — is satisfied by an archive
 * that lost or reordered the transcript. Each case reads the whole conversation back through
 * the production service path (`projectDataService.getMessages`, which resolves the archive
 * shard via `resolveExactReadOwner`) and compares it to what was seeded, id for id, in order,
 * with content and tool payloads intact, then exercises search over the archived copy.
 *
 * Fixtures use production-shaped payloads rather than uniform tiny rows: assistant turns carry
 * multi-KB bodies, a minority of rows are tool calls with JSON `toolMetadata`, and consecutive
 * same-role runs exist so `chat_messages_grouped` is actually populated. Uniform 20-byte
 * alternating rows would put the chunker on different byte and row boundaries than production
 * and would understate the write estimate that gates the reservation.
 *
 * Bodies are deterministic but VARIED, not a repeated character. `'a'.repeat(2048)` gzips to
 * almost nothing, which would shrink every R2 chunk and understate both the compression cost
 * and the bytes moved — the opposite of what a capacity fixture should do.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { Env as WorkerEnv } from '../../src/env';
import { runProjectDataArchiveSharding } from '../../src/scheduled/project-data-archive-sharding';
import * as projectDataService from '../../src/services/project-data';
import {
  PREVIOUS_SWEEP_MESSAGE_BUDGET,
  SHIPPED_SWEEP_MESSAGE_BUDGET,
  SHIPPED_SWEEP_SESSIONS,
  SWEEP_CEILING_EXPERIMENT,
} from '../helpers/archive-sweep-ceiling';
import {
  isolateSweepFixture,
  projectDataStub,
  readLocation,
  withArchiveEnv,
} from './helpers/archive-fixtures';
import { seedInstallation, seedProject, seedUser } from './helpers/seed-d1';
import type { ProjectDataTestDouble } from './support/expected-error-doubles';

const testEnv = env as unknown as WorkerEnv;
const OWNER = 'archive-throughput-owner';
const INSTALLATION = 'archive-throughput-installation';

/** Liveness control: comfortably under every budget, so it moves whatever the ceiling is. */
const SMALL_MESSAGE_COUNT = 40;

/** Every 7th row is a tool call, so tool payloads travel with the transcript. */
const TOOL_EVERY = 7;

type SeededMessage = {
  messageId: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolMetadata: string | null;
  timestamp: string;
  sequence: number;
};

/**
 * Deterministic pseudo-random prose, seeded per row.
 *
 * A repeated character compresses roughly a thousand to one; real agent output compresses
 * about three or four to one. Using the former would let every chunk hold far more rows than
 * production and quietly turn a capacity fixture into a trivial one. A tiny LCG over a small
 * vocabulary is reproducible across runs (so failures are debuggable) while still producing
 * entropy in the range gzip actually sees.
 */
const VOCAB = [
  'workspace', 'session', 'archive', 'chunk', 'migration', 'durable', 'object', 'storage',
  'reclaim', 'ceiling', 'budget', 'candidate', 'transcript', 'sweep', 'shard', 'manifest',
];

function variedBody(seed: number, approxBytes: number): string {
  let state = (seed * 2_654_435_761) % 2_147_483_647;
  const words: string[] = [];
  let length = 0;
  while (length < approxBytes) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_647;
    const word = VOCAB[state % VOCAB.length];
    const suffix = state % 97;
    words.push(`${word}${suffix}`);
    length += word.length + 3;
  }
  return words.join(' ');
}

/**
 * Production-shaped rows: a short user turn, then a run of two long assistant turns (so
 * grouping has consecutive same-role rows to merge), with a tool call carrying real JSON
 * every `TOOL_EVERY` rows. Assistant bodies are ~2 KB, which is the order of magnitude the
 * production `r2-gzip-v1` chunker sees; the 2 MiB compact chunk cap and the 500-row cap then
 * both matter, as they do in production.
 */
function messagesFor(prefix: string, count: number): SeededMessage[] {
  return Array.from({ length: count }, (_, index) => {
    const isTool = index % TOOL_EVERY === TOOL_EVERY - 1;
    const isUser = index % 3 === 0;
    if (isTool) {
      return {
        messageId: `${prefix}-${String(index).padStart(5, '0')}`,
        role: 'tool' as const,
        content: `${prefix} tool call ${index}`,
        toolMetadata: JSON.stringify({
          title: `Read file ${index}`,
          content: [{ type: 'text', text: `${prefix} tool result ${index} ${variedBody(index * 7 + 1, 400)}` }],
        }),
        timestamp: new Date(3_000_000 + index * 1_000).toISOString(),
        sequence: index + 1,
      };
    }
    return {
      messageId: `${prefix}-${String(index).padStart(5, '0')}`,
      role: isUser ? ('user' as const) : ('assistant' as const),
      content: isUser
        ? `${prefix} user turn ${index}`
        : `${prefix} assistant turn ${index} ${variedBody(index, 2_048)}`,
      toolMetadata: null,
      timestamp: new Date(3_000_000 + index * 1_000).toISOString(),
      sequence: index + 1,
    };
  });
}

async function seedTerminalSession(
  source: DurableObjectStub<ProjectDataTestDouble>,
  prefix: string,
  count: number
): Promise<{ sessionId: string; messageCount: number; seeded: SeededMessage[] }> {
  const sessionId = await source.createSession(null, prefix);
  const seeded = messagesFor(prefix, count);
  // Persist in slices: one full-session RPC argument exceeds the DO RPC size budget.
  for (let offset = 0; offset < seeded.length; offset += 250) {
    await source.persistMessageBatch(sessionId, seeded.slice(offset, offset + 250));
  }
  await source.stopSession(sessionId);
  await source.runSummarySyncForTest();
  const row = await env.DATABASE.prepare(
    'SELECT message_count FROM session_summaries WHERE id = ?'
  )
    .bind(sessionId)
    .first<{ message_count: number }>();
  if (!row) throw new Error(`No session_summaries row for ${prefix}`);
  return { sessionId, messageCount: row.message_count, seeded };
}

/**
 * The shipped production shape, minus the budget under test. The grace period and cadence are
 * the deliberate divergences: production holds sessions for 7 days and sweeps hourly, and a
 * test cannot wait for either.
 */
function sweepEnv(messageBudget: number) {
  return {
    PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
    PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED: 'true',
    PROJECT_DATA_ARCHIVE_COMPACT_ENABLED: 'true',
    PROJECT_DATA_ARCHIVE_SESSION_GRACE_MS: '1',
    PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_INTERVAL_MS: '1',
    PROJECT_DATA_ARCHIVE_SWEEP_PROJECTS: '1',
    PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS: String(SHIPPED_SWEEP_SESSIONS),
    PROJECT_DATA_ARCHIVE_SWEEP_MESSAGE_BUDGET: String(messageBudget),
    PROJECT_DATA_ARCHIVE_SWEEP_UNIT_OVERHEAD_PERCENT: '100',
    PROJECT_DATA_ARCHIVE_WRITE_ESTIMATE_FACTOR: '2',
    PROJECT_DATA_ARCHIVE_DAILY_WRITE_BUDGET: '800000',
    PROJECT_DATA_ARCHIVE_CHUNK_ROWS: '500',
  };
}

async function countTargetRawChunks(ownerName: string, sessionId: string): Promise<number> {
  const target = projectDataStub(ownerName);
  return runInDurableObject(target, async (_instance, state) =>
    Number(
      state.storage.sql
        .exec(
          'SELECT COUNT(*) AS n FROM project_data_archive_raw_chunks WHERE session_id = ?',
          sessionId
        )
        .toArray()[0]?.n ?? 0
    )
  );
}

/**
 * Bytes the root object's own SQLite reports.
 *
 * `getMessageCount(...) === 0` proves the ROWS were deleted; it says nothing about whether
 * the object gave the space back. workerd's `getDatabaseSize` (`src/workerd/api/sql.c++`)
 * subtracts `pragma_freelist_count` from `page_count` before multiplying by the page size, so
 * this does fall when pages are freed — the same metric `project_data_storage_telemetry` reports
 * in production, which is what makes a before/after comparison here meaningful rather than
 * decorative.
 */
async function databaseSizeBytes(ownerName: string): Promise<number> {
  const stub = projectDataStub(ownerName);
  return runInDurableObject(stub, async (_instance, state) => Number(state.storage.sql.databaseSize));
}

/**
 * Read the whole conversation back through the production service path, oldest first, PAGING
 * the way a client has to.
 *
 * A single-call read is not an option and the failure is instructive: a 20000-message session
 * with production-shaped bodies exceeds the Durable Object RPC serialization budget, and
 * `messages.rpc_size_guard_truncated` silently trims the page (observed at 12,035 of 20,000
 * rows / 31.4 MB). That guard is the documented behaviour of `.claude/rules/50`, not an
 * archive defect — but a test that asked for everything at once would have mistaken it for
 * data loss. `after` is a real cursor (keyed on `createdAt`), so unlike an offset it can
 * resume the trimmed tail.
 */
const TRANSCRIPT_PAGE_LIMIT = 2_000;

async function readArchivedTranscript(projectId: string, sessionId: string, expected: number) {
  const rows: Record<string, unknown>[] = [];
  let after: number | null = null;
  // Bounded so a cursor that stops advancing fails the test instead of hanging the suite.
  for (let page = 0; page <= Math.ceil(expected / TRANSCRIPT_PAGE_LIMIT) + 1; page += 1) {
    const result = await projectDataService.getMessages(
      testEnv,
      projectId,
      sessionId,
      TRANSCRIPT_PAGE_LIMIT,
      null,
      after,
      undefined,
      false,
      'asc'
    );
    if (result.messages.length === 0) return rows;
    rows.push(...result.messages);
    const last = result.messages.at(-1);
    const next = Number(last?.createdAt);
    if (!Number.isFinite(next) || next === after) return rows;
    after = next;
  }
  throw new Error(`transcript paging did not terminate for ${sessionId}`);
}

/**
 * The assertion that makes "archived" mean "the conversation survived".
 *
 * Compares the post-archive read against the seeded transcript id for id, in order, with
 * content and tool payloads. A hash-only or count-only check passes for an archive that
 * dropped the middle of a session or reordered it; this does not.
 *
 * SCOPE, because this is the strongest claim in the file and it is narrower than it looks:
 * it holds for transcripts whose rows have DISTINCT `created_at`, which is all this fixture
 * can produce (`messagesFor` spaces timestamps 1000 ms apart). Both read paths filter the
 * `after` cursor on `created_at` alone — `matchesRawPage` in `compact-archive.ts` and the
 * `AND created_at > ?` in `messages.ts` — so rows SHARING a `created_at` across a page
 * boundary are dropped from every later page. That is a pre-existing read-pagination defect,
 * not something this change introduces, and it is tracked in
 * `tasks/backlog/2026-09-20-message-pagination-drops-tied-timestamps.md`. Do not read a green
 * run here as proof that tied timestamps survive; no fixture here can falsify that.
 */
async function expectTranscriptPreserved(
  projectId: string,
  sessionId: string,
  seeded: SeededMessage[]
): Promise<void> {
  const read = await readArchivedTranscript(projectId, sessionId, seeded.length);

  expect(read).toHaveLength(seeded.length);
  expect(read.map((row) => String(row.id))).toEqual(seeded.map((message) => message.messageId));
  expect(read.map((row) => String(row.role))).toEqual(seeded.map((message) => message.role));
  expect(read.map((row) => String(row.content))).toEqual(seeded.map((message) => message.content));

  // Tool payloads travel with the transcript rather than being dropped on the way to R2.
  //
  // The count assertion covers every tool row; the payload fetch samples FIRST, MIDDLE and LAST
  // rather than all of them. That is a deliberate bound, not full coverage: one R2 read per tool
  // would be thousands of reads for a ceiling-sized session. Three samples spanning the whole
  // session cross distinct chunks (chunks hold at most CHUNK_ROWS=500 rows), so a chunk-boundary
  // defect that dropped or misordered payloads in the middle of the session is still caught.
  const seededTools = seeded.filter((message) => message.toolMetadata !== null);
  expect(seededTools.length).toBeGreaterThan(0);
  const readTools = read.filter((row) => row.role === 'tool');
  expect(readTools).toHaveLength(seededTools.length);

  const sampledTools = [
    seededTools[0],
    seededTools[Math.floor(seededTools.length / 2)],
    seededTools[seededTools.length - 1],
  ];
  // The samples must genuinely land in different chunks, or "first/middle/last" proves nothing
  // more than "first" does. Chunks hold at most CHUNK_ROWS=500 rows, so a session spanning more
  // than two chunks puts its first, middle and last rows in three distinct ones.
  expect(seeded.length).toBeGreaterThan(2 * 500);
  for (const tool of sampledTools) {
    const archived = await projectDataService.getMessageToolContent(
      testEnv,
      projectId,
      sessionId,
      tool.messageId
    );
    expect(archived).toMatchObject({
      content: JSON.parse(tool.toolMetadata as string).content,
    });
  }

  // Search resolves through the archive shard, session-scoped and project-wide.
  const { results: scoped } = await projectDataService.searchMessagesWithArchiveMetadata(
    testEnv,
    projectId,
    'assistant',
    sessionId
  );
  expect(scoped.length).toBeGreaterThan(0);
  const { results: projectWide } = await projectDataService.searchMessagesWithArchiveMetadata(
    testEnv,
    projectId,
    'assistant'
  );
  expect(projectWide.some((row) => row.sessionId === sessionId)).toBe(true);
}

async function newArchiveProject(prefix: string) {
  const projectId = `${prefix}-${crypto.randomUUID()}`;
  await seedUser(OWNER);
  await seedInstallation(INSTALLATION, OWNER);
  await seedProject(projectId, OWNER, INSTALLATION, { name: `Archive Throughput ${projectId}` });
  const source = projectDataStub(projectId);
  await source.ensureProjectId(projectId);
  return { projectId, source };
}

/**
 * One fixture, two ticks of the real sweep, differing only in the budget. Returns the
 * source object's database size before and after so the caller can assert physical reclaim.
 */
async function runCeilingCase(prefix: string, ceiling: number) {
  const { projectId, source } = await newArchiveProject(prefix);
  const band = await seedTerminalSession(source, `${prefix}-band`, ceiling);
  const small = await seedTerminalSession(source, `${prefix}-small`, SMALL_MESSAGE_COUNT);
  await isolateSweepFixture(projectId, { clearCadence: true });

  // Fixture preconditions. Without these the pair could stop discriminating — if the band
  // session ever fell under the previous budget, the first tick would migrate it.
  expect(band.messageCount).toBe(ceiling);
  expect(band.messageCount).toBeGreaterThan(PREVIOUS_SWEEP_MESSAGE_BUDGET);
  expect(small.messageCount).toBe(SMALL_MESSAGE_COUNT);

  // --- Tick 1: the previous budget. The band session is excluded by the SQL ceiling. ---
  await withArchiveEnv(sweepEnv(PREVIOUS_SWEEP_MESSAGE_BUDGET), async () => {
    const stats = await runProjectDataArchiveSharding(testEnv, new Date(Date.now() + 60_000));

    expect(stats).toMatchObject({ skipped: false, failed: 0 });
    expect(stats.messageCeiling).toBe(PREVIOUS_SWEEP_MESSAGE_BUDGET);
    // Absence: the band session did not move and is still readable in root.
    expect(await readLocation(projectId, band.sessionId)).toBeNull();
    expect(await source.getMessageCount(band.sessionId)).toBe(ceiling);
    // Liveness beside it (`.claude/rules/62`): the tick was not merely dead. It selected,
    // reserved and published the one candidate the ceiling did admit.
    expect(stats.migrated).toBe(1);
    expect(await readLocation(projectId, small.sessionId)).toMatchObject({
      location_state: 'archive_shard',
    });
    // The exclusion is the SELECTOR, not the write budget: the band session never reached
    // `reserveArchiveWrites`, so no refusal was recorded for it.
    expect(stats.budgetUnaffordable).toBe(0);
    expect(stats.budgetWindowExhausted).toBe(0);
  });

  // --- Tick 2: the larger budget, same fixture. Only the budget changed. ---
  //
  // The retrieval assertions run INSIDE this block on purpose. `resolveExactReadOwner` is
  // gated on `PROJECT_DATA_ARCHIVE_SHARDING_ENABLED`, so reading outside it routes back to
  // the root object and fails closed on the source's archive intent — which is a fixture
  // artefact, not a product behaviour. Production always has the flag on when it reads an
  // archived session, so the assertions belong where the flag is on (`.claude/rules/62`).
  const sizeBefore = await databaseSizeBytes(projectId);
  const startedAt = Date.now();
  const result = await withArchiveEnv(sweepEnv(ceiling), async () => {
    const stats = await runProjectDataArchiveSharding(testEnv, new Date(Date.now() + 120_000));
    const elapsedMs = Date.now() - startedAt;

    expect(stats).toMatchObject({ skipped: false, migrated: 1, failed: 0, refused: 0 });
    expect(stats.messageCeiling).toBe(ceiling);

    const resolved = await readLocation(projectId, band.sessionId);
    expect(resolved).toMatchObject({ location_state: 'archive_shard' });
    // Published means the whole state machine ran: intent, chunk copy, seal, recovery
    // manifest, source deletion proof, publish. An aggregate hash only exists after seal.
    expect(resolved?.target_aggregate_sha256).toMatch(/^[0-9a-f]{64}$/);
    // Chunked rather than moved in one oversized RPC.
    expect(
      await countTargetRawChunks(resolved?.owner_name ?? '', band.sessionId)
    ).toBeGreaterThanOrEqual(ceiling / 500);

    // The rows left the source object...
    expect(await source.getMessageCount(band.sessionId)).toBe(0);
    // ...and the conversation is intact on the other side, read the way the app reads it.
    await expectTranscriptPreserved(projectId, band.sessionId, band.seeded);
    // ...and the small session archived in tick 1 was not disturbed.
    expect(await readLocation(projectId, small.sessionId)).toMatchObject({
      location_state: 'archive_shard',
    });

    return { elapsedMs, location: resolved };
  });

  return {
    projectId,
    sizeBefore,
    sizeAfter: await databaseSizeBytes(projectId),
    elapsedMs: result.elapsedMs,
    location: result.location,
  };
}

describe('archive sweep message budget as a selection ceiling', () => {
  it(
    'hides a session above the previous budget and archives it intact at the shipped ceiling',
    async () => {
      const result = await runCeilingCase('shipped', SHIPPED_SWEEP_MESSAGE_BUDGET);

      // Physical reclaim, not just row deletion. `getMessageCount === 0` is satisfied by a
      // delete that never returned pages; `databaseSize` subtracts the freelist, so this
      // asserts the root object actually shrank — the property production is buying.
      expect(result.sizeAfter).toBeLessThan(result.sizeBefore);
    },
    180_000
  );

  /**
   * EXPERIMENT, not a claim about shipped config.
   *
   * 20000 is ~4x the largest compact (`r2-gzip-v1`) session production had ever published
   * (4,994 as of 2026-09-20). This case exists so a later promotion of the shipped ceiling
   * rests on evidence that the state machine stays correct at that size — roughly 40 R2
   * chunks, a seal read-back over all of them, and a source deletion proof.
   *
   * It does NOT license the promotion on its own. workerd under Miniflare has no Cloudflare
   * CPU accounting and no real R2 latency, so this says nothing about the deployed tick's
   * `cpu_ms` or wall clock. Those have to come from a real compact-path run.
   */
  it(
    'keeps a 20000-message session correct end to end (experiment, above the shipped ceiling)',
    async () => {
      expect(SWEEP_CEILING_EXPERIMENT).toBeGreaterThan(SHIPPED_SWEEP_MESSAGE_BUDGET);

      const result = await runCeilingCase('experiment', SWEEP_CEILING_EXPERIMENT);

      expect(result.sizeAfter).toBeLessThan(result.sizeBefore);
      // Recorded for the rollout evidence, not asserted as a production bound: Miniflare
      // timings are not Cloudflare timings.
      console.log(
        `[archive-throughput] ${SWEEP_CEILING_EXPERIMENT}-message migration: ` +
          `${result.elapsedMs} ms local, root databaseSize ${result.sizeBefore} -> ${result.sizeAfter} bytes`
      );
    },
    300_000
  );
});
