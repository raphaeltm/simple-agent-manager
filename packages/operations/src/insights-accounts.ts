/**
 * Insights · Accounts (slice A, idea 01M7HTS38KX2G78JD0ESAGMKKH): which account carried a
 * project's runs over 7, 30 or 90 days, and where agents stalled on a usage limit. The one shared
 * read behind the Insights page's Accounts tab (policy 5cb362e8: every surface is a thin adapter).
 *
 * Everything is derived at read time; nothing is stored:
 * - runs and merges per account: Flow's run population (`runsCte`), each run attributed to the
 *   agent session of its workspace (`agent_sessions.agent_credential_*`);
 * - limit stalls: tasks' latest usage-limit waits (`tasks.provider_limit_wait_json`, both the
 *   mid-run pauses and the `provider_limit_waiting` admission holds) and the provider windows
 *   reported as rejected (`credential_limit_windows`), merged per account into episodes;
 * - limit meters: the provider's last-reported windows of the viewer's own accounts, the same
 *   summary the chat header's limit chip shows;
 * - spend: "not reported" for API keys until per-run usage is recorded (slice U).
 *
 * Round trips (rule 60, budget 6 in the Insights spec): authorization 1; settings 0 or 1 (the
 * per-isolate admin-settings cache); one D1 `batch()` carrying four statements 1; the viewer's own
 * limit windows 0 or 1 (one statement per 100 of their own accounts, so 1 in practice). At most 4;
 * measured at 3 in `insights-accounts.test.ts`. If the batch fails as a whole, each statement is
 * retried on its own so one bad section cannot blank the page; that rare degraded path costs four
 * more (at most 8 on a cold settings cache) and is logged.
 */
import { parseProviderLimitWait } from '@simple-agent-manager/scheduler-core';
import {
  credentialLimitReferenceKey,
  credentialLimitWindowLabel,
  DEFAULT_INSIGHTS_RANGE,
  type InsightsAccount,
  type InsightsAccountsSection,
  isInsightsRange,
  type ProjectAccountsResponse,
} from '@simple-agent-manager/shared';
import { log } from '@simple-agent-manager/worker-core';
import * as v from 'valibot';

import { authorizeProjectOperation } from './authorization';
import { OperationError } from './errors';
import {
  type AccountMeta,
  bucketStartOf,
  displayAccount,
  mergeMeta,
  mergeStallEpisodes,
  type StallInterval,
  waitInterval,
  windowInterval,
} from './insights-accounts-compute';
import {
  accountRunsStatement,
  ownLongCredentialsStatement,
  rejectedWindowsStatement,
  stallWaitsStatement,
} from './insights-accounts-sql';
import { parseInsightsRows, runInsightsBatch } from './insights-batch';
import { bucketStarts, flowWindow } from './insights-flow';
import { getInsightsPageLimits } from './insights-page-settings';
import type { OperationContext } from './types';

export interface ProjectAccountsInput {
  projectId: string;
  /** `7d`, `30d` or `90d`; omitted means `DEFAULT_INSIGHTS_RANGE`. */
  range?: unknown;
  /** Test seam: the instant the range ends at. */
  nowMs?: number;
}

const EVENT = 'insights_accounts';
type BatchKey = 'runs' | 'waits' | 'windows' | 'ownLong';
const SECTION_OF: Record<BatchKey, InsightsAccountsSection> = {
  runs: 'runs',
  waits: 'stalls',
  windows: 'stalls',
  // Only used to name the viewer's own digest-keyed accounts; losing it hides names, not data.
  ownLong: 'usage',
};
/** The largest epoch milliseconds a `Date` can hold: a larger stored value is a malformed row. */
const MAX_DATE_MS = 8_640_000_000_000_000;
const epochMs = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_DATE_MS));
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

const str = v.nullish(v.string());
const flag = v.nullish(v.number());
const META = {
  ref: str,
  source: str,
  agent_type: str,
  kind: str,
  cred_own: flag,
  session_own: flag,
  own_name: str,
};
const RunRowSchema = v.object({
  ...META,
  day: v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/)),
  runs: v.number(),
  merged: flag,
});
const WaitRowSchema = v.object({
  ...META,
  task_id: v.string(),
  status: v.string(),
  completed_at: str,
  updated_at: str,
  admission_state: str,
  wait_json: v.string(),
});
const WindowRowSchema = v.object({
  ...META,
  ref: v.pipe(v.string(), v.minLength(1)),
  window_type: v.string(),
  window_minutes: flag,
  observed_at: epochMs,
  resets_at: v.nullish(epochMs),
});
const OwnLongCredentialSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  name: v.string(),
  kind: v.string(),
});

interface MetaRow {
  source?: string | null;
  agent_type?: string | null;
  kind?: string | null;
  cred_own?: number | null;
  session_own?: number | null;
  own_name?: string | null;
}

function meta(row: MetaRow, limitKey: string | null, reference: string | null): AccountMeta {
  return {
    limitKey,
    reference,
    source: row.source ?? null,
    agentType: row.agent_type ?? null,
    kind: row.kind ?? null,
    credOwn: row.cred_own ?? null,
    sessionOwn: row.session_own ?? null,
    ownName: row.own_name ?? null,
  };
}

