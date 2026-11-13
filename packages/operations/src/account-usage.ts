/**
 * Profile → account association and remaining provider usage for monitoring apps
 * (`sam_profiles_list`, `sam_usage_get`).
 *
 * Which account a profile runs on comes from the worker's metadata-only resolver
 * (`ports.account.profileAccountBindings`, the same shared resolver the agent-key callback runs).
 * Usage comes from the provider-reported windows SAM already stores
 * (`ports.account.listUserCredentialLimits`, `ports.tasks.listCredentialLimits`); nothing here is
 * estimated. Usage is reported per quota pool, never per profile, so profiles that share one
 * stored credential can never be read as independent quotas.
 */
import {
  type CredentialLimitCredentialSummary,
  type CredentialLimitLevel,
  type CredentialLimitsResponse,
  credentialLimitWindowLabel,
  type CredentialLimitWindowSummary,
  worstCredentialLimitLevel,
} from '@simple-agent-manager/shared';
import { log } from '@simple-agent-manager/worker-core';

import { operationLink } from './connector-read-core';
import { OperationError } from './errors';
import type { ProfileAccountBinding } from './port-types';
import { samAiDailyUsage, settle, type Settled } from './team-usage';
import type { OperationContext } from './types';

export type UsageFreshness = 'fresh' | 'stale' | 'reset_since_sample';

/** What a monitoring app may see about a profile's account. No ids of other people, no secrets. */
export function publicProfileAccount(binding: ProfileAccountBinding | undefined) {
  if (!binding) return null;
  return {
    state: binding.state,
    tier: binding.tier,
    poolId: binding.poolId,
    accountName: binding.account?.name ?? null,
    ...(binding.account?.storage === 'legacy' ? { storage: 'legacy' as const } : {}),
    ...(binding.reason ? { reason: binding.reason } : {}),
  };
}

/** Bindings for `profiles`, or null when the resolver failed (logged); never throws. */
export async function bindProfiles(
  ctx: OperationContext,
  projectId: string,
  profiles: readonly { id: string; agentType: string }[]
): Promise<Map<string, ProfileAccountBinding> | null> {
  const result = await settle('profile_account_bindings', () =>
    ctx.ports.account.profileAccountBindings({
      projectId,
      userId: ctx.actor.userId,
      profiles,
    })
  );
  if (!result.ok) return null;
  return new Map(result.value.map((binding) => [binding.profileId, binding]));
}

function iso(epochMs: number | null): string | null {
  return epochMs === null || !Number.isFinite(epochMs) ? null : new Date(epochMs).toISOString();
}

export function windowFreshness(
  window: CredentialLimitWindowSummary,
  now: number,
  staleAfterMs: number
): UsageFreshness {
  if (window.resetElapsed) return 'reset_since_sample';
  return now - window.observedAt > staleAfterMs ? 'stale' : 'fresh';
}

function projectWindow(window: CredentialLimitWindowSummary, now: number, staleAfterMs: number) {
  const used = window.utilizationPercent;
  return {
    windowType: window.windowType,
    label: credentialLimitWindowLabel(window.windowType, window.windowMinutes),
    usedPercent: used,
    remainingPercent: used === null ? null : Math.max(0, Math.round((100 - used) * 10) / 10),
    status: window.status,
    level: window.level,
    resetsAt: iso(window.resetsAt),
    observedAt: iso(window.observedAt),
    ageMinutes: Math.max(0, Math.floor((now - window.observedAt) / 60_000)),
    freshness: windowFreshness(window, now, staleAfterMs),
    source: window.source,
  };
}

/**
 * Pool usage from its windows. `exhausted` is true when a provider refused at least one window
 * that has not reset since; `nextResetAt` is then the latest reset among those refusals (null if
 * any refusal has no known reset), otherwise the soonest upcoming reset.
 */
