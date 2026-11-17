/**
 * The agent view of Insights (slice I) returns numbers only. Each projection is fed a response
 * whose text fields hold sentinel strings, then the serialized result is searched for every
 * sentinel, so a field added later to the page response cannot leak by default. Beside each strip,
 * a liveness assertion proves the numbers still came through (rule 62).
 */
import type { OperationContext } from '@simple-agent-manager/operations';
import { OperationError, projectInsights } from '@simple-agent-manager/operations';
import {
  agentAccounts,
  agentFlow,
  agentReceipt,
  agentSetups,
} from '@simple-agent-manager/operations/internal/insights-agent';
import {
  getInsightsAgentRateLimit,
  INSIGHTS_AGENT_SETTINGS,
} from '@simple-agent-manager/operations/internal/insights-agent-settings';
import type {
  ProjectAccountsResponse,
  ProjectFlowResponse,
  ProjectSetupsResponse,
  RunReceipt,
} from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

const SECRET = 'SENTINEL-TEXT';

function leaks(value: unknown): boolean {
  return JSON.stringify(value).includes(SECRET);
}

function receipt(terminalReason: string | null): RunReceipt {
  return {
    projectId: 'p',
    taskId: 't',
    sessionId: 's',
    title: `${SECRET} task title`,
    status: 'completed',
    live: false,
    createdAt: '2026-11-17T00:00:00.000Z',
    endedAt: '2026-11-17T01:00:00.000Z',
    totalMs: 3_600_000,
    phases: [{ key: 'agent', durationMs: 1_000 }],
    outcome: {
      pullRequest: {
        number: 7,
        url: `https://example.test/${SECRET}`,
        title: `${SECRET} pr`,
        repository: 'o/r',
        state: 'merged',
        mergedAt: '2026-11-17T01:00:00.000Z',
      },
      checks: 'success',
      ciFirstTry: 'passed',
      terminalReason,
    },
    account: {
      agentType: 'claude-code',
      credentialSource: 'user',
      credentialScope: 'user',
      accountName: `${SECRET} account`,
      isOwnSession: true,
    },
    resources: {
      measured: true,
      peakMemoryBytes: 2_000_000_000,
      requestedMemoryMb: 3072,
      peakCpuMillis: 1500,
      requestedCpuMillis: 2000,
      oomKills: 0,
    },
    toolCalls: { total: 3, byKind: [{ kind: 'edit', count: 3 }], scanLimited: false },
    tokens: { state: 'not_reported' },
    slowedDown: [
      {
        kind: 'waiting',
        durationMs: 60_000,
        usualMs: null,
        comparedBy: null,
        sampleSize: null,
        question: `${SECRET} question`,
        peakMemoryBytes: null,
        requestedMemoryMb: null,
        count: 1,
      },
    ],
    unavailable: [],
    generatedAt: '2026-11-17T01:00:00.000Z',
  };
}

describe('agentReceipt', () => {
  it('drops titles, urls, the account name and agent questions but keeps the numbers', () => {
    const view = agentReceipt(receipt('agent_completed'));
    expect(leaks(view)).toBe(false);
    expect(view.totalMs).toBe(3_600_000);
    expect(view.outcome.pullRequest).toEqual({
      number: 7,
      state: 'merged',
      mergedAt: '2026-11-17T01:00:00.000Z',
    });
    expect(view.outcome.terminalReason).toBe('agent_completed');
    expect(view.resources.peakMemoryBytes).toBe(2_000_000_000);
    expect(view.slowedDown).toEqual([expect.objectContaining({ kind: 'waiting', count: 1 })]);
    expect(view.account).toEqual({
      agentType: 'claude-code',
      credentialSource: 'user',
      credentialScope: 'user',
      isOwnSession: true,
    });
  });

  it('drops a terminal reason that is free text rather than a code', () => {
    expect(agentReceipt(receipt(`Error: ${SECRET} at line 3`)).outcome.terminalReason).toBeNull();
  });
});

