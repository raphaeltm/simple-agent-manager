/**
 * Trace persistence — writes full eval traces to JSON files.
 *
 * Each run produces a timestamped JSON file in the traces/ directory
 * containing model config, prompts, tool schemas, full message logs,
 * tool call records, token usage, latency, cost, and pass/fail rubric.
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import type { EvalTrace, ScenarioResult, EvalSummary } from './types.js';
import { computeSummary } from './cost.js';

const TRACE_DIR = join(dirname(new URL(import.meta.url).pathname), 'traces');
const SCHEMA_VERSION = '1.0';

/**
 * Get the current git commit hash, or 'unknown' if unavailable.
 */
function getCommitHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Build a complete eval trace from scenario results.
 */
export function buildTrace(results: ScenarioResult[]): EvalTrace {
  const summary = computeSummary(results);
  return {
    version: '1.0',
    timestamp: new Date().toISOString(),
    suite: {
      commitHash: getCommitHash(),
      schemaVersion: SCHEMA_VERSION,
    },
    results,
    summary,
  };
}

/**
 * Write the trace to a timestamped JSON file in traces/.
 * Returns the file path.
 */
export function writeTrace(trace: EvalTrace): string {
  if (!existsSync(TRACE_DIR)) {
    mkdirSync(TRACE_DIR, { recursive: true });
  }

  const timestamp = trace.timestamp.replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const filename = `eval-${timestamp}.json`;
  const filepath = join(TRACE_DIR, filename);

  writeFileSync(filepath, JSON.stringify(trace, null, 2), 'utf-8');
  return filepath;
}

/**
 * Print a summary table to stdout.
 */
export function printSummary(summary: EvalSummary): void {
  console.log('\n========================================');
  console.log('  EVAL SUMMARY');
  console.log('========================================\n');

  for (const ms of summary.perModel) {
    const passRate = ms.totalRuns > 0 ? ((ms.passed / ms.totalRuns) * 100).toFixed(0) : '0';
    console.log(`Model: ${ms.model} (${ms.provider})`);
    console.log(`  Pass rate:           ${ms.passed}/${ms.totalRuns} (${passRate}%)`);
    console.log(`  Total cost:          $${ms.totalCostUsd.toFixed(6)}`);
    console.log(`  Cost/success:        ${ms.passed > 0 ? '$' + ms.costPerSuccessUsd.toFixed(6) : 'N/A (0 passes)'}`);
    console.log(`  Avg latency:         ${ms.avgLatencyMs.toFixed(0)}ms`);
    console.log(`  Total tokens:        ${ms.totalTokens}`);
    console.log('');
  }

  console.log(`Total scenarios: ${summary.totalScenarios}`);
  console.log(`Overall cost:    $${summary.totalCostUsd.toFixed(6)}`);
  console.log('');
}
