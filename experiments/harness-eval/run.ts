#!/usr/bin/env npx tsx
/**
 * Main entry point for the harness eval suite.
 *
 * Runs all scenarios against all configured models through SAM's AI Gateway,
 * collects results, computes cost-per-success, and persists a JSON trace.
 *
 * Usage:
 *   CF_ACCOUNT_ID=... CF_TOKEN=... npx tsx experiments/harness-eval/run.ts
 *
 * Optional env vars:
 *   AI_GATEWAY_ID       — Gateway ID (default: "sam")
 *   WORKERS_AI_COST_PER_1K — Override Workers AI cost estimate (default: 0.000011)
 *   EVAL_SCENARIOS      — Comma-separated scenario IDs to run (default: all)
 *   EVAL_MODELS         — Comma-separated model IDs to run (default: all)
 */

import { ALL_SCENARIOS } from './scenarios/index.js';
import { getEvalModels } from './models.js';
import { runScenario } from './runner.js';
import { computeCost } from './cost.js';
import { buildTrace, writeTrace, printSummary } from './trace.js';
import type { ScenarioResult, ScenarioRun } from './types.js';

function buildScenarioResult(
  scenarioId: string,
  scenarioName: string,
  category: string,
  model: ScenarioResult['model'],
  run: ScenarioRun,
  rubric: ScenarioResult['rubric'],
  costUsd: number,
): ScenarioResult {
  return {
    scenarioId,
    scenarioName,
    category,
    model: {
      displayName: model.displayName,
      modelId: model.modelId,
      provider: model.provider,
      path: model.path,
    },
    rubric,
    usage: run.totalUsage,
    costUsd,
    latencyMs: run.totalLatencyMs,
    turnsUsed: run.turnsUsed,
    stopReason: run.stopReason,
    conversation: run.messages,
    toolCalls: run.toolCalls,
    turnUsage: run.turnUsage,
    turnLatency: run.turnLatency,
    error: run.error,
  };
}

async function main() {
  const accountId = process.env.CF_ACCOUNT_ID;
  const authToken = process.env.CF_TOKEN;
  const gatewayId = process.env.AI_GATEWAY_ID ?? 'sam';

  if (!accountId || !authToken) {
    console.error('ERROR: Missing required environment variables.');
    console.error('  CF_ACCOUNT_ID — Cloudflare account ID');
    console.error('  CF_TOKEN      — Cloudflare API token with AI Gateway access');
    console.error('');
    console.error('Usage:');
    console.error('  CF_ACCOUNT_ID=... CF_TOKEN=... npx tsx experiments/harness-eval/run.ts');
    process.exit(1);
  }

  const scenarioFilter = process.env.EVAL_SCENARIOS?.split(',').map((s) => s.trim());
  const modelFilter = process.env.EVAL_MODELS?.split(',').map((s) => s.trim());

  const scenarios = scenarioFilter
    ? ALL_SCENARIOS.filter((s) => scenarioFilter.includes(s.id))
    : ALL_SCENARIOS;

  const allModels = getEvalModels();
  const models = modelFilter
    ? allModels.filter((m) => modelFilter.includes(m.modelId))
    : allModels;

  if (scenarios.length === 0) {
    console.error('ERROR: No scenarios matched the filter:', scenarioFilter);
    process.exit(1);
  }
  if (models.length === 0) {
    console.error('ERROR: No models matched the filter:', modelFilter);
    process.exit(1);
  }

  console.log(`Running ${scenarios.length} scenarios x ${models.length} models = ${scenarios.length * models.length} eval runs`);
  console.log(`Gateway: ${gatewayId} | Account: ${accountId.slice(0, 8)}...`);
  console.log('');

  const results: ScenarioResult[] = [];

  for (const scenario of scenarios) {
    for (const model of models) {
      const label = `[${scenario.id}] x [${model.modelId}]`;
      process.stdout.write(`  ${label} ... `);

      try {
        const run = await runScenario(scenario, model, { accountId, gatewayId, authToken });
        const rubric = scenario.evaluate(run);
        const costUsd = computeCost(model, run.totalUsage);

        results.push(buildScenarioResult(scenario.id, scenario.name, scenario.category, model, run, rubric, costUsd));

        const status = run.stopReason === 'error'
          ? `ERROR: ${run.error?.slice(0, 80)}`
          : rubric.pass
            ? `PASS ($${costUsd.toFixed(6)}, ${run.totalLatencyMs}ms)`
            : `FAIL: ${rubric.reason.slice(0, 80)}`;

        console.log(status);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.log(`CRASH: ${errMsg}`);

        const emptyRun: ScenarioRun = {
          scenarioId: scenario.id,
          model,
          messages: [],
          toolCalls: [],
          totalUsage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          turnUsage: [],
          totalLatencyMs: 0,
          turnLatency: [],
          stopReason: 'error',
          turnsUsed: 0,
          error: errMsg,
        };

        results.push(buildScenarioResult(
          scenario.id, scenario.name, scenario.category, model, emptyRun,
          { pass: false, reason: `Runner crash: ${errMsg}` },
          0,
        ));
      }
    }
  }

  const trace = buildTrace(results);
  const tracePath = writeTrace(trace);
  console.log(`\nTrace written to: ${tracePath}`);

  printSummary(trace.summary);

  const anyZeroPasses = trace.summary.perModel.some((m) => m.passed === 0 && m.totalRuns > 0);
  if (anyZeroPasses) {
    console.log('WARNING: One or more models had zero passing scenarios.');
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