describe('agentFlow', () => {
  it('keeps CI health and idea ids but no idea titles or notes', () => {
    const flow = {
      projectId: 'p',
      range: '30d',
      since: 'a',
      until: 'b',
      tiles: {
        ideaToMerged: {
          medianMs: 1,
          previousMedianMs: null,
          count: 1,
          sampled: { ideas: 1, cap: 100, truncated: false },
        },
        ciFirstTry: { count: 3, of: 4, rate: 0.75, previousRate: null, recorded: 4 },
        waitingOnPerson: { medianMs: null, previousMedianMs: null, count: 0 },
        rework: { count: 0, of: 1, rate: 0, previousRate: null, windowDays: 7 },
      },
      merged: { count: 1, previous: 0 },
      runs: { bucket: 'week', buckets: [], other: { stopped: 0, prOpen: 0, noPullRequest: 0 } },
      stopReasons: [],
      flakyChecks: { items: [{ name: 'Lint', flips: 2, commits: 1 }], total: 1 },
      waitingIdeas: {
        items: [
          {
            ideaId: 'idea-1',
            title: `${SECRET} idea`,
            createdAt: 'c',
            state: 'draft',
            chats: 0,
            pullRequest: null,
            note: `${SECRET} note`,
          },
        ],
        total: 1,
      },
      topBlocker: { kind: 'flaky_check', name: 'Lint', flips: 2 },
      unavailable: [],
      generatedAt: 'g',
    } as unknown as ProjectFlowResponse;
    const view = agentFlow(flow);
    expect(leaks(view)).toBe(false);
    expect(view.tiles.ciFirstTry.rate).toBe(0.75);
    expect(view.flakyChecks.items[0]).toEqual({ name: 'Lint', flips: 2, commits: 1 });
    expect(view.waitingIdeas.items[0]?.ideaId).toBe('idea-1');
  });
});

describe('agentSetups', () => {
  it('hides teammate profile names and suggestion names, keeps resources', () => {
    const group = {
      key: 'prof-t',
      label: `${SECRET} teammate profile`,
      owner: 'teammate',
      agentType: null,
      usedFor: [`${SECRET} skill`],
      runs: 4,
      finished: 4,
      mergedClean: 2,
      mergedCleanRate: 0.5,
      merged: 2,
      medianToPullRequestMs: 600_000,
      pullRequests: 2,
      nudges: { state: 'not_recorded' },
      tokens: { state: 'not_reported' },
      memory: {
        state: 'measured',
        p90Bytes: 3_000_000_000,
        maxBytes: 3_500_000_000,
        requestedMb: 4096,
        runs: 4,
        oomKills: 0,
      },
    };
    const setups = {
      projectId: 'p',
      range: '30d',
      groupBy: 'profile',
      since: 'a',
      until: 'b',
      rework: { windowDays: 7, rule: 'same_branch' },
      sample: { runs: 4, cap: 2000, truncated: false },
      groups: [group, { ...group, key: 'prof-p', owner: 'project', label: 'Shared profile' }],
      suggestions: [
        {
          id: 's1',
          kind: 'default_profile',
          skill: { id: 'sk', name: `${SECRET} skill` },
          profile: { id: 'pa', name: `${SECRET} a`, runs: 10, mergedCleanRate: 0.8 },
          compared: { id: 'pb', name: `${SECRET} b`, runs: 10, mergedCleanRate: 0.4 },
          currentDefault: false,
          apply: { skillId: 'sk', patch: { defaultProfileId: 'pa' } },
        },
        {
          id: 's2',
          kind: 'request_size',
          skill: { id: 'sk', name: `${SECRET} skill` },
          currentGb: 4,
          suggestedGb: 6,
          runs: 12,
          p90Bytes: 4_500_000_000,
          maxBytes: 5_000_000_000,
          oomKills: 1,
          apply: { skillId: 'sk', patch: { resourceRequirementsJson: '{}' } },
        },
      ],
      suggestionMinRuns: 10,
      unavailable: [],
      generatedAt: 'g',
    } as unknown as ProjectSetupsResponse;
    const view = agentSetups(setups);
    expect(leaks(view)).toBe(false);
    expect(view.groups.map((g) => g.label)).toEqual([null, 'Shared profile']);
    expect(view.groups[0]?.memory).toMatchObject({ p90Bytes: 3_000_000_000, requestedMb: 4096 });
    expect(view.suggestions[1]).toMatchObject({ skillId: 'sk', suggestedGb: 6, oomKills: 1 });
    expect(view.suggestions[0]).toMatchObject({ profile: { id: 'pa', mergedCleanRate: 0.8 } });
  });
});

