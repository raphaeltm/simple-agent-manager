/**
 * Read archive write-budget values from the `[vars]` table this repository actually SHIPS.
 *
 * Two test files need this (`write-budget-shipped-factor.test.ts` and
 * `sweep-message-budget-shipped.test.ts`) — for the budget vars and for the sweep cadence the
 * budget has to keep up with — and both exist for the same reason: a test that
 * pins a hand-copied constant stays green after someone edits `wrangler.toml`
 * (`.claude/rules/70`). Sharing one reader keeps the second file from drifting into a
 * different notion of "what ships" (`.claude/rules/24`).
 *
 * The parse is structural, the same way `scripts/deploy/sync-wrangler-config.ts` reads this
 * file, so a reflow or an inline comment cannot change what a test sees.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as TOML from '@iarna/toml';

const WRANGLER_PATH = resolve(import.meta.dirname, '../../wrangler.toml');

/** The trigger `scheduled/handler.ts` runs its sweep chain, archive sharding included, on. */
const SWEEP_CRON = '*/5 * * * *';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Minutes between sweep ticks, parsed from the trigger itself so the two cannot disagree. */
function sweepCronPeriodMs(): number {
  const stepMinutes = /^\*\/(\d+) \* \* \* \*$/.exec(SWEEP_CRON)?.[1];
  if (!stepMinutes) throw new Error(`Cannot derive a tick period from ${SWEEP_CRON}`);
  return Number(stepMinutes) * 60 * 1000;
}

function readShippedConfig(): { vars?: Record<string, unknown>; triggers?: { crons?: unknown } } {
  return TOML.parse(readFileSync(WRANGLER_PATH, 'utf-8')) as {
    vars?: Record<string, unknown>;
    triggers?: { crons?: unknown };
  };
}

export function readShippedVar(name: string): string {
  const value = readShippedConfig().vars?.[name];
  if (typeof value !== 'string') {
    throw new Error(`${name} is not a string in the [vars] table of apps/api/wrangler.toml`);
  }
  return value;
}

/**
 * Archive sweep ticks per UTC day at the shipped cadence — which is also the drain's
 * sessions-per-day ceiling, because the wall-time gate is checked only between candidates and
 * one real candidate outlasts it, so each tick archives one session.
 *
 * The cadence row falls due `interval` after the last claim, but only a cron tick can claim it,
 * so the effective period rounds UP to a whole number of cron periods. This is the jitter-free
 * period, and so an upper bound: the shipped interval sits short of a whole period so that the
 * jitter in when the archive step runs only rarely pushes a claim onto the following tick.
 */
export function shippedSweepTicksPerDay(): number {
  const crons = readShippedConfig().triggers?.crons;
  if (!Array.isArray(crons) || !crons.includes(SWEEP_CRON)) {
    throw new Error(
      `apps/api/wrangler.toml no longer ships the ${SWEEP_CRON} trigger the archive sweep runs on`
    );
  }
  const cronPeriodMs = sweepCronPeriodMs();
  const intervalMs = Number(readShippedVar('PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_INTERVAL_MS'));
  const periodMs = Math.ceil(intervalMs / cronPeriodMs) * cronPeriodMs;
  return Math.floor(DAY_MS / periodMs);
}

/** The env shape `archiveWriteBudgetConfig` reads, populated from the shipped config. */
export function shippedBudgetEnv() {
  return {
    PROJECT_DATA_ARCHIVE_DAILY_WRITE_BUDGET: readShippedVar(
      'PROJECT_DATA_ARCHIVE_DAILY_WRITE_BUDGET'
    ),
    PROJECT_DATA_ARCHIVE_WRITE_ESTIMATE_FACTOR: readShippedVar(
      'PROJECT_DATA_ARCHIVE_WRITE_ESTIMATE_FACTOR'
    ),
  };
}
