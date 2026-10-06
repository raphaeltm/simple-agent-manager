import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as v from 'valibot';

interface AstroCheckBaseline {
  errors: number;
  metadata: {
    owner: string;
    backlog: string;
    review: string;
  };
}

const AstroCheckBaselineSchema = v.object({
  errors: v.number(),
  metadata: v.object({
    owner: v.string(),
    backlog: v.string(),
    review: v.string(),
  }),
});

export interface AstroCheckSummary {
  errors: number;
  hints: number;
  warnings: number;
}

const ANSI_PATTERN = new RegExp(String.raw`${String.fromCodePoint(27)}\[[0-9;]*m`, 'g');

export function parseAstroCheckSummary(output: string): AstroCheckSummary | undefined {
  const plain = output.replace(ANSI_PATTERN, '');
  const result = /Result \(\d+ files\):([\s\S]*)/.exec(plain)?.[1];
  if (!result) return undefined;
  const count = (label: string): number | undefined => {
    const value = new RegExp(String.raw`-\s+(\d+)\s+${label}`).exec(result)?.[1];
    return value === undefined ? undefined : Number(value);
  };
  const errors = count('errors');
  const warnings = count('warnings');
  const hints = count('hints');
  if (errors === undefined || warnings === undefined || hints === undefined) return undefined;
  return { errors, warnings, hints };
}

export function exceedsAstroErrorBaseline(summary: AstroCheckSummary, allowed: number): boolean {
  return summary.errors > allowed;
}

export function isCompleteAstroCheckResult(
  status: number | null,
  summary: AstroCheckSummary | undefined,
  executionError: unknown
): summary is AstroCheckSummary {
  return !executionError && (status === 0 || status === 1) && summary !== undefined;
}

export function parseAstroCheckBaseline(input: string): AstroCheckBaseline {
  return v.parse(AstroCheckBaselineSchema, JSON.parse(input) as unknown);
}

function run(): void {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const baseline = parseAstroCheckBaseline(
    readFileSync(resolve(repoRoot, 'scripts/quality/astro-check-baseline.json'), 'utf8')
  );
  const result = spawnSync(
    process.execPath,
    [resolve(repoRoot, 'apps/www/node_modules/astro/bin/astro.mjs'), 'check'],
    {
      cwd: resolve(repoRoot, 'apps/www'),
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 32 * 1024 * 1024,
    }
  );
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const summary = parseAstroCheckSummary(output);
  if (!isCompleteAstroCheckResult(result.status, summary, result.error)) {
    console.error('Astro template validation did not produce a complete diagnostic summary.');
    process.exit(1);
  }
  if (exceedsAstroErrorBaseline(summary, baseline.errors)) {
    console.error(output.replace(ANSI_PATTERN, ''));
    console.error(
      `Astro template errors increased from baseline ${baseline.errors} to ${summary.errors}.`
    );
    process.exit(1);
  }
  console.log(
    `Astro template validation: ${summary.errors} baseline error(s), ${summary.warnings} warning(s), ${summary.hints} hint(s).`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) run();
