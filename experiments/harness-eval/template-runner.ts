/**
 * Template-aware eval runner.
 *
 * Extends the base runner to support prompt template variants.
 * Runs each scenario x model x template combination, tagging traces
 * with the template name for comparison analysis.
 */

import type { EvalScenario, ScenarioResult, ScenarioRun } from './types.js';
import type { ModelConfig } from './types.js';
import type { PromptTemplate } from './templates.js';
import { runScenario } from './runner.js';
import { computeCost } from './cost.js';

export interface TemplateRunResult extends ScenarioResult {
  /** Which prompt template was used */
  templateId: string;
}

export interface TemplateEvalTrace {
  version: '1.1';
  timestamp: string;
  suite: { commitHash: string; schemaVersion: string };
  templates: string[];
  results: TemplateRunResult[];
  matrix: MatrixEntry[];
}

export interface MatrixEntry {
  templateId: string;
  model: string;
  provider: string;
  totalRuns: number;
  passed: number;
  successRate: number;
  totalCostUsd: number;
  costPerSuccessUsd: number;
  avgLatencyMs: number;
  totalTokens: number;
}

/**
 * Run a single scenario with a template-overridden system prompt.
 */
export async function runWithTemplate(
  scenario: EvalScenario,
  model: ModelConfig,
  template: PromptTemplate,
  env: { accountId: string; gatewayId: string; authToken: string },
): Promise<TemplateRunResult> {
  // Override the scenario's system prompt with the template
  const overriddenScenario: EvalScenario = {
    ...scenario,
    systemPrompt: template.content,
  };

  const run = await runScenario(overriddenScenario, model, env);
  const rubric = scenario.evaluate(run);
  const costUsd = computeCost(model, run.totalUsage);

  return {
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

/**
 * Build the comparison matrix from template run results.
 */
export function buildMatrix(results: TemplateRunResult[]): MatrixEntry[] {
  const groups = new Map<string, TemplateRunResult[]>();

  for (const r of results) {
    const key = `${r.templateId}::${r.model.modelId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  const entries: MatrixEntry[] = [];
  for (const [, runs] of groups) {
    const first = runs[0];
    const passed = runs.filter((r) => r.rubric.pass).length;
    const totalCost = runs.reduce((s, r) => s + r.costUsd, 0);
    const totalTokens = runs.reduce((s, r) => s + r.usage.total_tokens, 0);
    entries.push({
      templateId: first.templateId,
      model: first.model.displayName,
      provider: first.model.provider,
      totalRuns: runs.length,
      passed,
      successRate: runs.length > 0 ? passed / runs.length : 0,
      totalCostUsd: totalCost,
      costPerSuccessUsd: passed > 0 ? totalCost / passed : Infinity,
      avgLatencyMs: runs.length > 0 ? runs.reduce((s, r) => s + r.latencyMs, 0) / runs.length : 0,
      totalTokens,
    });
  }

  return entries.sort((a, b) => a.templateId.localeCompare(b.templateId) || a.model.localeCompare(b.model));
}

/**
 * Print the template x model comparison matrix.
 */
export function printMatrix(matrix: MatrixEntry[]): void {
  console.log('\n========================================');
  console.log('  TEMPLATE x MODEL MATRIX');
  console.log('========================================\n');

  // Group by template
  const byTemplate = new Map<string, MatrixEntry[]>();
  for (const entry of matrix) {
    if (!byTemplate.has(entry.templateId)) byTemplate.set(entry.templateId, []);
    byTemplate.get(entry.templateId)!.push(entry);
  }

  for (const [templateId, entries] of byTemplate) {
    console.log(`Template: ${templateId}`);
    console.log('  ' + '-'.repeat(70));
    for (const e of entries) {
      const rate = (e.successRate * 100).toFixed(0);
      const cost = e.costPerSuccessUsd === Infinity ? 'N/A' : `$${e.costPerSuccessUsd.toFixed(6)}`;
      console.log(
        `  ${e.model.padEnd(20)} ${e.passed}/${e.totalRuns} (${rate}%)  cost/success: ${cost}  tokens: ${e.totalTokens}`,
      );
    }
    console.log('');
  }
}
