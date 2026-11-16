/**
 * Admin "Health & cost" (Insights slice H, idea 01M7HTS38KX2G78JD0ESAGMKKH): the one
 * superadmin-only read behind `GET /api/admin/health-cost`. Everything is derived at read time
 * from existing records; nothing is stored.
 *
 * Round trips (`.claude/rules/60`, aggregation class, budget 15):
 *   1  superadmin check
 *   1  admin settings (cached per isolate; shared with the lifecycle port's settings read)
 *   then in parallel:
 *   1  machines for compute spend (`insights-installation-compute.ts`)
 *   2  placements and warm-pool claims (`insights-installation-placements.ts`)
 *   1  running intervals
 *   3  lifecycle latency (`ports.lifecycleLatency.rangeReport`: episodes, stuck rows,
 *      incidents; its settings read hits the cache the limits read just filled)
 *   1  Cloudflare cost snapshot rows and sync status, one D1 batch
 *      (`insights-installation-cloudflare.ts`, Insights slice CF)
 * 10 here, plus 3 in the REST route's session middleware: 13. `admin-health-cost.test.ts` counts
 * them. Each section is isolated: one that fails is null and named in `unavailable`, and the
 * others still render (`.claude/rules/53`).
 */
import {
  DEFAULT_INSTALLATION_HEALTH_RANGE,
  type InstallationHealthRange,
  type InstallationHealthResponse,
  type InstallationHealthSection,
  isInstallationHealthRange,
} from '@simple-agent-manager/shared';
import { log } from '@simple-agent-manager/worker-core';

import { OperationError } from './errors';
import { readCloudflareCost } from './insights-installation-cloudflare';
import { type HealthWindowBounds, readComputeSpend } from './insights-installation-compute';
import { readMachineDensity, readPlacementSections } from './insights-installation-placements';
import {
  INSIGHTS_INSTALLATION_SETTINGS,
  type InsightsInstallationSettingName,
} from './insights-installation-settings-definition';
import type { OperationContext } from './types';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

export interface InstallationHealthInput {
  range?: unknown;
}

type HealthLimits = Record<InsightsInstallationSettingName, number>;

/** Monday 00:00 UTC of the week containing `ms`. */
export function utcWeekStart(ms: number): number {
  const date = new Date(ms);
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  return midnight - daysSinceMonday * DAY_MS;
}

export function installationHealthBounds(
  range: InstallationHealthRange,
  nowMs: number,
  spendWeeks: number
): HealthWindowBounds {
  const now = new Date(nowMs);
  const rangeStartMs =
    range === 'month'
      ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
      : nowMs - (range === '7d' ? 7 : 30) * DAY_MS;
  const weeks = Math.max(1, Math.floor(spendWeeks));
  const currentWeek = utcWeekStart(nowMs);
  const weekStarts = Array.from(
    { length: weeks },
    (_, index) => currentWeek - (weeks - 1 - index) * WEEK_MS
  );
  const weeksStartMs = weekStarts[0] ?? currentWeek;
  return {
    rangeStartMs,
    weeksStartMs,
    readStartMs: Math.min(rangeStartMs, weeksStartMs),
    nowMs,
    weekStarts,
  };
}

async function requireSuperadmin(ctx: OperationContext): Promise<void> {
  const row = await ctx.env.DATABASE.prepare(
    `SELECT 1 AS ok FROM users WHERE id = ? AND role = 'superadmin' AND status = 'active'`
  )
    .bind(ctx.actor.userId)
    .first<{ ok: number }>();
  if (!row) {
    log.warn('insights_installation.forbidden', { userId: ctx.actor.userId, action: 'rejected' });
    throw new OperationError('forbidden', 'Superadmin access required');
  }
}

/** Each value falls back to its code default when settings storage cannot be read. */
async function healthLimits(ctx: OperationContext): Promise<HealthLimits> {
  const names = INSIGHTS_INSTALLATION_SETTINGS.map((setting) => setting.name);
  let values: unknown[];
  try {
    values = (await ctx.ports.settings.resolveDetailsMany(names)).map((row) => row.value);
  } catch {
    values = INSIGHTS_INSTALLATION_SETTINGS.map((setting) => setting.defaultValue);
  }
  return Object.fromEntries(
    INSIGHTS_INSTALLATION_SETTINGS.map((setting, index) => {
      const value = values[index];
      return [
        setting.name,
        typeof value === 'number' && Number.isInteger(value) && value > 0
          ? value
          : setting.defaultValue,
      ];
    })
  ) as HealthLimits;
}

async function section<T>(
  name: InstallationHealthSection,
  read: () => Promise<T>,
  unavailable: InstallationHealthSection[]
): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    log.error('insights_installation.section_failed', {
      section: name,
      error: error instanceof Error ? error.message : String(error),
      action: 'section_unavailable',
    });
    unavailable.push(name);
    return null;
  }
}

export async function installationHealth(
  ctx: OperationContext,
  input: InstallationHealthInput,
  nowMs: number = Date.now()
): Promise<InstallationHealthResponse> {
  if (input.range !== undefined && !isInstallationHealthRange(input.range)) {
    throw new OperationError('invalid_input', 'range must be one of 7d, 30d, month');
  }
  const range: InstallationHealthRange = input.range ?? DEFAULT_INSTALLATION_HEALTH_RANGE;
  await requireSuperadmin(ctx);
  const limits = await healthLimits(ctx);
  const bounds = installationHealthBounds(range, nowMs, limits['insights.healthSpendWeeks']);

  const unavailable: InstallationHealthSection[] = [];
  const [compute, placements, density, latency, cloudflare] = await Promise.all([
    section(
      'compute',
      () => readComputeSpend(ctx, bounds, limits['insights.healthMaxNodes']),
      unavailable
    ),
    readPlacementSections(
      ctx,
      bounds,
      limits['insights.healthMaxPlacements'],
      limits['insights.healthMaxReasons']
    ).catch((error) => {
      log.error('insights_installation.section_failed', {
        section: 'reuse',
        error: error instanceof Error ? error.message : String(error),
        action: 'section_unavailable',
      });
      unavailable.push('reuse', 'newMachines');
      return null;
    }),
    section(
      'density',
      () => readMachineDensity(ctx, bounds, limits['insights.healthMaxRuns']),
      unavailable
    ),
    section(
      'latency',
      () =>
        ctx.ports.lifecycleLatency.rangeReport({ sinceMs: bounds.rangeStartMs, untilMs: nowMs }),
      unavailable
    ),
    section(
      'cloudflare',
      () =>
        readCloudflareCost(ctx, nowMs, {
          seriesDays: limits['insights.healthCloudflareSeriesDays'],
          topLines: limits['insights.healthCloudflareTopLines'],
          projectionDays: limits['insights.healthCloudflareProjectionDays'],
        }),
      unavailable
    ),
  ]);

  return {
    window: {
      range,
      start: new Date(bounds.rangeStartMs).toISOString(),
      end: new Date(nowMs).toISOString(),
    },
    generatedAt: new Date(nowMs).toISOString(),
    compute,
    reuse: placements?.reuse ?? null,
    density,
    newMachines: placements?.newMachines ?? null,
    latency,
    cloudflare,
    unavailable,
  };
}
