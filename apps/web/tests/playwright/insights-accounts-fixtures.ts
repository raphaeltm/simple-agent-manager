/**
 * Insights · Accounts responses for the visual audit, shaped exactly as `projectAccounts`
 * answers. Scenes: a realistic month (your subscription and API key, a teammate group, the
 * platform, an ongoing and a blocked stall), a stressed project (long and hostile names, eight
 * accounts so the chart folds into "Other", 13 weeks, many stalls and a capped scan), and an
 * empty project.
 */
import type {
  CredentialLimitCredentialSummary,
  InsightsAccount,
  InsightsRange,
  InsightsStallEpisode,
  ProjectAccountsResponse,
} from '@simple-agent-manager/shared';

export type AccountsScene =
  | 'realistic'
  | 'stress'
  | 'empty'
  | 'partial'
  | 'tokens-failed'
  | 'admission-hit'
  | 'admission-other-account';

const DAY = 86_400_000;
const MIN = 60_000;
const DAYS: Record<InsightsRange, number> = { '7d': 7, '30d': 30, '90d': 90 };

function bucketStarts(range: InsightsRange, now: number): string[] {
  const days = DAYS[range];
  const first = new Date(new Date(now - days * DAY).toISOString().slice(0, 10) + 'T00:00:00Z');
  const weekly = range !== '7d';
  if (weekly) first.setUTCDate(first.getUTCDate() - ((first.getUTCDay() + 6) % 7));
  const out: string[] = [];
  for (let t = first.getTime(); t <= now; t += (weekly ? 7 : 1) * DAY) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

function usage(
  name: string,
  now: number,
  fiveHour: number,
  week: number
): CredentialLimitCredentialSummary {
  const window = (windowType: string, windowMinutes: number, used: number, resetsIn: number) => ({
    windowType,
    provider: 'anthropic',
    source: 'claude-acp.rate_limit',
    status: used >= 100 ? ('rejected' as const) : ('allowed' as const),
    level:
      used >= 100 ? ('rejected' as const) : used >= 80 ? ('warning' as const) : ('ok' as const),
    utilizationPercent: used,
    limitAmount: null,
    remainingAmount: null,
    windowMinutes,
    resetsAt: now + resetsIn,
    observedAt: now - 20 * MIN,
    updatedAt: now - 20 * MIN,
    resetElapsed: false,
  });
  return {
    credentialReference: 'cc_credentials:cc-max',
    credentialId: 'cc-max',
    credentialName: name,
    credentialSource: 'user',
    provider: 'anthropic',
    providerMode: 'direct',
    agentType: 'claude-code',
    level: fiveHour >= 80 || week >= 80 ? 'warning' : 'ok',
    observedAt: now - 20 * MIN,
    windows: [
      window('claude.five_hour', 300, fiveHour, 2 * 60 * MIN),
      window('claude.seven_day', 10080, week, 3 * DAY),
    ],
  } as CredentialLimitCredentialSummary;
}

function account(
  fields: Partial<InsightsAccount> & Pick<InsightsAccount, 'key'>,
  buckets: number
): InsightsAccount {
  return {
    name: null,
    owner: 'you',
    kind: 'subscription',
    agentType: 'claude-code',
    credentials: 1,
    runs: 0,
    merged: 0,
    runsByBucket: Array.from({ length: buckets }, () => 0),
    stalls: { episodes: 0, totalMs: 0, ongoing: false },
    usage: null,
    tokens: null,
    spend: null,
    ...fields,
  };
}

/** Spread `total` runs over the buckets with a weekday rhythm, deterministic. */
function spread(total: number, buckets: number, seed: number): number[] {
  const weights = Array.from({ length: buckets }, (_, i) => 1 + ((i * 7 + seed * 3) % 5));
  const sum = weights.reduce((a, b) => a + b, 0);
  const out = weights.map((w) => Math.floor((w / sum) * total));
  out[out.length - 1] = (out[out.length - 1] ?? 0) + total - out.reduce((a, b) => a + b, 0);
  return out;
}

function episode(
  accountKey: string,
  startAgo: number,
  durationMs: number,
  fields: Partial<InsightsStallEpisode>,
  now: number
): InsightsStallEpisode {
  return {
    accountKey,
    window: '5h',
    startedAt: new Date(now - startAgo).toISOString(),
    endedAt: new Date(now - startAgo + durationMs).toISOString(),
    durationMs,
    runs: 1,
    outcome: 'resumed',
    ...fields,
  };
}

export function makeAccounts(
  projectId: string,
  range: InsightsRange,
  scene: AccountsScene,
  now = Date.now()
): ProjectAccountsResponse {
  const starts = bucketStarts(range, now);
  const n = starts.length;
  const base = {
    projectId,
    range,
    since: new Date(now - DAYS[range] * DAY).toISOString(),
    until: new Date(now).toISOString(),
    bucket: range === '7d' ? ('day' as const) : ('week' as const),
    buckets: starts,
    usageLimited: false,
    unavailable: [],
    generatedAt: new Date(now).toISOString(),
  };
  if (scene === 'admission-other-account') {
    return { ...makeAccounts(projectId, range, 'realistic', now), usageAdmissionLimited: true };
  }
  if (scene === 'partial') {
    // The stall reads failed this time: the accounts still show, the stall list says so.
    const realistic = makeAccounts(projectId, range, 'realistic', now);
    return {
      ...realistic,
      accounts: realistic.accounts.map((a) => ({
        ...a,
        stalls: { episodes: 0, totalMs: 0, ongoing: false },
      })),
      stallEpisodes: { items: [], total: 0, listed: 10, truncated: false },
      unavailable: ['stalls'],
    };
  }
  if (scene === 'tokens-failed') {
    // The token usage read failed this time: runs and stalls still show, the rows say "Not loaded".
    const realistic = makeAccounts(projectId, range, 'realistic', now);
    return {
      ...realistic,
      accounts: realistic.accounts.map((a) => ({ ...a, tokens: null, spend: null })),
      unavailable: ['tokens'],
    };
  }
  if (scene === 'empty' || scene === 'admission-hit') {
    return {
      ...base,
      usageAdmissionLimited: scene === 'admission-hit',
      accounts: [],
      stallEpisodes: { items: [], total: 0, listed: 10, truncated: false },
      totals: { runs: 0, merged: 0 },
    };
  }
  let accounts: InsightsAccount[];
  let items: InsightsStallEpisode[];
  if (scene === 'realistic') {
    accounts = [
      account(
        {
          key: 'cred:cc-max',
          name: 'Personal Max',
          runs: 64,
          merged: 41,
          runsByBucket: spread(64, n, 1),
          stalls: { episodes: 3, totalMs: 112 * MIN, ongoing: true },
          usage: usage('Personal Max', now, 86, 71),
          tokens: { total: 48_200_000, perMergedPullRequest: 1_175_610 },
        },
        n
      ),
      account(
        {
          key: 'teammate:openai-codex:subscription',
          owner: 'teammate',
          agentType: 'openai-codex',
          credentials: 2,
          runs: 23,
          merged: 15,
          runsByBucket: spread(23, n, 2),
          stalls: { episodes: 1, totalMs: 14 * MIN, ongoing: false },
          tokens: { total: 9_400_000, perMergedPullRequest: 626_667 },
        },
        n
      ),
      account(
        {
          key: 'cred:cc-key',
          name: 'Work API key',
          kind: 'api_key',
          runs: 18,
          merged: 12,
          runsByBucket: spread(18, n, 3),
          tokens: { total: 21_600_000, perMergedPullRequest: 1_800_000 },
          spend: {
            state: 'reported',
            costUsd: 41.27,
            perMergedPullRequestUsd: 3.44,
            unpricedModels: [],
          },
          stalls: { episodes: 1, totalMs: 9 * 60 * MIN, ongoing: false },
        },
        n
      ),
      account(
        {
          key: 'platform:claude-code:platform',
          owner: 'platform',
          kind: 'platform',
          runs: 4,
          merged: 1,
          runsByBucket: spread(4, n, 4),
          tokens: { total: 640_000, perMergedPullRequest: 640_000 },
        },
        n
      ),
      account(
        {
          key: 'teammate:claude-code:api_key',
          owner: 'teammate',
          kind: 'api_key',
          runs: 3,
          merged: 2,
          runsByBucket: spread(3, n, 6),
          tokens: { total: 2_300_000, perMergedPullRequest: 1_150_000 },
          spend: { state: 'private' },
        },
        n
      ),
      account(
        {
          key: 'cred:cc-key2',
          name: 'Spare API key',
          kind: 'api_key',
          runs: 1,
          runsByBucket: spread(1, n, 7),
          spend: { state: 'not_reported' },
        },
        n
      ),
      account(
        {
          key: 'not_recorded',
          owner: 'not_recorded',
          kind: 'unknown',
          agentType: null,
          credentials: 0,
          runs: 2,
          runsByBucket: spread(2, n, 5),
        },
        n
      ),
    ];
    items = [
      episode('cred:cc-max', 25 * MIN, 25 * MIN, { runs: 2, outcome: 'ongoing' }, now),
      episode('cred:cc-max', 2 * DAY, 47 * MIN, { runs: 2 }, now),
      episode('teammate:openai-codex:subscription', 3 * DAY, 14 * MIN, { window: 'Week' }, now),
      episode('cred:cc-key', 4 * DAY, 9 * 60 * MIN, { window: null, outcome: 'blocked' }, now),
      episode('cred:cc-max', 5 * DAY, 40 * MIN, { runs: 4 }, now),
      episode('cred:cc-max', 6 * DAY, 12 * MIN, { outcome: 'ended' }, now),
    ];
  } else {
    const long =
      'Raphaël’s extremely long-named personal Claude Max subscription used for nightly refactors and release-candidate verification across every repository';
    accounts = [
      account(
        {
          key: 'cred:cc-long',
          name: long,
          runs: 412,
          merged: 300,
          runsByBucket: spread(412, n, 1),
          stalls: { episodes: 31, totalMs: 41 * 60 * MIN, ongoing: true },
          tokens: { total: 987_654_321_000, perMergedPullRequest: 3_292_181_070 },
          usage: usage(long, now, 100, 97),
        },
        n
      ),
      account(
        {
          key: 'cred:cc-x',
          name: '<script>alert("x")</script> 🔑 key',
          kind: 'api_key',
          runs: 120,
          merged: 80,
          runsByBucket: spread(120, n, 2),
          tokens: { total: 412_000_000, perMergedPullRequest: 5_150_000 },
          spend: {
            state: 'reported',
            costUsd: 12345.678,
            perMergedPullRequestUsd: 154.32,
            unpricedModels: [
              'gpt-5.5-codex-max-preview-2026-11-01-experimental-long-context-build',
              'mystery-model-with-an-extremely-long-name-that-has-no-catalog-price-at-all',
            ],
          },
        },
        n
      ),
      account({ key: 'cred:cc-a', name: 'A', runs: 77, runsByBucket: spread(77, n, 3) }, n),
      account(
        {
          key: 'teammate:claude-code:subscription',
          owner: 'teammate',
          credentials: 9,
          runs: 61,
          merged: 40,
          runsByBucket: spread(61, n, 4),
        },
        n
      ),
      account(
        {
          key: 'project:openai-codex:api_key',
          owner: 'project',
          kind: 'api_key',
          agentType: 'openai-codex',
          credentials: 3,
          runs: 40,
          runsByBucket: spread(40, n, 5),
          tokens: { total: 31_000_000, perMergedPullRequest: null },
          spend: {
            state: 'reported',
            costUsd: null,
            perMergedPullRequestUsd: null,
            unpricedModels: ['llama-4-405b-instruct'],
          },
        },
        n
      ),
      account({ key: 'cred:cc-b', name: 'Spare Pro', runs: 22, runsByBucket: spread(22, n, 6) }, n),
      account({ key: 'cred:cc-c', name: 'Old Max', runs: 9, runsByBucket: spread(9, n, 7) }, n),
      account(
        {
          key: 'not_recorded',
          owner: 'not_recorded',
          kind: 'unknown',
          agentType: null,
          credentials: 0,
          runs: 3,
          runsByBucket: spread(3, n, 8),
        },
        n
      ),
    ];
    items = Array.from({ length: 10 }, (_, i) =>
      episode(
        i % 3 === 0
          ? 'cred:cc-long'
          : i % 3 === 1
            ? 'teammate:claude-code:subscription'
            : 'cred:cc-x',
        (i + 1) * 7 * 60 * MIN,
        (i + 1) * 13 * MIN,
        {
          runs: 1 + (i % 6),
          window: i % 4 === 0 ? '5h, Week' : '5h',
          outcome: i === 0 ? 'ongoing' : i === 4 ? 'blocked' : 'resumed',
        },
        now
      )
    );
  }
  return {
    ...base,
    accounts,
    stallEpisodes: {
      items,
      total: scene === 'stress' ? 47 : items.length,
      listed: 10,
      truncated: scene === 'stress',
    },
    totals: {
      runs: accounts.reduce((s, a) => s + a.runs, 0),
      merged: accounts.reduce((s, a) => s + a.merged, 0),
    },
    usageLimited: scene === 'stress',
  };
}
