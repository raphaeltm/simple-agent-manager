#!/usr/bin/env npx tsx
/**
 * Entry point for template-variant eval runs.
 *
 * Runs all scenarios x models x prompt templates through SAM's AI Gateway.
 * Produces a trace with template tags and a comparison matrix.
 *
 * Usage:
 *   CF_ACCOUNT_ID=... CF_TOKEN=... npx tsx experiments/harness-eval/run-templates.ts
 *
 * Optional env vars:
 *   AI_GATEWAY_ID       — Gateway ID (default: "sam")
 *   EVAL_SCENARIOS      — Comma-separated scenario IDs (default: all)
 *   EVAL_MODELS         — Comma-separated model IDs (default: all)
 *   EVAL_TEMPLATES      — Comma-separated template IDs (default: all)
 *   DRY_RUN             — Set to "true" to validate config without calling APIs
 */

import { ALL_SCENARIOS } from './scenarios/index.js';
import { getEvalModels } from './models.js';
import { getTemplates } from './templates.js';
import {
  runWithTemplate,
  buildMatrix,
  printMatrix,
  type TemplateRunResult,
  type TemplateEvalTrace,
} from './template-runner.js';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';

const TRACE_DIR = join(dirname(new URL(import.meta.url).pathname), 'traces');

function getCommitHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

async function main() {
  const accountId = process.env.CF_ACCOUNT_ID;
  const authToken = process.env.CF_TOKEN;
  const gatewayId = process.env.AI_GATEWAY_ID ?? 'sam';
  const dryRun = process.env.DRY_RUN === 'true';

  if (!dryRun && (!accountId || !authToken)) {
    console.error('ERROR: Missing required environment variables.');
    console.error('  CF_ACCOUNT_ID — Cloudflare account ID');
    console.error('  CF_TOKEN      — Cloudflare API token with AI Gateway access');
    console.error('');
    console.error('Set DRY_RUN=true to validate configuration without calling APIs.');
    process.exit(1);
  }

  const scenarioFilter = process.env.EVAL_SCENARIOS?.split(',').map((s) => s.trim());
  const modelFilter = process.env.EVAL_MODELS?.split(',').map((s) => s.trim());
  const templateFilter = process.env.EVAL_TEMPLATES?.split(',').map((s) => s.trim());

  const scenarios = scenarioFilter
    ? ALL_SCENARIOS.filter((s) => scenarioFilter.includes(s.id))
    : ALL_SCENARIOS;

  const allModels = getEvalModels();
  const models = modelFilter
    ? allModels.filter((m) => modelFilter.includes(m.modelId))
    : allModels;

  const templates = getTemplates(templateFilter);

  if (scenarios.length === 0) {
    console.error('ERROR: No scenarios matched the filter:', scenarioFilter);
    process.exit(1);
  }
  if (models.length === 0) {
    console.error('ERROR: No models matched the filter:', modelFilter);
    process.exit(1);
  }
  if (templates.length === 0) {
    console.error('ERROR: No templates matched the filter:', templateFilter);
    process.exit(1);
  }

  const totalRuns = scenarios.length * models.length * templates.length;
  console.log(`Running ${scenarios.length} scenarios x ${models.length} models x ${templates.length} templates = ${totalRuns} eval runs`);
  console.log(`Templates: ${templates.map((t) => t.id).join(', ')}`);
  console.log(`Gateway: ${gatewayId} | Account: ${(accountId ?? 'dry-run').slice(0, 8)}...`);
  console.log('');

  if (dryRun) {
    console.log('DRY RUN — configuration validated. Would run:');
    for (const template of templates) {
      for (const scenario of scenarios) {
        for (const model of models) {
          console.log(`  [${template.id}] x [${scenario.id}] x [${model.modelId}]`);
        }
      }
    }
    console.log(`\nTotal: ${totalRuns} runs`);
    process.exit(0);
  }

  const results: TemplateRunResult[] = [];

  for (const template of templates) {
    console.log(`--- Template: ${template.id} ---`);
    for (const scenario of scenarios) {
      for (const model of models) {
        const label = `  [${template.id}] x [${scenario.id}] x [${model.modelId}]`;
        process.stdout.write(`${label} ... `);

        try {
          const result = await runWithTemplate(
            scenario,
            model,
            template,
            { accountId: accountId!, gatewayId, authToken: authToken! },
          );
          results.push(result);

          const status = result.stopReason === 'error'
            ? `ERROR: ${result.error?.slice(0, 80)}`
            : result.rubric.pass
              ? `PASS ($${result.costUsd.toFixed(6)}, ${result.latencyMs}ms)`
              : `FAIL: ${result.rubric.reason.slice(0, 80)}`;

          console.log(status);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.log(`CRASH: ${errMsg}`);

          results.push({
            scenarioId: scenario.id,
            scenarioName: scenario.name,
            category: scenario.category,
            templateId: template.id,
            model: {
              displayName: model.displayName,
              modelId: model.modelId,
              provider: model.provider,
              path: model.path,
            },
            rubric: { pass: false, reason: `Runner crash: ${errMsg}` },
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            costUsd: 0,
            latencyMs: 0,
            turnsUsed: 0,
            stopReason: 'error',
            conversation: [],
            toolCalls: [],
            turnUsage: [],
            turnLatency: [],
            error: errMsg,
          });
        }
      }
    }
    console.log('');
  }

  // Build and print matrix
  const matrix = buildMatrix(results);
  printMatrix(matrix);

  // Write trace
  const trace: TemplateEvalTrace = {
    version: '1.1',
    timestamp: new Date().toISOString(),
    suite: {
      commitHash: getCommitHash(),
      schemaVersion: '1.1',
    },
    templates: templates.map((t) => t.id),
    results,
    matrix,
  };

  if (!existsSync(TRACE_DIR)) {
    mkdirSync(TRACE_DIR, { recursive: true });
  }

  const timestamp = trace.timestamp.replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const filename = `template-eval-${timestamp}.json`;
  const filepath = join(TRACE_DIR, filename);
  writeFileSync(filepath, JSON.stringify(trace, null, 2), 'utf-8');
  console.log(`\nTrace written to: ${filepath}`);

  // Summary stats
  const totalCost = results.reduce((s, r) => s + r.costUsd, 0);
  const totalPassed = results.filter((r) => r.rubric.pass).length;
  console.log(`\nOverall: ${totalPassed}/${results.length} passed, total cost: $${totalCost.toFixed(6)}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
