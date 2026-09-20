/**
 * Read archive write-budget values from the `[vars]` table this repository actually SHIPS.
 *
 * Two test files need this (`write-budget-shipped-factor.test.ts` and
 * `sweep-message-budget-shipped.test.ts`), and both exist for the same reason: a test that
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

export function readShippedVar(name: string): string {
  const parsed = TOML.parse(readFileSync(WRANGLER_PATH, 'utf-8')) as {
    vars?: Record<string, unknown>;
  };
  const value = parsed.vars?.[name];
  if (typeof value !== 'string') {
    throw new Error(`${name} is not a string in the [vars] table of apps/api/wrangler.toml`);
  }
  return value;
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
