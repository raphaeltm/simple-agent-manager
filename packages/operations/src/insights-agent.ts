/**
 * Insights for agents (slice I, build spec idea 01M7HTS38KX2G78JD0ESAGMKKH): one read with a
 * `method` over the shipped Insights reads, served as the catalog operation `sam_project_insights`
 * (SAM Connector) and the sam-mcp tool `project_insights`. Each method calls the same shared read
 * the web page and REST route call (policy 5cb362e8), then projects it to numbers: no task or pull
 * request titles, no idea titles or notes, no agent questions, no account names or credential
 * references, and no names of other members' profiles (slice A's privacy rule). CI check names
 * are kept (capped): they are what identifies a flaky check.
 *
 * Round trips are the underlying read's (rule 60): receipt at most 7 here, because the account
 * name it would read is never shown (`runReceipt` option `accountName: false`); flow at most 10;
 * setups at most 5; accounts at most 4; phases 2 (authorization, one query). sam-mcp adds one
 * rate-limit RPC per call (`routes/mcp/project-insights-tool.ts`); its settings come from the
 * per-isolate admin-settings cache the reads already use.
 */
import {
  INSIGHTS_RANGES,
  INSIGHTS_SETUP_GROUPINGS,
  type ProjectAccountsResponse,
  type ProjectFlowResponse,
  type ProjectSetupsResponse,
  type RunReceipt,
} from '@simple-agent-manager/shared';
import * as v from 'valibot';

import { authorizeProjectOperation } from './authorization';
import { OperationError } from './errors';
import { projectAccounts } from './insights-accounts';
import { projectFlow } from './insights-flow';
import {
  MAX_PHASE_STATS_PHASES,
  MAX_PHASE_STATS_WINDOW_DAYS,
  phaseDurationStats,
  type PhaseDurationStatsResult,
} from './insights-phase-timings';
import { runReceipt } from './insights-receipt';
import { projectSetups } from './insights-setups';
import type { OperationContext } from './types';

export const PROJECT_INSIGHTS_METHODS = [
  'receipt',
  'flow',
  'setups',
  'phases',
  'accounts',
] as const;
export type ProjectInsightsMethod = (typeof PROJECT_INSIGHTS_METHODS)[number];

const id = v.pipe(v.string(), v.minLength(1), v.maxLength(200));

/** Strict: an undeclared argument (a typo such as `rang`) is refused, as the advertised JSON
 *  schemas say (`additionalProperties: false`), rather than dropped and run with a default. */
export const ProjectInsightsInputSchema = v.strictObject({
  projectId: id,
  method: v.picklist(PROJECT_INSIGHTS_METHODS),
  taskId: v.optional(id),
  range: v.optional(v.picklist(INSIGHTS_RANGES)),
  groupBy: v.optional(v.picklist(INSIGHTS_SETUP_GROUPINGS)),
  skillId: v.optional(id),
  agentProfileId: v.optional(id),
  operation: v.optional(v.pipe(v.string(), v.regex(/^[a-z_]{1,32}$/))),
  phaseNames: v.optional(
    v.pipe(
      v.array(v.pipe(v.string(), v.regex(/^[a-z0-9_-]{1,64}$/))),
      v.minLength(1),
      v.maxLength(MAX_PHASE_STATS_PHASES)
    )
  ),
  windowDays: v.optional(
    v.pipe(v.number(), v.minValue(1), v.maxValue(MAX_PHASE_STATS_WINDOW_DAYS), v.integer())
  ),
});
export type ProjectInsightsInput = v.InferOutput<typeof ProjectInsightsInputSchema>;

/** A stored code (`terminal_reason`) passes; anything that could be free text does not. */
const CODE = /^[a-z0-9_.:-]{1,64}$/;
/** CI check names are third-party text; a long one is cut rather than passed whole. */
const CHECK_NAME_MAX = 100;

function capName(name: string): string {
  return name.length > CHECK_NAME_MAX ? `${name.slice(0, CHECK_NAME_MAX)}…` : name;
}