export async function projectAccounts(
  ctx: OperationContext,
  input: ProjectAccountsInput
): Promise<ProjectAccountsResponse> {
  const projectId = typeof input.projectId === 'string' ? input.projectId.trim() : '';
  const range = input.range === undefined ? DEFAULT_INSIGHTS_RANGE : input.range;
  if (!isInsightsRange(range)) {
    throw new OperationError('invalid_input', 'range must be one of 7d, 30d, 90d');
  }
  await authorizeProjectOperation(ctx, projectId);
  const limits = await getInsightsPageLimits(ctx);
  const nowMs = input.nowMs ?? Date.now();
  const w = flowWindow(projectId, range, nowMs);
  const viewerId = ctx.actor.userId;
  const cap = limits.accountsStallScanCap;

  const unavailable = new Set<InsightsAccountsSection>();
  const rows = await runInsightsBatch<BatchKey>(
    ctx,
    'insights_accounts',
    projectId,
    {
      runs: accountRunsStatement(w, viewerId),
      waits: stallWaitsStatement(w, viewerId, cap),
      windows: rejectedWindowsStatement(w, viewerId, cap),
      ownLong: ownLongCredentialsStatement(viewerId),
    },
    (key, error) => {
      log.error('insights_accounts.section_failed', {
        projectId,
        section: SECTION_OF[key],
        error: error instanceof Error ? error.message : String(error),
        action: 'section_unavailable',
      });
      unavailable.add(SECTION_OF[key]);
    }
  );

  // The viewer's own credentials that waits and windows know only by digest key.
  const ownByDigest = new Map<string, AccountMeta>();
  const ownLong = parseInsightsRows(
    rows.ownLong,
    OwnLongCredentialSchema,
    EVENT,
    'own_long',
    projectId
  );
  await Promise.all(
    ownLong.map(async (row) => {
      const reference = `cc_credentials:${row.id}`;
      const key = await credentialLimitReferenceKey(reference);
      if (!key) return;
      ownByDigest.set(key, {
        limitKey: key,
        reference,
        source: null,
        agentType: null,
        kind: row.kind,
        credOwn: 1,
        sessionOwn: 1,
        ownName: row.name,
      });
    })
  );

  const metaByKey = new Map<string, AccountMeta>();
  const remember = (m: AccountMeta) => {
    const key = m.limitKey ?? `none:${m.source ?? ''}:${m.agentType ?? ''}`;
    const own = m.limitKey ? ownByDigest.get(m.limitKey) : undefined;
    // A row's own identity fields win; the digest lookup fills what the SQL join could not.
    const resolved = own ? mergeMeta(m, own) : m;
    metaByKey.set(key, mergeMeta(metaByKey.get(key), resolved));
    return key;
  };

  // Runs, per account and day.
  const runRows = parseInsightsRows(rows.runs, RunRowSchema, EVENT, 'runs', projectId);
  const runKeys = await Promise.all(runRows.map((row) => credentialLimitReferenceKey(row.ref)));
  const runsByKey = new Map<string, Array<{ day: string; runs: number; merged: number }>>();
  runRows.forEach((row, index) => {
    const key = remember(meta(row, runKeys[index] ?? null, row.ref ?? null));
    const list = runsByKey.get(key) ?? [];
    list.push({ day: row.day, runs: row.runs, merged: row.merged ?? 0 });
    runsByKey.set(key, list);
  });

  // Stall intervals: tasks' limit waits, then rejected windows.
  const intervals: StallInterval[] = [];
  const waitRows = parseInsightsRows(
    rows.waits,
    WaitRowSchema,
    EVENT,
    'stall_wait',
    projectId,
    'task_id'
  );
  for (const row of waitRows.slice(0, cap)) {
    const wait = parseProviderLimitWait(row.wait_json);
    if (!wait) {
      skipped(projectId, 'stall_wait', row.task_id, 'unparseable provider_limit_wait_json');
      continue;
    }
    const terminal = TERMINAL.has(row.status);
    const ended = Date.parse(row.completed_at ?? row.updated_at ?? '');
    const interval = waitInterval(
      wait,
      {
        id: row.task_id,
        terminal,
        endedAtMs: Number.isFinite(ended) ? ended : null,
        // Every park writes this state and every release clears it: the live "still waiting".
        waitingNow: row.admission_state === 'provider_limit_waiting',
      },
      nowMs
    );
    if (!interval) continue;
    remember(meta(row, interval.limitKey, null));
    intervals.push(interval);
  }
  const windowRows = parseInsightsRows(
    rows.windows,
    WindowRowSchema,
    EVENT,
    'rejected_window',
    projectId
  );
  for (const row of windowRows.slice(0, cap)) {
    remember(meta(row, row.ref, null));
    intervals.push(
      windowInterval(
        {
          limitKey: row.ref,
          observedAt: row.observed_at,
          resetsAt: row.resets_at ?? null,
          windowMinutes: row.window_minutes ?? null,
          window: credentialLimitWindowLabel(row.window_type, row.window_minutes ?? null),
        },
        nowMs
      )
    );
  }
  const episodes = mergeStallEpisodes(intervals);

  // Display rows: the viewer's own credentials one each, everyone else's grouped by kind.
  const buckets = bucketStarts(w);
  const bucketIndex = new Map(buckets.map((start, index) => [start, index]));
  const accounts = new Map<string, InsightsAccount & { limitKeys: Set<string> }>();
  const ownReferences = new Map<string, string>();
  const displayKeyOf = new Map<string, string>();
  for (const [key, m] of metaByKey) {
    const display = displayAccount(m);
    displayKeyOf.set(key, display.key);
    if (display.ownReference) ownReferences.set(display.ownReference, display.key);
    const account = accounts.get(display.key) ?? {
      key: display.key,
      name: display.name,
      owner: display.owner,
      kind: display.kind,
      agentType: display.agentType,
      credentials: 0,
      runs: 0,
      merged: 0,
      runsByBucket: buckets.map(() => 0),
      stalls: { episodes: 0, totalMs: 0, ongoing: false },
      usage: null,
      spend: display.kind === 'api_key' ? { state: 'not_reported' as const } : null,
      limitKeys: new Set<string>(),
    };
    if (!key.startsWith('none:')) account.limitKeys.add(key);
    for (const entry of runsByKey.get(key) ?? []) {
      account.runs += entry.runs;
      account.merged += entry.merged;
      const index = bucketIndex.get(bucketStartOf(entry.day, w.bucket));
      if (index !== undefined)
        account.runsByBucket[index] = (account.runsByBucket[index] ?? 0) + entry.runs;
    }
    accounts.set(display.key, account);
  }
  for (const episode of episodes) {
    const account = accounts.get(displayKeyOf.get(episode.limitKey) ?? '');
    if (!account) continue;
    account.stalls.episodes += 1;
    account.stalls.totalMs += episode.endMs - episode.startMs;
    if (episode.outcome !== 'resumed' && episode.endMs >= nowMs) account.stalls.ongoing = true;
  }

  await attachUsage(ctx, projectId, viewerId, ownReferences, accounts, unavailable);

  const list = [...accounts.values()]
    .map(({ limitKeys, ...account }) => ({
      ...account,
      credentials: account.owner === 'not_recorded' ? 0 : Math.max(1, limitKeys.size),
    }))
    .filter((account) => account.runs > 0 || account.stalls.episodes > 0)
    .sort(
      (a, b) =>
        b.runs - a.runs || b.stalls.episodes - a.stalls.episodes || a.key.localeCompare(b.key)
    );
  const listed = limits.accountsEpisodesListed;

  return {
    projectId,
    range,
    since: w.since,
    until: new Date(nowMs).toISOString(),
    bucket: w.bucket,
    buckets,
    accounts: list,
    stallEpisodes: {
      items: episodes.slice(0, listed).map((episode) => ({
        accountKey: displayKeyOf.get(episode.limitKey) ?? 'not_recorded',
        window: episode.windows.length > 0 ? episode.windows.join(', ') : null,
        startedAt: new Date(episode.startMs).toISOString(),
        endedAt: new Date(episode.endMs).toISOString(),
        durationMs: episode.endMs - episode.startMs,
        runs: episode.runs,
        outcome: episode.outcome,
      })),
      total: episodes.length,
      listed,
      truncated: (rows.waits?.length ?? 0) > cap || (rows.windows?.length ?? 0) > cap,
    },
    totals: {
      runs: list.reduce((sum, account) => sum + account.runs, 0),
      merged: list.reduce((sum, account) => sum + account.merged, 0),
    },
    unavailable: [...unavailable],
    generatedAt: new Date().toISOString(),
  };
}

/** The viewer's own accounts' last-reported limit windows; a failed read marks only `usage`. */
async function attachUsage(
  ctx: OperationContext,
  projectId: string,
  viewerId: string,
  ownReferences: ReadonlyMap<string, string>,
  accounts: ReadonlyMap<string, InsightsAccount>,
  unavailable: Set<InsightsAccountsSection>
): Promise<void> {
  if (ownReferences.size === 0) return;
  try {
    const limits = await ctx.ports.account.listOwnCredentialLimitsByReferences(viewerId, [
      ...ownReferences.keys(),
    ]);
    for (const summary of limits.credentials) {
      const account = accounts.get(ownReferences.get(summary.credentialReference) ?? '');
      if (account && !account.usage) account.usage = summary;
    }
  } catch (error) {
    log.error('insights_accounts.section_failed', {
      projectId,
      section: 'usage',
      error: error instanceof Error ? error.message : String(error),
      action: 'section_unavailable',
    });
    unavailable.add('usage');
  }
}

function skipped(projectId: string, context: string, rowId: string, issue: string): void {
  log.error('insights_accounts.row_skipped', {
    projectId,
    context,
    rowId,
    issue,
    action: 'skipped',
  });
}
