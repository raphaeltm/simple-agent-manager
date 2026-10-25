/**
 * The usage part of a team status read: only what SAM measures, each with its source.
 *
 * Per-task token counts are not reported to SAM by agent harnesses, so they are unavailable rather
 * than estimated. Subscription windows are the provider's own last-reported utilization and reset
 * times for the caller's own and shared credentials; SAM's AI proxy meter is per person per day.
 */
import type { CredentialLimitsResponse } from '@simple-agent-manager/shared';

import {
  getTokenUsage,
  getUserBudgetSettings,
  resolveEffectiveLimits,
} from '../services/ai-token-budget';
import { log } from '../lib/logger';
import type { TeamTask } from './team-core';
import type { OperationContext } from './types';

/** One source's outcome: a failing source marks only its own section unavailable. */
export type Settled<T> = { ok: true; value: T } | { ok: false };

export async function settle<T>(source: string, read: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    log.warn('connector.team_source_unavailable', {
      source,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false };
  }
}

export async function usageSection(
  ctx: OperationContext,
  tasks: readonly Pick<TeamTask, 'agent' | 'compute'>[],
  computeOk: boolean,
  quotas: Settled<CredentialLimitsResponse>
) {
  const samMetered = tasks.filter((task) => task.agent?.providerMode === 'sam').length;
  let samDaily: unknown = 'not_applicable';
  if (samMetered > 0) {
    const daily = await settle('sam_ai_budget', async () => {
      const [usage, settings] = await Promise.all([
        getTokenUsage(ctx.env.KV, ctx.actor.userId, ctx.env),
        getUserBudgetSettings(ctx.env.KV, ctx.actor.userId),
      ]);
      return { usage, limits: resolveEffectiveLimits(settings, ctx.env) };
    });
    samDaily = daily.ok
      ? {
          scope: 'your_sam_ai_usage_today_utc_all_projects',
          inputTokens: daily.value.usage.inputTokens,
          outputTokens: daily.value.usage.outputTokens,
          dailyInputLimit: daily.value.limits.dailyInputTokenLimit,
          dailyOutputLimit: daily.value.limits.dailyOutputTokenLimit,
          source: 'sam_ai_proxy_meter',
        }
      : 'unavailable';
  }
  const computeTotals = tasks.reduce(
    (acc, task) => ({
      runtimeMinutes: acc.runtimeMinutes + (task.compute?.runtimeMinutes ?? 0),
      vcpuMinutes: acc.vcpuMinutes + (task.compute?.vcpuMinutes ?? 0),
    }),
    { runtimeMinutes: 0, vcpuMinutes: 0 }
  );
  return {
    tokens: {
      perTask: 'unavailable',
      reason: 'Agent harnesses do not report per-task token counts to SAM.',
    },
    samAiProxy: { tasksMeteredBySam: samMetered, daily: samDaily },
    subscriptionLimits: quotas.ok
      ? quotas.value.credentials.map((credential) => ({
          provider: credential.provider,
          agentType: credential.agentType,
          credentialSource: credential.credentialSource,
          level: credential.level,
          observedAt: new Date(credential.observedAt).toISOString(),
          windows: credential.windows.map((window) => ({
            windowType: window.windowType,
            utilizationPercent: window.utilizationPercent,
            resetsAt: window.resetsAt === null ? null : new Date(window.resetsAt).toISOString(),
            observedAt: new Date(window.observedAt).toISOString(),
            status: window.status,
          })),
          source: 'provider_reported_last_observed',
        }))
      : 'unavailable',
    subscriptionLimitsNote:
      'Only provider-reported windows for your own and shared credentials; never estimated from token counts. Missing means unknown.',
    compute: computeOk
      ? {
          ...computeTotals,
          source: 'measured_workspace_intervals',
          cost: 'not_attributed_per_task',
        }
      : 'unavailable',
  };
}