export function agentReceipt(receipt: RunReceipt) {
  const pr = receipt.outcome.pullRequest;
  const reason = receipt.outcome.terminalReason;
  return {
    taskId: receipt.taskId,
    status: receipt.status,
    live: receipt.live,
    createdAt: receipt.createdAt,
    endedAt: receipt.endedAt,
    totalMs: receipt.totalMs,
    phases: receipt.phases,
    outcome: {
      pullRequest: pr ? { number: pr.number, state: pr.state, mergedAt: pr.mergedAt } : null,
      checks: receipt.outcome.checks,
      ciFirstTry: receipt.outcome.ciFirstTry,
      terminalReason: reason !== null && CODE.test(reason) ? reason : null,
    },
    account: receipt.account
      ? {
          agentType: receipt.account.agentType,
          credentialSource: receipt.account.credentialSource,
          credentialScope: receipt.account.credentialScope,
          isOwnSession: receipt.account.isOwnSession,
        }
      : null,
    resources: receipt.resources,
    toolCalls: receipt.toolCalls,
    tokens: receipt.tokens,
    slowedDown: receipt.slowedDown.map(({ question: _question, ...item }) => item),
    unavailable: receipt.unavailable,
  };
}

export function agentFlow(flow: ProjectFlowResponse) {
  return {
    range: flow.range,
    since: flow.since,
    until: flow.until,
    tiles: flow.tiles,
    merged: flow.merged,
    runs: flow.runs,
    stopReasons: flow.stopReasons,
    // Check names come from CI as reported; they identify the flaky check, so they stay, capped.
    flakyChecks: {
      total: flow.flakyChecks.total,
      items: flow.flakyChecks.items.map((check) => ({
        name: capName(check.name),
        flips: check.flips,
        commits: check.commits,
      })),
    },
    waitingIdeas: {
      total: flow.waitingIdeas.total,
      items: flow.waitingIdeas.items.map((idea) => ({
        ideaId: idea.ideaId,
        createdAt: idea.createdAt,
        state: idea.state,
        chats: idea.chats,
        pullRequest: idea.pullRequest,
      })),
    },
    topBlocker:
      flow.topBlocker?.kind === 'flaky_check'
        ? { ...flow.topBlocker, name: capName(flow.topBlocker.name) }
        : flow.topBlocker,
    unavailable: flow.unavailable,
  };
}

export function agentSetups(setups: ProjectSetupsResponse) {
  return {
    range: setups.range,
    groupBy: setups.groupBy,
    since: setups.since,
    until: setups.until,
    rework: setups.rework,
    sample: setups.sample,
    // Field by field, so a text field added to the page response later is not passed on.
    groups: setups.groups.map((group) => ({
      key: group.key,
      // A teammate's profile name can name the teammate; its id is enough to look it up.
      label: group.owner === 'teammate' ? null : group.label,
      owner: group.owner,
      agentType: group.agentType,
      runs: group.runs,
      finished: group.finished,
      mergedClean: group.mergedClean,
      mergedCleanRate: group.mergedCleanRate,
      merged: group.merged,
      medianToPullRequestMs: group.medianToPullRequestMs,
      pullRequests: group.pullRequests,
      nudges: group.nudges,
      tokens: group.tokens,
      memory: group.memory,
    })),
    // Ids only: a compared profile may be a teammate's, and `apply` is the page's action payload.
    suggestions: setups.suggestions.map((s) =>
      s.kind === 'default_profile'
        ? {
            id: s.id,
            kind: s.kind,
            skillId: s.skill.id,
            profile: {
              id: s.profile.id,
              runs: s.profile.runs,
              mergedCleanRate: s.profile.mergedCleanRate,
            },
            compared: {
              id: s.compared.id,
              runs: s.compared.runs,
              mergedCleanRate: s.compared.mergedCleanRate,
            },
            currentDefault: s.currentDefault,
          }
        : {
            id: s.id,
            kind: s.kind,
            skillId: s.skill.id,
            currentGb: s.currentGb,
            suggestedGb: s.suggestedGb,
            runs: s.runs,
            p90Bytes: s.p90Bytes,
            maxBytes: s.maxBytes,
            oomKills: s.oomKills,
          }
    ),
    suggestionMinRuns: setups.suggestionMinRuns,
    unavailable: setups.unavailable,
  };
}