describe('agentAccounts', () => {
  it('re-keys accounts, keeps episodes linked and returns no names or credential ids', () => {
    const accounts = {
      projectId: 'p',
      range: '30d',
      since: 'a',
      until: 'b',
      bucket: 'week',
      buckets: ['w1'],
      accounts: [
        {
          key: `cred:${SECRET}-id`,
          name: `${SECRET} own account`,
          owner: 'you',
          kind: 'subscription',
          agentType: 'claude-code',
          credentials: 1,
          runs: 5,
          merged: 3,
          runsByBucket: [5],
          stalls: { episodes: 1, totalMs: 120_000, ongoing: false },
          usage: {
            credentialReference: `cc_credentials:${SECRET}-id`,
            credentialId: `${SECRET}-id`,
            credentialName: `${SECRET} own account`,
            credentialSource: 'user',
            provider: 'anthropic',
            providerMode: 'direct',
            agentType: 'claude-code',
            level: 'warning',
            observedAt: 1,
            windows: [
              {
                windowType: 'claude.five_hour',
                provider: 'anthropic',
                source: 'x',
                status: 'allowed_warning',
                level: 'warning',
                utilizationPercent: 86,
                limitAmount: null,
                remainingAmount: null,
                windowMinutes: 300,
                resetsAt: 2,
                observedAt: 1,
                updatedAt: 1,
              },
            ],
          },
          spend: null,
        },
        {
          key: 'teammate:claude-code:subscription',
          name: null,
          owner: 'teammate',
          kind: 'subscription',
          agentType: 'claude-code',
          credentials: 1,
          runs: 1,
          merged: 0,
          runsByBucket: [1],
          stalls: { episodes: 0, totalMs: 0, ongoing: false },
          usage: null,
          spend: null,
        },
      ],
      stallEpisodes: {
        items: [
          {
            accountKey: `cred:${SECRET}-id`,
            window: 'claude.five_hour',
            startedAt: 's',
            endedAt: 'e',
            durationMs: 120_000,
            runs: 1,
            outcome: 'resumed',
          },
        ],
        total: 1,
        listed: 1,
        truncated: false,
      },
      totals: { runs: 6, merged: 3 },
      unavailable: [],
      generatedAt: 'g',
    } as unknown as ProjectAccountsResponse;
    const view = agentAccounts(accounts);
    expect(leaks(view)).toBe(false);
    expect(view.accounts.map((a) => [a.key, a.owner, a.runs])).toEqual([
      ['account-1', 'you', 5],
      ['account-2', 'teammate', 1],
    ]);
    expect(view.accounts[0]?.limits?.windows[0]).toMatchObject({ utilizationPercent: 86 });
    expect(view.stallEpisodes.items[0]?.accountKey).toBe('account-1');
  });
});

describe('projectInsights input rules', () => {
  // These refusals happen before any read, so the context is never touched.
  const ctx = {} as OperationContext;

  it('refuses an argument the method does not read', async () => {
    await expect(
      projectInsights(ctx, { projectId: 'p', method: 'flow', taskId: 't' })
    ).rejects.toMatchObject({ code: 'invalid_input', message: 'method flow does not take taskId' });
  });

  it('requires taskId for receipt and exactly one of skill or profile for phases', async () => {
    await expect(
      projectInsights(ctx, { projectId: 'p', method: 'receipt' })
    ).rejects.toBeInstanceOf(OperationError);
    await expect(
      projectInsights(ctx, { projectId: 'p', method: 'phases', skillId: 's', agentProfileId: 'a' })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(projectInsights(ctx, { projectId: 'p', method: 'phases' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });
});

describe('getInsightsAgentRateLimit', () => {
  function ports(values: unknown[] | Error) {
    return {
      ports: {
        settings: {
          resolveDetailsMany: async () => {
            if (values instanceof Error) throw values;
            return values.map((value) => ({ value, configured: true, source: 'override' }));
          },
        },
      },
    } as unknown as Pick<OperationContext, 'ports'>;
  }

  it('reads both admin settings', async () => {
    expect(await getInsightsAgentRateLimit(ports([5, 120]))).toEqual({
      callsPerWindow: 5,
      windowSeconds: 120,
    });
  });

  it('falls back to the code defaults on out-of-range values or unreadable storage', async () => {
    const defaults = {
      callsPerWindow: INSIGHTS_AGENT_SETTINGS[0].defaultValue,
      windowSeconds: INSIGHTS_AGENT_SETTINGS[1].defaultValue,
    };
    expect(await getInsightsAgentRateLimit(ports([0, 5]))).toEqual(defaults);
    expect(await getInsightsAgentRateLimit(ports(new Error('down')))).toEqual(defaults);
  });
});