export function summarizePoolUsage(
  windows: readonly CredentialLimitWindowSummary[],
  now: number,
  staleAfterMs: number
) {
  if (windows.length === 0) {
    return {
      state: 'never_reported' as const,
      level: null,
      exhausted: null,
      remainingPercent: null,
      nextResetAt: null,
      observedAt: null,
      freshness: null,
      windows: [],
    };
  }
  const refused = windows.filter((window) => window.status === 'rejected' && !window.resetElapsed);
  const exhausted = refused.length > 0;
  let nextReset: number | null = null;
  if (exhausted) {
    const resets = refused.map((window) => window.resetsAt);
    nextReset = resets.some((reset) => reset === null)
      ? null
      : Math.max(...resets.filter((reset): reset is number => reset !== null));
  } else {
    const upcoming = windows
      .map((window) => window.resetsAt)
      .filter((reset): reset is number => reset !== null && reset > now);
    nextReset = upcoming.length > 0 ? Math.min(...upcoming) : null;
  }
  const known = windows
    .map((window) => window.utilizationPercent)
    .filter((used): used is number => used !== null);
  const freshnesses = windows.map((window) => windowFreshness(window, now, staleAfterMs));
  return {
    state: 'reported' as const,
    level: worstCredentialLimitLevel(windows.map((window) => window.level)) as CredentialLimitLevel,
    exhausted,
    remainingPercent:
      known.length > 0 ? Math.max(0, Math.round((100 - Math.max(...known)) * 10) / 10) : null,
    nextResetAt: iso(nextReset),
    observedAt: iso(Math.max(...windows.map((window) => window.observedAt))),
    freshness: freshnesses.includes('stale')
      ? ('stale' as const)
      : freshnesses.includes('reset_since_sample')
        ? ('reset_since_sample' as const)
        : ('fresh' as const),
    windows: windows.map((window) => projectWindow(window, now, staleAfterMs)),
  };
}

/** Newest sample per window type across every summary that belongs to one pool. */
export function poolWindows(
  summaries: readonly CredentialLimitCredentialSummary[]
): CredentialLimitWindowSummary[] {
  const newest = new Map<string, CredentialLimitWindowSummary>();
  for (const summary of summaries) {
    for (const window of summary.windows) {
      const seen = newest.get(window.windowType);
      if (!seen || window.observedAt > seen.observedAt) newest.set(window.windowType, window);
    }
  }
  return [...newest.values()].sort(
    (a, b) =>
      (a.windowMinutes ?? Number.POSITIVE_INFINITY) -
        (b.windowMinutes ?? Number.POSITIVE_INFINITY) || a.windowType.localeCompare(b.windowType)
  );
}

function summariesForPool(
  binding: ProfileAccountBinding,
  limits: readonly CredentialLimitCredentialSummary[]
): CredentialLimitCredentialSummary[] {
  if (binding.state === 'platform') {
    return limits.filter(
      (summary) =>
        summary.credentialSource === 'platform' && summary.agentType === binding.agentType
    );
  }
  const references = new Set(binding.usageReferences);
  // Only the caller's own references are in a binding, so another member's rows never match.
  return limits.filter((summary) => references.has(summary.credentialReference));
}

function mergeLimits(
  ...reads: Settled<CredentialLimitsResponse>[]
): CredentialLimitCredentialSummary[] | null {
  const ok = reads.filter(
    (read): read is { ok: true; value: CredentialLimitsResponse } => read.ok
  );
  if (ok.length === 0) return null;
  return ok.flatMap((read) => read.value.credentials);
}