export function agentAccounts(accounts: ProjectAccountsResponse) {
  // Accounts are re-keyed by position: the page's keys carry credential ids.
  const alias = new Map(accounts.accounts.map((account, i) => [account.key, `account-${i + 1}`]));
  return {
    range: accounts.range,
    since: accounts.since,
    until: accounts.until,
    bucket: accounts.bucket,
    buckets: accounts.buckets,
    accounts: accounts.accounts.map((account) => ({
      key: alias.get(account.key) ?? null,
      owner: account.owner,
      kind: account.kind,
      agentType: account.agentType,
      runs: account.runs,
      merged: account.merged,
      runsByBucket: account.runsByBucket,
      stalls: account.stalls,
      limits: account.usage
        ? {
            level: account.usage.level,
            windows: account.usage.windows.map((w) => ({
              windowType: w.windowType,
              status: w.status,
              level: w.level,
              utilizationPercent: w.utilizationPercent,
              resetsAt: w.resetsAt,
              observedAt: w.observedAt,
            })),
          }
        : null,
      tokens: account.tokens,
      spend: account.spend,
    })),
    stallEpisodes: {
      total: accounts.stallEpisodes.total,
      listed: accounts.stallEpisodes.listed,
      truncated: accounts.stallEpisodes.truncated,
      items: accounts.stallEpisodes.items.map((episode) => ({
        accountKey: alias.get(episode.accountKey) ?? null,
        window: episode.window,
        startedAt: episode.startedAt,
        endedAt: episode.endedAt,
        durationMs: episode.durationMs,
        runs: episode.runs,
        outcome: episode.outcome,
      })),
    },
    totals: accounts.totals,
    usageLimited: accounts.usageLimited,
    unavailable: accounts.unavailable,
  };
}

/** Usual phase durations for one skill or profile; `phaseDurationStats` is a core without auth. */
export async function projectPhaseStats(
  ctx: OperationContext,
  input: Pick<
    ProjectInsightsInput,
    'projectId' | 'skillId' | 'agentProfileId' | 'operation' | 'phaseNames'
  > & {
    windowDays?: number;
  }
): Promise<PhaseDurationStatsResult> {
  if ((input.skillId === undefined) === (input.agentProfileId === undefined)) {
    throw new OperationError(
      'invalid_input',
      'phases needs exactly one of skillId or agentProfileId'
    );
  }
  await authorizeProjectOperation(ctx, input.projectId);
  return phaseDurationStats(ctx.env.DATABASE, {
    projectId: input.projectId,
    skillId: input.skillId,
    agentProfileId: input.agentProfileId,
    operation: input.operation,
    phases: input.phaseNames,
    windowDays: input.windowDays,
  });
}

/** Per-method inputs that the method does not read are refused rather than ignored. */
const ALLOWED: Record<ProjectInsightsMethod, ReadonlySet<keyof ProjectInsightsInput>> = {
  receipt: new Set(['taskId']),
  flow: new Set(['range']),
  setups: new Set(['range', 'groupBy']),
  phases: new Set(['skillId', 'agentProfileId', 'operation', 'phaseNames', 'windowDays']),
  accounts: new Set(['range']),
};
const OPTIONAL_KEYS = [
  'taskId',
  'range',
  'groupBy',
  'skillId',
  'agentProfileId',
  'operation',
  'phaseNames',
  'windowDays',
] as const;

/**
 * The method-specific checks the schema cannot express: arguments the method does not read, and
 * the ones it needs. Returns the refusal message, or null. sam-mcp runs it before spending a call
 * of the chat's budget, so a malformed call costs nothing.
 */
export function projectInsightsInputError(input: ProjectInsightsInput): string | null {
  const extra = OPTIONAL_KEYS.filter(
    (key) => input[key] !== undefined && !ALLOWED[input.method].has(key)
  );
  if (extra.length > 0) return `method ${input.method} does not take ${extra.join(', ')}`;
  if (input.method === 'receipt' && !input.taskId) return 'receipt needs taskId';
  if (
    input.method === 'phases' &&
    (input.skillId === undefined) === (input.agentProfileId === undefined)
  ) {
    return 'phases needs exactly one of skillId or agentProfileId';
  }
  return null;
}

export async function projectInsights(ctx: OperationContext, input: ProjectInsightsInput) {
  const refusal = projectInsightsInputError(input);
  if (refusal !== null) throw new OperationError('invalid_input', refusal);
  const { projectId } = input;
  switch (input.method) {
    case 'receipt': {
      if (!input.taskId) throw new OperationError('invalid_input', 'receipt needs taskId');
      const receipt = await runReceipt(
        ctx,
        { projectId, taskId: input.taskId },
        { accountName: false }
      );
      return { method: input.method, projectId, receipt: agentReceipt(receipt) };
    }
    case 'flow':
      return {
        method: input.method,
        projectId,
        flow: agentFlow(await projectFlow(ctx, { projectId, range: input.range })),
      };
    case 'setups':
      return {
        method: input.method,
        projectId,
        setups: agentSetups(
          await projectSetups(ctx, { projectId, range: input.range, groupBy: input.groupBy })
        ),
      };
    case 'phases':
      return { method: input.method, projectId, phases: await projectPhaseStats(ctx, input) };
    case 'accounts':
      return {
        method: input.method,
        projectId,
        accounts: agentAccounts(await projectAccounts(ctx, { projectId, range: input.range })),
      };
  }
}
