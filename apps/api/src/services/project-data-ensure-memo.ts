/**
 * Per-isolate memo of ProjectData Durable Objects whose `projectId` has already
 * been persisted into their `do_meta` table by `ensureProjectId`.
 *
 * WHY THIS EXISTS
 * ---------------
 * A ProjectData DO is addressed with `idFromName(projectId)`, which is a one-way
 * digest: `DurableObjectId.toString()` returns a hex id, and there is no inverse
 * of `idFromName`. The DO constructor receives only `DurableObjectState` and
 * `Env`, so a DO genuinely **cannot** recover its own projectId. The
 * `do_meta.projectId` row written by `ProjectData.ensureProjectId` is the sole
 * source of that identity, and it is required by every consumer that runs with
 * no inbound RPC to thread the value from — the `alarm()` sweeps (idle cleanup,
 * reconciliation, stale-activity probe, task waits) and the debounced
 * `syncSummaryToD1` D1 write-back.
 *
 * So the ensure call cannot be deleted. What it does not need to be is *repeated*:
 * `do_meta` is durable DO SQLite storage and is never dropped or deleted anywhere
 * in `durable-objects/project-data/` (no `deleteAll()`, no `DELETE FROM do_meta`;
 * `migrations.ts` only ever `CREATE TABLE do_meta`). Once any caller has ensured a
 * given DO, the row survives DO eviction, hibernation and isolate recycling.
 *
 * This memo therefore records the durable fact "this DO has been ensured at least
 * once" so that only the first operation per (isolate, DO) pays the extra RPC
 * roundtrip instead of every single one.
 *
 * See: tasks/archive/2026-08-18-do-roundtrip-ensure-project-id-and-chat-agent-state.md
 */
import { parsePositiveInt } from '../lib/route-helpers';

/**
 * Upper bound on memo entries held by one isolate. Entries are ~64 bytes of hex
 * key, so the default caps the memo at roughly 128 KB even for a deployment with
 * thousands of active projects on a single warm isolate.
 */
export const DEFAULT_PROJECT_DATA_ENSURE_MEMO_MAX_ENTRIES = 2000;

export interface ProjectDataEnsureMemoEnv {
  PROJECT_DATA_ENSURE_MEMO_MAX_ENTRIES?: string;
}

/**
 * Insertion-ordered set of DO ids known to have a persisted projectId. `Map`
 * iteration order is insertion order, which gives FIFO eviction for free.
 */
const ensured = new Map<string, true>();

/** In-flight ensure calls, so concurrent first-callers issue exactly one RPC. */
const inFlight = new Map<string, Promise<void>>();

export function getProjectDataEnsureMemoMaxEntries(env: ProjectDataEnsureMemoEnv): number {
  return parsePositiveInt(
    env.PROJECT_DATA_ENSURE_MEMO_MAX_ENTRIES,
    DEFAULT_PROJECT_DATA_ENSURE_MEMO_MAX_ENTRIES
  );
}

/**
 * Run `ensure` exactly once per DO id for the lifetime of this isolate.
 *
 * Concurrent callers for the same id share a single in-flight promise. A
 * rejected ensure is not memoized, so the next caller retries it.
 */
export async function ensureOncePerIsolate(
  env: ProjectDataEnsureMemoEnv,
  doId: string,
  ensure: () => Promise<void>
): Promise<void> {
  if (ensured.has(doId)) return;

  const pending = inFlight.get(doId);
  if (pending) return pending;

  const run = (async () => {
    await ensure();
    remember(env, doId);
  })().finally(() => {
    inFlight.delete(doId);
  });

  inFlight.set(doId, run);
  return run;
}

function remember(env: ProjectDataEnsureMemoEnv, doId: string): void {
  const maxEntries = getProjectDataEnsureMemoMaxEntries(env);
  ensured.set(doId, true);
  while (ensured.size > maxEntries) {
    const oldest = ensured.keys().next();
    if (oldest.done) break;
    ensured.delete(oldest.value);
  }
}

/**
 * Drop the memoized fact for a DO id.
 *
 * Called when a DO RPC fails, so a Durable Object that was reset (code update,
 * eviction mid-flight) re-runs `ensureProjectId` on the next attempt rather than
 * relying on this isolate's belief about durable state it can no longer observe.
 */
export function forgetEnsuredProjectData(doId: string): void {
  ensured.delete(doId);
}

/** Test-only: reset isolate-local memo state between cases. */
export function resetProjectDataEnsureMemo(): void {
  ensured.clear();
  inFlight.clear();
}

/** Test-only: current memo size. */
export function projectDataEnsureMemoSize(): number {
  return ensured.size;
}