export async function usageGet(
  ctx: OperationContext,
  input: { projectId: string; profileId?: string }
) {
  let profiles;
  try {
    profiles = await ctx.ports.account.listProfiles(input.projectId, ctx.actor.userId);
  } catch (error) {
    throw new OperationError('unavailable', `Failed to list profiles: ${(error as Error).message}`);
  }
  const bindings = await bindProfiles(ctx, input.projectId, profiles);
  if (!bindings) {
    throw new OperationError(
      'unavailable',
      'SAM could not resolve profile accounts right now.',
      'Retry shortly; this read does not change anything.'
    );
  }
  const [userLimits, projectLimits, settings] = await Promise.all([
    settle('credential_limits_user', () =>
      ctx.ports.account.listUserCredentialLimits(ctx.actor.userId)
    ),
    settle('credential_limits_project', () =>
      ctx.ports.tasks.listCredentialLimits({
        projectId: input.projectId,
        userId: ctx.actor.userId,
      })
    ),
    ctx.ports.settings.connectorReadLimits(),
  ]);
  const limits = mergeLimits(userLimits, projectLimits);
  const staleAfterMinutes = settings.usageStaleAfterMinutes;
  const staleAfterMs = staleAfterMinutes * 60_000;
  const now = Date.now();

  const wanted = input.profileId
    ? profiles.find((profile) => profile.id === input.profileId)
    : undefined;
  if (input.profileId && !wanted) throw new OperationError('not_found', 'Agent profile not found');
  const wantedPool = wanted ? bindings.get(wanted.id)?.poolId : undefined;

  const pools = new Map<
    string,
    {
      binding: ProfileAccountBinding;
      agentTypes: Set<string>;
      profiles: { id: string; name: string; tier: string | null }[];
    }
  >();
  const withoutAccount: { profileId: string; name: string; state: string; reason: string | null }[] =
    [];
  for (const profile of profiles) {
    const binding = bindings.get(profile.id);
    if (!binding) continue;
    if (wanted && binding.poolId !== wantedPool && profile.id !== wanted.id) continue;
    if (!binding.poolId) {
      withoutAccount.push({
        profileId: profile.id,
        name: profile.name,
        state: binding.state,
        reason: binding.reason,
      });
      continue;
    }
    const pool = pools.get(binding.poolId) ?? {
      binding,
      agentTypes: new Set<string>(),
      profiles: [],
    };
    pool.agentTypes.add(binding.agentType);
    pool.profiles.push({ id: profile.id, name: profile.name, tier: binding.tier });
    pools.set(binding.poolId, pool);
  }

  const projected = [...pools.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([poolId, pool]) => {
      const usage = limits
        ? summarizePoolUsage(
            poolWindows(summariesForPool(pool.binding, limits)),
            now,
            staleAfterMs
          )
        : { state: 'unavailable' as const };
      return {
        poolId,
        kind: pool.binding.state === 'platform' ? ('platform' as const) : ('account' as const),
        accountName: pool.binding.account?.name ?? null,
        agentTypes: [...pool.agentTypes].sort(),
        sharedBy: pool.profiles.length,
        profiles: pool.profiles,
        usage,
      };
    });
  if (!limits) {
    log.warn('connector.usage_limits_unavailable', { projectId: input.projectId });
  }
  const anyPlatform = projected.some((pool) => pool.kind === 'platform');
  return {
    projectId: input.projectId,
    generatedAt: new Date(now).toISOString(),
    staleAfterMinutes,
    pools: projected,
    profilesWithoutAccount: withoutAccount,
    ...(anyPlatform ? { samAiProxyToday: await samAiDailyUsage(ctx) } : {}),
    semantics: [
      'Usage is per pool: every profile listed under one poolId draws on the same provider quota, so never add their remaining capacity together.',
      'Pools are stored credentials. Two different stored credentials that log in to the same provider account are not detected and appear as separate pools.',
      'Windows are the provider’s own last-reported numbers, sampled only when an agent runs on that account. freshness "stale" means no sample within staleAfterMinutes; "reset_since_sample" means the window reset after the last sample, so usedPercent restarts from 0. usage.state "never_reported" means SAM has no sample for this account: remaining capacity is unknown, not full.',
      'kind "platform" pools are SAM-managed and shared across the installation; their windows (if any) are not attributable to you. samAiProxyToday is your SAM AI proxy budget when SAM provides the model.',
    ],
    link: operationLink(ctx, input.projectId),
  };
}
